import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { problemBody } from '../http/problem.js';
import { statusClass, type CoreMetrics } from './catalog.js';
import { PROMETHEUS_CONTENT_TYPE } from './metrics.js';
import { bucketFor, type RateLimiter } from './rate-limit.js';
import type { ReadinessReport } from './readiness.js';
import { formatTraceparent, runWithTrace, startSpan, type TraceContext } from './trace.js';

/**
 * Per-request plumbing for a hosted core-api: a trace span and trace-tagged
 * logger, RED metrics by route template, per-client rate limits on writes,
 * baseline security headers, and the /metrics and /readyz endpoints.
 * Registered before authentication, so a flood is refused before any work.
 */

export interface ObservabilityOptions {
  readonly metrics: CoreMetrics;
  /** Bearer token for /metrics. Unset: /metrics is open unless `production`. */
  readonly metricsToken?: string;
  readonly production?: boolean;
  readonly rateLimiter?: RateLimiter;
  /** Undefined on an instance without a database: /readyz then reports not_ready. */
  readonly readiness?: () => Promise<ReadinessReport>;
}

declare module 'fastify' {
  interface FastifyRequest {
    trace: TraceContext | null;
  }
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-site',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

export const HSTS = 'max-age=31536000; includeSubDomains';

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m?.[1]) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

function routeOf(req: FastifyRequest): string {
  // A route template (/v1/invoices/:invoiceId), never the raw path, so ids never become labels.
  return req.routeOptions.url ?? 'unmatched';
}

export function registerObservability(app: FastifyInstance, opts: ObservabilityOptions): void {
  const { metrics } = opts;
  app.decorateRequest('trace', null);

  app.addHook('onRequest', (req, reply, done) => {
    const ctx = startSpan(req.headers.traceparent);
    req.trace = ctx;
    req.log = req.log.child({ traceId: ctx.traceId, spanId: ctx.spanId });
    void reply.header('x-trace-id', ctx.traceId).header('traceresponse', formatTraceparent(ctx));
    metrics.httpInFlight.inc();

    const bucket = opts.rateLimiter ? bucketFor(req.method, req.url) : undefined;
    if (bucket && opts.rateLimiter) {
      const decision = opts.rateLimiter.take(bucket, req.ip);
      if (!decision.allowed) {
        metrics.rateLimited.inc({ bucket });
        req.log.warn({ bucket }, 'rate limited');
        void reply
          .code(429)
          .header('retry-after', String(decision.retryAfterSeconds))
          .type('application/problem+json')
          .send(problemBody(429, 'Too many requests', `slow down; retry in ${decision.retryAfterSeconds}s`, 'RATE_LIMITED'));
        return;
      }
    }
    runWithTrace(ctx, done);
  });

  app.addHook('onSend', (req, reply, payload, done) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) void reply.header(k, v);
    if (opts.production) void reply.header('strict-transport-security', HSTS);
    // API responses carry invoice and payment data: never let a shared cache keep them.
    if (req.url.startsWith('/v1/') && !reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  app.addHook('onResponse', (req, reply, done) => {
    metrics.httpInFlight.inc(undefined, -1);
    const route = routeOf(req);
    metrics.httpRequests.inc({ method: req.method, route, status: statusClass(reply.statusCode) });
    metrics.httpDuration.observe(reply.elapsedTime / 1000, { method: req.method, route });
    done();
  });

  app.get('/metrics', async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.metricsToken) {
      if (!bearerMatches(req.headers.authorization, opts.metricsToken)) {
        return reply
          .code(401)
          .header('www-authenticate', 'Bearer realm="metrics"')
          .type('application/problem+json')
          .send(problemBody(401, 'Unauthorized', 'metrics need the scrape token'));
      }
    } else if (opts.production) {
      return reply.code(404).type('application/problem+json').send(problemBody(404, 'Not found', 'set METRICS_TOKEN to enable /metrics'));
    }
    const body = await metrics.registry.render((err) => req.log.warn({ err: String(err) }, 'metrics collector failed'));
    return reply.type(PROMETHEUS_CONTENT_TYPE).header('cache-control', 'no-store').send(body);
  });

  app.get('/readyz', async (_req, reply) => {
    const report: ReadinessReport = opts.readiness
      ? await opts.readiness()
      : {
          status: 'not_ready',
          checks: {
            database: { ok: false, detail: 'not configured' },
            migrations: { ok: false, expected: 0, detail: 'not configured' },
            aiService: { ok: false, required: false, detail: 'not configured' },
          },
        };
    metrics.readinessChecks.inc({ result: report.status });
    return reply.code(report.status === 'ready' ? 200 : 503).header('cache-control', 'no-store').send(report);
  });
}
