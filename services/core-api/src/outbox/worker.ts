import { withTenant, withoutTenant, type Db } from '../db/pool.js';
import { currentTrace, runWithTrace, startSpan } from '../observability/trace.js';

/**
 * Wake-and-drain outbox relay (ADR-0003, ADR-0008).
 *
 * There is no always-on worker on a scale-to-zero host, so draining is driven
 * by the process that is awake anyway: core-api drains on boot, right after
 * each write that enqueues work (`kick`), and on a slow poll while it stays up.
 * A lease (`locked_until`) makes a crashed drain's claims reclaimable, and
 * failed events back off exponentially, which is also what absorbs an
 * ai-service cold start.
 */

export interface OutboxEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  /** The trace of the request that enqueued it, so its work joins that trace. */
  readonly traceparent?: string | null;
}

export type OutboxOutcome = 'processed' | 'retried' | 'dead';

export type OutboxHandler = (event: OutboxEvent) => Promise<void>;

export interface WorkerLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface OutboxWorkerOptions {
  readonly handlers: Readonly<Record<string, OutboxHandler>>;
  /** Called once when an event exhausts its attempts. */
  readonly onDead?: OutboxHandler;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly maxAttempts?: number;
  readonly pollMs?: number;
  readonly backoff?: (attempts: number) => number;
  readonly log?: WorkerLogger;
  /** Told about every handled event after its outcome is committed (metrics). */
  readonly observe?: (event: OutboxEvent, outcome: OutboxOutcome, seconds: number) => void;
}

const silent: WorkerLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** 2s, 4s, 8s ... capped at 5 minutes. */
export function defaultBackoff(attempts: number): number {
  return Math.min(2 ** attempts, 300);
}

export class OutboxWorker {
  private readonly batchSize: number;
  private readonly leaseSeconds: number;
  private readonly maxAttempts: number;
  private readonly pollMs: number;
  private readonly backoff: (attempts: number) => number;
  private readonly log: WorkerLogger;
  private draining: Promise<number> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly opts: OutboxWorkerOptions,
  ) {
    this.batchSize = opts.batchSize ?? 10;
    this.leaseSeconds = opts.leaseSeconds ?? 120;
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.pollMs = opts.pollMs ?? 5_000;
    this.backoff = opts.backoff ?? defaultBackoff;
    this.log = opts.log ?? silent;
  }

  /** Claim and process one batch. Returns how many events were claimed. */
  async drainOnce(): Promise<number> {
    const claimed = await withoutTenant(this.db, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        tenant_id: string;
        event_id: string;
        topic: string;
        payload: Record<string, unknown>;
        attempts: number;
        traceparent: string | null;
      }>('SELECT * FROM claim_outbox($1, $2)', [this.batchSize, this.leaseSeconds]);
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        eventId: r.event_id,
        topic: r.topic,
        payload: r.payload,
        attempts: r.attempts,
        traceparent: r.traceparent,
      }));
    });
    for (const event of claimed) {
      const span = startSpan(event.traceparent);
      await runWithTrace(span, () => this.process(event));
    }
    return claimed.length;
  }

  private async process(event: OutboxEvent): Promise<void> {
    const handler = this.opts.handlers[event.topic];
    const started = performance.now();
    const observe = (outcome: OutboxOutcome) => this.opts.observe?.(event, outcome, (performance.now() - started) / 1000);
    try {
      if (handler) await handler(event);
      await withTenant(this.db, event.tenantId, (tx) =>
        tx.query('UPDATE outbox SET processed_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1', [event.id]),
      );
      observe('processed');
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const dead = event.attempts >= this.maxAttempts;
      await withTenant(this.db, event.tenantId, (tx) =>
        dead
          ? tx.query('UPDATE outbox SET dead_at = now(), locked_until = NULL, last_error = $2 WHERE id = $1', [event.id, message])
          : tx.query(
              `UPDATE outbox SET locked_until = NULL, last_error = $2,
                      available_at = now() + make_interval(secs => $3) WHERE id = $1`,
              [event.id, message, this.backoff(event.attempts)],
            ),
      );
      observe(dead ? 'dead' : 'retried');
      if (dead) {
        this.log.error({ eventId: event.eventId, topic: event.topic, attempts: event.attempts, err: message, traceId: currentTrace()?.traceId }, 'outbox event dead-lettered');
        await this.opts.onDead?.(event).catch((e: unknown) => this.log.error({ eventId: event.eventId, err: String(e) }, 'onDead failed'));
      } else {
        this.log.warn({ eventId: event.eventId, topic: event.topic, attempts: event.attempts, err: message, traceId: currentTrace()?.traceId }, 'outbox event failed; will retry');
      }
    }
  }

  /** Drain until nothing is claimable. Concurrent calls share one drain and trigger one more pass. */
  drain(): Promise<number> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    const run = async () => {
      let total = 0;
      do {
        this.again = false;
        let n: number;
        do {
          n = await this.drainOnce();
          total += n;
        } while (n > 0);
      } while (this.again);
      return total;
    };
    this.draining = run().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  /** Fire-and-forget drain after a write. Errors are logged, never thrown at the request. */
  kick(): void {
    this.drain().catch((err: unknown) => this.log.error({ err: String(err) }, 'outbox drain failed'));
  }

  start(): void {
    this.kick();
    this.timer = setInterval(() => this.kick(), this.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining?.catch(() => undefined);
  }
}
