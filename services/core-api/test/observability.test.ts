import { describe, expect, it, vi } from 'vitest';
import { AiRejectedError, AiUnavailableError, httpAiClient, type AiOperation, type AiOutcome } from '../src/clients/ai-service.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { createCoreMetrics, statusClass } from '../src/observability/catalog.js';
import { HSTS, SECURITY_HEADERS, bearerMatches } from '../src/observability/http.js';
import {
  Counter,
  DEFAULT_BUCKETS,
  Gauge,
  Histogram,
  MAX_SERIES_PER_METRIC,
  PROMETHEUS_CONTENT_TYPE,
  Registry,
  escapeHelp,
  escapeLabelValue,
  formatValue,
} from '../src/observability/metrics.js';
import { RateLimiter, bucketFor } from '../src/observability/rate-limit.js';
import { checkReadiness } from '../src/observability/readiness.js';
import {
  childSpan,
  currentTrace,
  formatTraceparent,
  newSpanId,
  newTraceId,
  outgoingTraceparent,
  parseTraceparent,
  runWithTrace,
  startSpan,
} from '../src/observability/trace.js';
import { observeOutbox } from '../src/runtime.js';
import type { OutboxEvent } from '../src/outbox/worker.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const HEADER = `00-${TRACE}-${PARENT}-01`;
const TOKEN = 'm'.repeat(40);

describe('metrics registry', () => {
  it('renders a counter with HELP, TYPE and labels', () => {
    const c = new Counter('x_total', 'Things.', ['kind']);
    c.inc({ kind: 'a' });
    c.inc({ kind: 'a' }, 2);
    expect(c.render()).toEqual(['# HELP x_total Things.', '# TYPE x_total counter', 'x_total{kind="a"} 3']);
  });

  it('renders an unlabelled counter without braces', () => {
    const c = new Counter('y_total', 'Y.');
    c.inc();
    expect(c.render().at(-1)).toBe('y_total 1');
  });

  it('refuses to count down or by a non-finite amount', () => {
    const c = new Counter('x_total', 'Things.');
    expect(() => c.inc(undefined, -1)).toThrow(/only go up/);
    expect(() => c.inc(undefined, Number.NaN)).toThrow(/only go up/);
    expect(() => c.inc(undefined, Infinity)).toThrow(/only go up/);
  });

  it('insists on exactly the declared labels', () => {
    const c = new Counter('x_total', 'Things.', ['a', 'b']);
    expect(() => c.inc({ a: '1' })).toThrow(/takes labels \[a, b\]/);
    expect(() => c.inc({ a: '1', c: '2' })).toThrow(/takes labels/);
    expect(() => c.inc()).toThrow(/takes labels/);
    c.inc({ b: '2', a: '1' });
    expect(c.get({ a: '1', b: '2' })).toBe(1);
  });

  it('caps the number of series so an id can never explode cardinality', () => {
    const c = new Counter('x_total', 'Things.', ['v']);
    for (let i = 0; i < MAX_SERIES_PER_METRIC; i++) c.inc({ v: String(i) });
    expect(c.size).toBe(MAX_SERIES_PER_METRIC);
    expect(() => c.inc({ v: 'one more' })).toThrow(/exceeded/);
    c.inc({ v: '0' });
    expect(c.get({ v: '0' })).toBe(2);
  });

  it.each(['1bad', 'has space', 'dash-ed', ''])('refuses the metric name %j', (name) => {
    expect(() => new Counter(name, 'x')).toThrow(/invalid metric name/);
  });

  it.each([['1a'], ['__reserved'], ['a-b']])('refuses the label name %j', (label) => {
    expect(() => new Counter('x_total', 'x', [label])).toThrow(/invalid label name/);
  });

  it('refuses duplicate label names', () => {
    expect(() => new Counter('x_total', 'x', ['a', 'a'])).toThrow(/duplicate/);
  });

  it('escapes label values and help text per the exposition format', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    expect(escapeHelp('line\\one\ntwo "quoted"')).toBe('line\\\\one\\ntwo "quoted"');
    const c = new Counter('x_total', 'Help\nwith newline.', ['v']);
    c.inc({ v: 'x"y' });
    expect(c.render()).toEqual(['# HELP x_total Help\\nwith newline.', '# TYPE x_total counter', 'x_total{v="x\\"y"} 1']);
  });

  it.each([
    [1, '1'],
    [0.25, '0.25'],
    [Number.NaN, 'NaN'],
    [Infinity, '+Inf'],
    [-Infinity, '-Inf'],
  ])('formats %s as %s', (n, s) => {
    expect(formatValue(n)).toBe(s);
  });

  it('sets, raises and lowers a gauge', () => {
    const g = new Gauge('g', 'A gauge.', ['state']);
    g.set(5, { state: 'idle' });
    g.inc({ state: 'idle' }, -2);
    expect(g.get({ state: 'idle' })).toBe(3);
    expect(g.render().at(-1)).toBe('g{state="idle"} 3');
  });

  it('keeps histogram buckets cumulative, with +Inf, sum and count', () => {
    const h = new Histogram('h_seconds', 'Latency.', ['route'], [0.1, 1]);
    for (const v of [0.05, 0.1, 0.5, 5]) h.observe(v, { route: '/x' });
    expect(h.render().slice(2)).toEqual([
      'h_seconds_bucket{route="/x",le="0.1"} 2',
      'h_seconds_bucket{route="/x",le="1"} 3',
      'h_seconds_bucket{route="/x",le="+Inf"} 4',
      'h_seconds_sum{route="/x"} 5.65',
      'h_seconds_count{route="/x"} 4',
    ]);
  });

  it('ignores non-finite observations', () => {
    const h = new Histogram('h', 'x', [], [1]);
    h.observe(Number.NaN);
    h.observe(Infinity);
    expect(h.snapshot()).toEqual({ buckets: [0], sum: 0, count: 0 });
  });

  it.each([[[]], [[1, 1]], [[2, 1]]])('refuses buckets %j', (buckets) => {
    expect(() => new Histogram('h', 'x', [], buckets)).toThrow(/bucket/);
  });

  it('reserves the le label', () => {
    expect(() => new Histogram('h', 'x', ['le'])).toThrow(/reserved/);
  });

  it('uses sensible default buckets', () => {
    expect(new Histogram('h', 'x').buckets).toEqual(DEFAULT_BUCKETS);
  });

  it('times async work whether it resolves or throws', async () => {
    const h = new Histogram('h', 'x', [], [1, 10]);
    let t = 0;
    const clock = () => t;
    await h.time(
      undefined,
      async () => {
        t = 500;
      },
      clock,
    );
    await expect(
      h.time(
        undefined,
        async () => {
          t = 3_000;
          throw new Error('boom');
        },
        clock,
      ),
    ).rejects.toThrow('boom');
    expect(h.snapshot()).toEqual({ buckets: [1, 2], sum: 3, count: 2 });
  });

  it('refuses to register a name twice', () => {
    const r = new Registry();
    r.counter('a_total', 'a');
    expect(() => r.gauge('a_total', 'again')).toThrow(/already registered/);
  });

  it('renders metrics sorted by name and ends with a newline', async () => {
    const r = new Registry();
    r.counter('b_total', 'b').inc();
    r.counter('a_total', 'a').inc();
    const text = await r.render();
    expect(text.indexOf('a_total')).toBeLessThan(text.indexOf('b_total'));
    expect(text.endsWith('\n')).toBe(true);
    expect(r.names()).toEqual(['a_total', 'b_total']);
  });

  it('runs collectors before rendering and survives a failing one', async () => {
    const r = new Registry();
    const g = r.gauge('g', 'g');
    const errors: unknown[] = [];
    r.addCollector(() => {
      throw new Error('db down');
    });
    r.addCollector(async () => {
      g.set(7);
    });
    const text = await r.render((e) => errors.push(e));
    expect(text).toContain('g 7');
    expect(errors).toHaveLength(1);
  });

  it('can be reset', () => {
    const c = new Counter('x_total', 'x');
    c.inc();
    c.reset();
    expect(c.size).toBe(0);
  });
});

describe('core-api metric catalog', () => {
  const m = createCoreMetrics({ version: '1.2.3', commit: 'abc123' });

  it('exports exactly these metrics', () => {
    expect(m.registry.names()).toEqual([
      'invoiceiq_ai_request_duration_seconds',
      'invoiceiq_ai_requests_total',
      'invoiceiq_build_info',
      'invoiceiq_db_pool_connections',
      'invoiceiq_http_rate_limited_total',
      'invoiceiq_http_request_duration_seconds',
      'invoiceiq_http_requests_in_flight',
      'invoiceiq_http_requests_total',
      'invoiceiq_invoice_transitions_total',
      'invoiceiq_outbox_dead',
      'invoiceiq_outbox_events_total',
      'invoiceiq_outbox_handler_duration_seconds',
      'invoiceiq_outbox_oldest_pending_age_seconds',
      'invoiceiq_outbox_pending',
      'invoiceiq_payment_runs_closed_total',
      'invoiceiq_readiness_checks_total',
      'invoiceiq_vendor_bank_changes_requested_total',
      'nodejs_eventloop_delay_p99_seconds',
      'nodejs_heap_used_bytes',
      'process_resident_memory_bytes',
      'process_start_time_seconds',
    ]);
  });

  it('labels build info with the version and commit', async () => {
    expect(await m.registry.render()).toContain('invoiceiq_build_info{version="1.2.3",commit="abc123"} 1');
  });

  it('pre-creates the extraction outcome series so rate() works from zero', async () => {
    const text = await m.registry.render();
    for (const outcome of ['processed', 'retried', 'dead']) {
      expect(text).toContain(`invoiceiq_outbox_events_total{topic="invoice.received",outcome="${outcome}"} 0`);
    }
  });

  it('fills process gauges on scrape', async () => {
    await m.registry.render();
    expect(m.processMemory.get()).toBeGreaterThan(0);
    expect(m.heapUsed.get()).toBeGreaterThan(0);
    expect(m.processStart.get()).toBeGreaterThan(1_600_000_000);
  });

  it('never declares an id-like label', () => {
    const forbidden = /tenant|user|invoice_?id|vendor_?id|run_?id|path|url/i;
    for (const name of m.registry.names()) {
      const metric = m.registry.get(name);
      for (const label of metric?.labelNames ?? []) expect(label, `${name}.${label}`).not.toMatch(forbidden);
    }
  });

  it.each([
    [200, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [503, '5xx'],
    [99, 'other'],
    [600, 'other'],
  ])('status %i is class %s', (status, cls) => {
    expect(statusClass(status)).toBe(cls);
  });
});

describe('outbox metrics (after commit)', () => {
  const event = (topic: string, payload: Record<string, unknown> = {}): OutboxEvent => ({
    id: '1',
    tenantId: 't',
    eventId: 'e',
    topic,
    payload,
    attempts: 1,
  });

  it('counts outcomes and handler time by topic', () => {
    const m = createCoreMetrics();
    const observe = observeOutbox(m);
    observe(event('invoice.received'), 'processed', 0.2);
    observe(event('invoice.received'), 'retried', 1.5);
    observe(event('invoice.received'), 'dead', 3);
    expect(m.outboxEvents.get({ topic: 'invoice.received', outcome: 'processed' })).toBe(1);
    expect(m.outboxEvents.get({ topic: 'invoice.received', outcome: 'retried' })).toBe(1);
    expect(m.outboxEvents.get({ topic: 'invoice.received', outcome: 'dead' })).toBe(1);
    expect(m.outboxHandlerDuration.snapshot({ topic: 'invoice.received' }).count).toBe(3);
  });

  it('turns committed domain events into business counters', () => {
    const m = createCoreMetrics();
    const observe = observeOutbox(m);
    observe(event('invoice.state_changed', { from: 'VALIDATING', to: 'HOLD' }), 'processed', 0);
    observe(event('invoice.state_changed', { from: 'HOLD', to: 'APPROVED' }), 'processed', 0);
    observe(event('payment_run.closed', { status: 'paid' }), 'processed', 0);
    observe(event('vendor.bank_change_requested', {}), 'processed', 0);
    expect(m.invoiceTransitions.get({ to: 'HOLD' })).toBe(1);
    expect(m.invoiceTransitions.get({ to: 'APPROVED' })).toBe(1);
    expect(m.paymentRunsClosed.get({ status: 'paid' })).toBe(1);
    expect(m.bankChangesRequested.get()).toBe(1);
  });

  it('does not count business events that failed to process', () => {
    const m = createCoreMetrics();
    observeOutbox(m)(event('invoice.state_changed', { to: 'PAID' }), 'retried', 0);
    expect(m.invoiceTransitions.size).toBe(0);
  });

  it('ignores a malformed payload rather than inventing a label', () => {
    const m = createCoreMetrics();
    observeOutbox(m)(event('invoice.state_changed', { to: 42 }), 'processed', 0);
    observeOutbox(m)(event('payment_run.closed', {}), 'processed', 0);
    expect(m.invoiceTransitions.size).toBe(0);
    expect(m.paymentRunsClosed.size).toBe(0);
  });
});

describe('trace context', () => {
  it('parses a valid traceparent', () => {
    expect(parseTraceparent(HEADER)).toEqual({ traceId: TRACE, spanId: PARENT, sampled: true });
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`)?.sampled).toBe(false);
    expect(parseTraceparent(`  00-${TRACE.toUpperCase()}-${PARENT}-01 `)?.traceId).toBe(TRACE);
  });

  it.each([
    ['undefined', undefined],
    ['an array', [HEADER, HEADER]],
    ['empty', ''],
    ['garbage', 'not-a-trace'],
    ['version ff', `ff-${TRACE}-${PARENT}-01`],
    ['a zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['a zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['v00 with trailing data', `${HEADER}-extra`],
    ['a short trace id', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['one-digit flags', `00-${TRACE}-${PARENT}-1`],
    ['an oversized header', HEADER + 'x'.repeat(600)],
    ['a future version glued to junk', `01-${TRACE}-${PARENT}-01x`],
  ])('ignores %s', (_label, header) => {
    expect(parseTraceparent(header as string | string[] | undefined)).toBeUndefined();
  });

  it('reads a future version by its first four fields', () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01-more`)).toEqual({ traceId: TRACE, spanId: PARENT, sampled: true });
  });

  it('round-trips through format', () => {
    const ctx = startSpan();
    expect(parseTraceparent(formatTraceparent(ctx))).toEqual({ traceId: ctx.traceId, spanId: ctx.spanId, sampled: true });
    expect(formatTraceparent({ ...ctx, sampled: false }).endsWith('-00')).toBe(true);
  });

  it('continues the caller trace with a new span', () => {
    const ctx = startSpan(HEADER);
    expect(ctx.traceId).toBe(TRACE);
    expect(ctx.parentSpanId).toBe(PARENT);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(ctx.spanId).not.toBe(PARENT);
  });

  it('starts a new trace when there is no usable header', () => {
    const a = startSpan(null);
    const b = startSpan('junk');
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.parentSpanId).toBeUndefined();
  });

  it('makes child spans in the same trace', () => {
    const root = startSpan();
    const child = childSpan(root);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
  });

  it('generates well-formed, non-zero ids', () => {
    for (let i = 0; i < 50; i++) {
      expect(newTraceId()).toMatch(/^(?!0{32})[0-9a-f]{32}$/);
      expect(newSpanId()).toMatch(/^(?!0{16})[0-9a-f]{16}$/);
    }
  });

  it('keeps the current trace across awaits and isolates concurrent work', async () => {
    const a = startSpan();
    const b = startSpan();
    const seen = await Promise.all([
      runWithTrace(a, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return currentTrace()?.traceId;
      }),
      runWithTrace(b, async () => currentTrace()?.traceId),
    ]);
    expect(seen).toEqual([a.traceId, b.traceId]);
    expect(currentTrace()).toBeUndefined();
  });

  it('gives outgoing calls a child of the current span, and nothing outside a trace', () => {
    expect(outgoingTraceparent()).toBeUndefined();
    const ctx = startSpan(HEADER);
    const out = runWithTrace(ctx, () => outgoingTraceparent());
    const parsed = parseTraceparent(out);
    expect(parsed?.traceId).toBe(TRACE);
    expect(parsed?.spanId).not.toBe(ctx.spanId);
  });
});

describe('rate limiter', () => {
  it('allows a burst up to the per-minute budget, then refuses with Retry-After', () => {
    const t = 0;
    const rl = new RateLimiter({ writes: { perMinute: 3 } }, () => t);
    expect([1, 2, 3].map(() => rl.take('writes', 'a').allowed)).toEqual([true, true, true]);
    const refused = rl.take('writes', 'a');
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 20, remaining: 0 });
  });

  it('refills over time', () => {
    let t = 0;
    const rl = new RateLimiter({ writes: { perMinute: 60 } }, () => t);
    for (let i = 0; i < 60; i++) rl.take('writes', 'a');
    expect(rl.take('writes', 'a').allowed).toBe(false);
    t += 1_000;
    expect(rl.take('writes', 'a').allowed).toBe(true);
    expect(rl.take('writes', 'a').allowed).toBe(false);
    t += 120_000;
    expect(rl.take('writes', 'a').remaining).toBe(59);
  });

  it('keeps clients and buckets apart', () => {
    const rl = new RateLimiter({ writes: { perMinute: 1 }, uploads: { perMinute: 1 } }, () => 0);
    expect(rl.take('writes', 'a').allowed).toBe(true);
    expect(rl.take('writes', 'b').allowed).toBe(true);
    expect(rl.take('uploads', 'a').allowed).toBe(true);
    expect(rl.take('writes', 'a').allowed).toBe(false);
  });

  it('treats 0 as unlimited', () => {
    const rl = new RateLimiter({ writes: { perMinute: 0 } });
    for (let i = 0; i < 1_000; i++) expect(rl.take('writes', 'a').allowed).toBe(true);
    expect(rl.size).toBe(0);
  });

  it('evicts the least recently seen clients past its size cap', () => {
    const rl = new RateLimiter({ writes: { perMinute: 1 } }, () => 0, 3);
    for (const c of ['a', 'b', 'c', 'd']) rl.take('writes', c);
    expect(rl.size).toBe(3);
    // 'a' was evicted, so it starts with a full bucket again.
    expect(rl.take('writes', 'a').allowed).toBe(true);
    expect(rl.take('writes', 'd').allowed).toBe(false);
  });

  it('refuses unknown buckets and bad rules', () => {
    expect(() => new RateLimiter({ writes: { perMinute: 1 } }).take('reads', 'a')).toThrow(/unknown/);
    expect(() => new RateLimiter({ writes: { perMinute: -1 } })).toThrow(/non-negative/);
    expect(() => new RateLimiter({ writes: { perMinute: 1.5 } })).toThrow(/non-negative/);
  });

  it.each([
    ['GET', '/v1/invoices', undefined],
    ['HEAD', '/v1/invoices', undefined],
    ['OPTIONS', '/v1/invoices', undefined],
    ['POST', '/v1/invoices', 'uploads'],
    ['POST', '/v1/invoices?x=1', 'uploads'],
    ['POST', '/v1/invoices/abc/approve', 'writes'],
    ['PATCH', '/v1/invoices/abc', 'writes'],
    ['POST', '/v1/payment-runs', 'writes'],
    ['POST', '/v1/lifecycle/evaluate', 'writes'],
    ['GET', '/metrics', undefined],
    ['POST', '/healthz', undefined],
  ])('%s %s draws from %s', (method, url, bucket) => {
    expect(bucketFor(method, url)).toBe(bucket);
  });
});

describe('readiness', () => {
  const ids = ['0001', '0002', '0003', '0004'];
  const fakeDb = (rows: Array<{ id: string }> | Error | 'hang') => ({
    query: vi.fn(() => {
      if (rows === 'hang') return new Promise(() => undefined);
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows });
    }),
  });

  it('is ready when the database answers and every migration is applied', async () => {
    const r = await checkReadiness({ db: fakeDb(ids.map((id) => ({ id }))) as never, expectedMigrations: ids, aiPing: async () => true });
    expect(r.status).toBe('ready');
    expect(r.checks.migrations).toEqual({ ok: true, applied: 4, expected: 4 });
    expect(r.checks.aiService).toMatchObject({ ok: true, required: false });
  });

  it('is not ready when a migration is missing, and names it', async () => {
    const r = await checkReadiness({ db: fakeDb([{ id: '0001' }, { id: '0002' }]) as never, expectedMigrations: ids });
    expect(r.status).toBe('not_ready');
    expect(r.checks.migrations).toEqual({ ok: false, applied: 2, expected: 4, detail: 'not applied: 0003, 0004' });
  });

  it('is not ready when the database fails, without echoing the error', async () => {
    const r = await checkReadiness({ db: fakeDb(new Error('password authentication failed for user invoiceiq_app')) as never, expectedMigrations: ids });
    expect(r.status).toBe('not_ready');
    expect(r.checks.database).toMatchObject({ ok: false, detail: 'unavailable' });
    expect(JSON.stringify(r)).not.toContain('password');
  });

  it('times out a hung database', async () => {
    const r = await checkReadiness({ db: fakeDb('hang') as never, expectedMigrations: ids, timeoutMs: 20 });
    expect(r.checks.database).toMatchObject({ ok: false, detail: 'timed out after 20 ms' });
  });

  it('stays ready while ai-service sleeps or errors', async () => {
    const db = fakeDb(ids.map((id) => ({ id })));
    const asleep = await checkReadiness({ db: db as never, expectedMigrations: ids, aiPing: async () => false });
    expect(asleep.status).toBe('ready');
    expect(asleep.checks.aiService).toMatchObject({ ok: false, detail: 'asleep or unreachable' });
    const broken = await checkReadiness({
      db: db as never,
      expectedMigrations: ids,
      aiPing: () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1')),
    });
    expect(broken.status).toBe('ready');
    expect(JSON.stringify(broken)).not.toContain('10.0.0.1');
  });

  it('reports ai-service as not configured without a ping', async () => {
    const r = await checkReadiness({ db: fakeDb(ids.map((id) => ({ id }))) as never, expectedMigrations: ids });
    expect(r.checks.aiService).toEqual({ ok: false, required: false, detail: 'not configured' });
  });
});

describe('HTTP observability (no database)', () => {
  it('serves Prometheus text on /metrics, open by default outside production', async () => {
    const app = buildApp();
    await app.inject({ method: 'GET', url: '/healthz' });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(res.body).toContain('invoiceiq_http_requests_total{method="GET",route="/healthz",status="2xx"} 1');
    await app.close();
  });

  it('needs the scrape token when one is set', async () => {
    const app = buildApp({ metricsToken: TOKEN });
    const refused = await app.inject({ method: 'GET', url: '/metrics' });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toBe('Bearer realm="metrics"');
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(200);
    await app.close();
  });

  it('hides /metrics in production without a token', async () => {
    const app = buildApp({ production: true });
    expect((await app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(404);
    await app.close();
  });

  it('checks bearer tokens in constant time and exactly', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false);
  });

  it('reports not ready without a database', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not_ready', checks: { database: { ok: false } } });
    await app.close();
  });

  it('sets security headers on every response', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/reason-codes' });
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(res.headers[k], k).toBe(v);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  it('adds HSTS in production', async () => {
    const app = buildApp({ production: true });
    expect((await app.inject({ method: 'GET', url: '/healthz' })).headers['strict-transport-security']).toBe(HSTS);
    await app.close();
  });

  it('does not mark non-API responses no-store', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).headers['cache-control']).toBeUndefined();
    await app.close();
  });

  it('returns a trace id and continues the caller trace', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { traceparent: HEADER } });
    expect(res.headers['x-trace-id']).toBe(TRACE);
    expect(res.headers['traceresponse']).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-01$`));
    const fresh = await app.inject({ method: 'GET', url: '/healthz', headers: { traceparent: 'junk' } });
    expect(fresh.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh.headers['x-trace-id']).not.toBe(TRACE);
    await app.close();
  });

  it('labels requests by route template, never by raw path', async () => {
    const metrics = createCoreMetrics();
    const app = buildApp({ metrics });
    await app.inject({ method: 'GET', url: '/v1/invoices/7c3e1f7a-0000-4000-8000-000000000001' });
    await app.inject({ method: 'GET', url: '/no/such/route/123' });
    const text = await metrics.registry.render();
    expect(text).toContain('route="/v1/invoices/:invoiceId"');
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain('7c3e1f7a');
    expect(text).not.toContain('/no/such');
    await app.close();
  });

  it('returns the in-flight gauge to zero', async () => {
    const metrics = createCoreMetrics();
    const app = buildApp({ metrics });
    await Promise.all([1, 2, 3].map(() => app.inject({ method: 'GET', url: '/healthz' })));
    expect(metrics.httpInFlight.get()).toBe(0);
    await app.close();
  });

  it('refuses a flood of writes with 429 and Retry-After, before authentication', async () => {
    const metrics = createCoreMetrics();
    const app = buildApp({ metrics, rateLimiter: new RateLimiter({ writes: { perMinute: 2 }, uploads: { perMinute: 1 } }) });
    const evaluate = () =>
      app.inject({
        method: 'POST',
        url: '/v1/lifecycle/evaluate',
        headers: { authorization: 'Demo no-such-persona' },
        payload: { from: 'RECEIVED', to: 'EXTRACTING', actor: { kind: 'system', id: 's' } },
      });
    expect((await evaluate()).statusCode).toBe(401);
    expect((await evaluate()).statusCode).toBe(401);
    const limited = await evaluate();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('30');
    expect(limited.json()).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    expect(limited.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(metrics.rateLimited.get({ bucket: 'writes' })).toBe(1);
    // Reads are never limited.
    expect((await app.inject({ method: 'GET', url: '/v1/reason-codes' })).statusCode).toBe(200);
    await app.close();
  });

  it('counts readiness answers', async () => {
    const metrics = createCoreMetrics();
    const app = buildApp({ metrics });
    await app.inject({ method: 'GET', url: '/readyz' });
    expect(metrics.readinessChecks.get({ result: 'not_ready' })).toBe(1);
    await app.close();
  });

  it('trusts only the configured number of proxy hops for the client address', async () => {
    const app = buildApp({ trustProxy: 1, rateLimiter: new RateLimiter({ writes: { perMinute: 1 }, uploads: { perMinute: 1 } }) });
    const post = (xff: string) =>
      app.inject({ method: 'POST', url: '/v1/lifecycle/evaluate', headers: { 'x-forwarded-for': xff }, payload: {} });
    // A client cannot mint new identities by prepending addresses: only the hop nearest the proxy counts.
    expect((await post('1.1.1.1, 9.9.9.9')).statusCode).not.toBe(429);
    expect((await post('2.2.2.2, 9.9.9.9')).statusCode).toBe(429);
    expect((await post('9.9.9.8')).statusCode).not.toBe(429);
    await app.close();
  });
});

describe('ai-service client instrumentation', () => {
  const GOOD = {
    signals: [],
  };
  const calls: Array<{ op: AiOperation; outcome: AiOutcome }> = [];
  const observe = (op: AiOperation, outcome: AiOutcome) => calls.push({ op, outcome });
  const extraction = {
    documentSha256: 'a'.repeat(64),
    provider: 'heuristic',
    fields: Object.fromEntries(
      ['vendorName', 'invoiceNumber', 'invoiceDate', 'currency', 'totalMinor', 'subtotalMinor', 'taxMinor', 'dueDate'].map((k) => [k, { value: null, confidence: 0 }]),
    ),
    lineItems: [],
  } as never;

  function client(status: number, body: unknown, seen: Array<Record<string, string>> = []) {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: fetchImpl, observe });
  }

  it('forwards the current trace as a child span', async () => {
    const seen: Array<Record<string, string>> = [];
    const ctx = startSpan(HEADER);
    await runWithTrace(ctx, () => client(200, GOOD, seen).signals({ extraction, extractionConfidenceHoldBelow: 0.8 }));
    const parsed = parseTraceparent(seen[0]?.['traceparent']);
    expect(parsed?.traceId).toBe(TRACE);
    expect(parsed?.spanId).not.toBe(ctx.spanId);
  });

  it('sends no traceparent outside a trace', async () => {
    const seen: Array<Record<string, string>> = [];
    await client(200, GOOD, seen).signals({ extraction, extractionConfidenceHoldBelow: 0.8 });
    expect(seen[0]?.['traceparent']).toBeUndefined();
  });

  it('reports ok, unavailable and rejected outcomes', async () => {
    calls.length = 0;
    await client(200, GOOD).signals({ extraction, extractionConfidenceHoldBelow: 0.8 });
    await expect(client(503, {}).signals({ extraction, extractionConfidenceHoldBelow: 0.8 })).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(client(422, {}).signals({ extraction, extractionConfidenceHoldBelow: 0.8 })).rejects.toBeInstanceOf(AiRejectedError);
    await expect(client(200, { off: 'contract' }).signals({ extraction, extractionConfidenceHoldBelow: 0.8 })).rejects.toBeInstanceOf(AiRejectedError);
    expect(calls).toEqual([
      { op: 'signals', outcome: 'ok' },
      { op: 'signals', outcome: 'unavailable' },
      { op: 'signals', outcome: 'rejected' },
      { op: 'signals', outcome: 'rejected' },
    ]);
  });

  it('pings the health check without throwing', async () => {
    expect(await client(200, { status: 'ok' }).ping?.()).toBe(true);
    expect(await client(503, {}).ping?.()).toBe(false);
    const down = httpAiClient({
      baseUrl: 'http://ai',
      signingSecret: 's'.repeat(32),
      fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch,
    });
    expect(await down.ping?.()).toBe(false);
  });
});

describe('Phase 4 configuration', () => {
  const BASE = { DATABASE_URL: 'postgres://app@db/iq', AI_SERVICE_URL: 'http://ai:8001', AI_SIGNING_SECRET: 'x'.repeat(32), AUTH_MODE: 'demo', MIGRATION_DATABASE_URL: 'postgres://o@db/iq' };

  it('has safe defaults', () => {
    const c = loadConfig(BASE);
    expect(c.RATE_LIMIT_WRITES_PER_MINUTE).toBe(120);
    expect(c.RATE_LIMIT_UPLOADS_PER_MINUTE).toBe(20);
    expect(c.TRUST_PROXY_HOPS).toBe(1);
    expect(c.METRICS_TOKEN).toBeUndefined();
    expect(c.BUILD_VERSION).toBe('0.0.0');
  });

  it('refuses a short metrics token or app password', () => {
    expect(() => loadConfig({ ...BASE, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN must be at least 32/);
    expect(() => loadConfig({ ...BASE, APP_DB_PASSWORD: 'short' })).toThrow(/APP_DB_PASSWORD must be at least 24/);
  });

  it('needs the owner URL to apply an app password', () => {
    const noOwner = Object.fromEntries(Object.entries(BASE).filter(([k]) => k !== 'MIGRATION_DATABASE_URL'));
    expect(() => loadConfig({ ...noOwner, AUTH_MODE: 'oidc', OIDC_ISSUER: 'https://i/', OIDC_AUDIENCE: 'a', OIDC_JWKS_URL: 'https://i/j', APP_DB_PASSWORD: 'p'.repeat(30) })).toThrow(
      /needs MIGRATION_DATABASE_URL/,
    );
  });

  it('parses limits and hops as integers and lets 0 turn a limit off', () => {
    const c = loadConfig({ ...BASE, RATE_LIMIT_WRITES_PER_MINUTE: '0', TRUST_PROXY_HOPS: '2' });
    expect(c.RATE_LIMIT_WRITES_PER_MINUTE).toBe(0);
    expect(c.TRUST_PROXY_HOPS).toBe(2);
    expect(() => loadConfig({ ...BASE, TRUST_PROXY_HOPS: '11' })).toThrow();
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_UPLOADS_PER_MINUTE: '-1' })).toThrow();
  });
});
