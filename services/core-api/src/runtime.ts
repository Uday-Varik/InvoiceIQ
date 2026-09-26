import type { FastifyInstance } from 'fastify';
import { httpAiClient, type AiClient } from './clients/ai-service.js';
import { demoAuthenticator, oidcAuthenticator, remoteKeys, type Authenticator } from './auth/auth.js';
import { parseCheckpointKey, type Config } from './config.js';
import { checkpointSigner } from './audit/checkpoints.js';
import { bootstrapTenant, DEMO_TENANT_ID } from './db/bootstrap.js';
import { migrate } from './db/migrate.js';
import { createPool, type Db } from './db/pool.js';
import { buildApp, DEMO_PRINCIPAL } from './http/app.js';
import { holdForManualReview, processReceived } from './invoices/pipeline.js';
import { OutboxWorker, type OutboxEvent, type OutboxOutcome, type WorkerLogger } from './outbox/worker.js';
import { setAppRolePassword } from './db/app-role.js';
import { createCoreMetrics, type CoreMetrics } from './observability/catalog.js';
import { RateLimiter } from './observability/rate-limit.js';

export function authenticatorFor(config: Config): Authenticator {
  if (config.AUTH_MODE === 'demo') return demoAuthenticator(DEMO_PRINCIPAL);
  return oidcAuthenticator({
    issuer: config.OIDC_ISSUER as string,
    audience: config.OIDC_AUDIENCE as string,
    keys: remoteKeys(config.OIDC_JWKS_URL as string),
    tenantClaim: config.OIDC_TENANT_CLAIM,
    rolesClaim: config.OIDC_ROLES_CLAIM,
  });
}

/**
 * Metrics for a handled outbox event. Domain counters (transitions, payment
 * runs, bank changes) count here, after commit, so a rolled-back request never
 * inflates them.
 */
export function observeOutbox(metrics: CoreMetrics) {
  return (event: OutboxEvent, outcome: OutboxOutcome, seconds: number): void => {
    metrics.outboxEvents.inc({ topic: event.topic, outcome });
    metrics.outboxHandlerDuration.observe(seconds, { topic: event.topic });
    if (outcome !== 'processed') return;
    const p = event.payload;
    if (event.topic === 'invoice.state_changed' && typeof p['to'] === 'string') metrics.invoiceTransitions.inc({ to: p['to'] });
    if (event.topic === 'payment_run.closed' && typeof p['status'] === 'string') metrics.paymentRunsClosed.inc({ status: p['status'] });
    if (event.topic === 'vendor.bank_change_requested') metrics.bankChangesRequested.inc();
  };
}

/** Refresh the queue gauges from Postgres on each scrape. */
export function outboxCollector(db: Db, metrics: CoreMetrics) {
  return async (): Promise<void> => {
    const { rows } = await db.query<{ pending: string; dead: string; oldest_pending_age_seconds: number }>('SELECT * FROM outbox_stats()');
    const r = rows[0];
    if (!r) return;
    metrics.outboxPending.set(Number(r.pending));
    metrics.outboxDead.set(Number(r.dead));
    metrics.outboxOldestPendingAge.set(r.oldest_pending_age_seconds);
    metrics.dbPool.set(db.totalCount, { state: 'total' });
    metrics.dbPool.set(db.idleCount, { state: 'idle' });
    metrics.dbPool.set(db.waitingCount, { state: 'waiting' });
  };
}

export function createWorker(
  db: Db,
  ai: AiClient,
  opts: { pollMs?: number; maxAttempts?: number; log?: WorkerLogger; metrics?: CoreMetrics } = {},
): OutboxWorker {
  const { metrics, ...rest } = opts;
  return new OutboxWorker(db, {
    handlers: {
      'invoice.received': (e) => processReceived({ db, ai }, e.tenantId, String(e.payload['invoiceId'])),
      // No external subscriber yet; consuming marks the event delivered.
      'invoice.state_changed': () => Promise.resolve(),
      'invoice.corrected': () => Promise.resolve(),
      'vendor.bank_change_requested': () => Promise.resolve(),
      'payment_run.created': () => Promise.resolve(),
      'payment_run.closed': () => Promise.resolve(),
    },
    onDead: async (e) => {
      if (e.topic === 'invoice.received') {
        await holdForManualReview(db, e.tenantId, String(e.payload['invoiceId']), 'extraction_unavailable', 'ai-service did not answer within the retry budget');
      }
    },
    ...(metrics ? { observe: observeOutbox(metrics) } : {}),
    ...rest,
  });
}

export interface Runtime {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly worker: OutboxWorker;
  close(): Promise<void>;
}

/** Wire the process: migrate, bootstrap the demo tenant if asked, build the app, start the drain. */
export async function startRuntime(config: Config): Promise<Runtime> {
  const metrics = createCoreMetrics({ version: config.BUILD_VERSION, commit: (config.BUILD_COMMIT ?? config.RENDER_GIT_COMMIT ?? 'unknown').slice(0, 12) });
  const ai = httpAiClient({
    baseUrl: config.AI_SERVICE_URL,
    signingSecret: config.AI_SIGNING_SECRET,
    timeoutMs: config.AI_TIMEOUT_MS,
    observe: (operation, outcome, seconds) => {
      metrics.aiRequests.inc({ operation, outcome });
      metrics.aiDuration.observe(seconds, { operation });
    },
  });
  // ai-service scales to zero too. Start waking it now, in parallel with our own boot.
  void ai.wake();

  if (config.MIGRATION_DATABASE_URL) {
    await migrate(config.MIGRATION_DATABASE_URL);
    if (config.APP_DB_PASSWORD) await setAppRolePassword(config.MIGRATION_DATABASE_URL, config.APP_DB_PASSWORD);
    if (config.AUTH_MODE === 'demo') {
      await bootstrapTenant(config.MIGRATION_DATABASE_URL, { id: DEMO_TENANT_ID, name: config.DEMO_TENANT_NAME });
    }
  }

  const db = createPool(config.DATABASE_URL);
  const key = config.AUDIT_CHECKPOINT_KEY ? parseCheckpointKey(config.AUDIT_CHECKPOINT_KEY) : undefined;
  const signer = checkpointSigner(key);
  const production = config.NODE_ENV === 'production';
  const app = buildApp({
    logger: true,
    logLevel: config.LOG_LEVEL,
    trustProxy: config.TRUST_PROXY_HOPS,
    metrics,
    ...(config.METRICS_TOKEN ? { metricsToken: config.METRICS_TOKEN } : {}),
    production,
    rateLimiter: new RateLimiter({
      writes: { perMinute: config.RATE_LIMIT_WRITES_PER_MINUTE },
      uploads: { perMinute: config.RATE_LIMIT_UPLOADS_PER_MINUTE },
    }),
    aiPing: () => (ai.ping ? ai.ping() : Promise.resolve(false)),
    auth: authenticatorFor(config),
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    checkpointSigner: signer,
    deps: { db, worker: { kick: () => worker.kick() } },
  });
  if (signer.ephemeral) app.log.warn({ keyId: signer.keyId }, 'AUDIT_CHECKPOINT_KEY is not set; audit checkpoints are signed with a key that changes on every restart');
  if (production && !config.METRICS_TOKEN) app.log.warn('METRICS_TOKEN is not set; /metrics is disabled');
  metrics.registry.addCollector(outboxCollector(db, metrics));
  const worker = createWorker(db, ai, { pollMs: config.OUTBOX_POLL_MS, maxAttempts: config.OUTBOX_MAX_ATTEMPTS, log: app.log, metrics });
  worker.start();

  return {
    app,
    db,
    worker,
    async close() {
      await app.close();
      await worker.stop();
      await db.end();
    },
  };
}
