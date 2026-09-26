import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Registry, type Counter, type Gauge, type Histogram } from './metrics.js';

/**
 * Every metric core-api exports. Labels are bounded by construction: route
 * templates (not paths), status classes, topics, operations and outcomes from
 * fixed sets. Nothing here carries a tenant, user, vendor or invoice id.
 * infra/observability/ alerts and dashboards may only use names listed here
 * (checked by test/observability.test.ts).
 */

export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90] as const;
export const WORK_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120] as const;

export const OUTBOX_OUTCOMES = ['processed', 'retried', 'dead'] as const;
export const AI_OUTCOMES = ['ok', 'unavailable', 'rejected'] as const;

export interface CoreMetrics {
  readonly registry: Registry;
  readonly httpRequests: Counter;
  readonly httpDuration: Histogram;
  readonly httpInFlight: Gauge;
  readonly rateLimited: Counter;
  readonly outboxEvents: Counter;
  readonly outboxHandlerDuration: Histogram;
  readonly outboxPending: Gauge;
  readonly outboxDead: Gauge;
  readonly outboxOldestPendingAge: Gauge;
  readonly aiRequests: Counter;
  readonly aiDuration: Histogram;
  readonly invoiceTransitions: Counter;
  readonly paymentRunsClosed: Counter;
  readonly bankChangesRequested: Counter;
  readonly readinessChecks: Counter;
  readonly buildInfo: Gauge;
  readonly processStart: Gauge;
  readonly processMemory: Gauge;
  readonly heapUsed: Gauge;
  readonly eventLoopDelayP99: Gauge;
  readonly dbPool: Gauge;
}

export interface BuildInfo {
  readonly version: string;
  readonly commit: string;
}

export function createCoreMetrics(build: BuildInfo = { version: 'dev', commit: 'unknown' }, registry = new Registry()): CoreMetrics {
  const m: CoreMetrics = {
    registry,
    httpRequests: registry.counter('invoiceiq_http_requests_total', 'HTTP requests served, by route template and status class.', ['method', 'route', 'status']),
    httpDuration: registry.histogram('invoiceiq_http_request_duration_seconds', 'HTTP request latency by route template.', ['method', 'route'], HTTP_BUCKETS),
    httpInFlight: registry.gauge('invoiceiq_http_requests_in_flight', 'HTTP requests being handled right now.'),
    rateLimited: registry.counter('invoiceiq_http_rate_limited_total', 'Requests refused with 429, by bucket.', ['bucket']),
    outboxEvents: registry.counter('invoiceiq_outbox_events_total', 'Outbox events handled, by topic and outcome (processed, retried, dead).', ['topic', 'outcome']),
    outboxHandlerDuration: registry.histogram('invoiceiq_outbox_handler_duration_seconds', 'Time to handle one outbox event, by topic.', ['topic'], WORK_BUCKETS),
    outboxPending: registry.gauge('invoiceiq_outbox_pending', 'Outbox events waiting to be processed, across tenants.'),
    outboxDead: registry.gauge('invoiceiq_outbox_dead', 'Outbox events that exhausted their retries, across tenants.'),
    outboxOldestPendingAge: registry.gauge('invoiceiq_outbox_oldest_pending_age_seconds', 'Age of the oldest pending outbox event (0 when none).'),
    aiRequests: registry.counter('invoiceiq_ai_requests_total', 'Calls to ai-service, by operation and outcome (ok, unavailable, rejected).', ['operation', 'outcome']),
    aiDuration: registry.histogram('invoiceiq_ai_request_duration_seconds', 'ai-service call latency, by operation.', ['operation'], WORK_BUCKETS),
    invoiceTransitions: registry.counter('invoiceiq_invoice_transitions_total', 'Committed invoice state changes, by target state.', ['to']),
    paymentRunsClosed: registry.counter('invoiceiq_payment_runs_closed_total', 'Payment runs confirmed as paid or cancelled.', ['status']),
    bankChangesRequested: registry.counter('invoiceiq_vendor_bank_changes_requested_total', 'Vendor bank-detail changes recorded (each starts a quarantine).'),
    readinessChecks: registry.counter('invoiceiq_readiness_checks_total', 'Readiness probes answered, by result.', ['result']),
    buildInfo: registry.gauge('invoiceiq_build_info', 'Always 1; labels name the running build.', ['version', 'commit']),
    processStart: registry.gauge('process_start_time_seconds', 'Start time of the process since the Unix epoch in seconds.'),
    processMemory: registry.gauge('process_resident_memory_bytes', 'Resident memory size in bytes.'),
    heapUsed: registry.gauge('nodejs_heap_used_bytes', 'V8 heap in use, in bytes.'),
    eventLoopDelayP99: registry.gauge('nodejs_eventloop_delay_p99_seconds', 'p99 event-loop delay since the previous scrape.'),
    dbPool: registry.gauge('invoiceiq_db_pool_connections', 'Postgres pool connections by state (total, idle, waiting).', ['state']),
  };
  m.buildInfo.set(1, { version: build.version, commit: build.commit });
  m.processStart.set(Math.round((Date.now() - performance.now()) / 1000));
  for (const outcome of OUTBOX_OUTCOMES) m.outboxEvents.inc({ topic: 'invoice.received', outcome }, 0);

  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  // The histogram keeps a timer alive otherwise; never hold the process open for metrics.
  (loop as unknown as { unref?: () => void }).unref?.();
  registry.addCollector(() => {
    const mem = process.memoryUsage();
    m.processMemory.set(mem.rss);
    m.heapUsed.set(mem.heapUsed);
    m.eventLoopDelayP99.set(loop.count > 0 ? loop.percentile(99) / 1e9 : 0);
    loop.reset();
  });
  return m;
}

/** The exported metric names, sorted: the vocabulary alerts and dashboards may use. */
export function metricNames(m: CoreMetrics): string[] {
  return m.registry.names();
}

/** Status class label: 2xx, 3xx, 4xx, 5xx. */
export function statusClass(status: number): string {
  if (status >= 100 && status < 600) return `${Math.floor(status / 100)}xx`;
  return 'other';
}
