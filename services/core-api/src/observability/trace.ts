import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) without an SDK.
 * core-api accepts a `traceparent` from its caller, starts a span for each
 * request and each outbox event, stores the trace on outbox rows so the
 * extraction that runs later joins the upload's trace, and forwards it to
 * ai-service. Logs carry `traceId`, so one id finds every line of an invoice's
 * journey across both services.
 */

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  /** The caller's span, when there was one. */
  readonly parentSpanId?: string;
  readonly sampled: boolean;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

export function newTraceId(): string {
  let id: string;
  do id = randomBytes(16).toString('hex');
  while (id === ZERO_TRACE);
  return id;
}

export function newSpanId(): string {
  let id: string;
  do id = randomBytes(8).toString('hex');
  while (id === ZERO_SPAN);
  return id;
}

/**
 * Parse a `traceparent` header. Returns undefined for anything the spec says
 * to ignore: wrong shape, version ff, all-zero ids, or a version-00 header with
 * trailing data. Unknown future versions are read by their first four fields.
 */
export function parseTraceparent(header: string | string[] | undefined): { traceId: string; spanId: string; sampled: boolean } | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim().toLowerCase();
  if (value.length > 512) return undefined;
  const head = value.slice(0, 55);
  const m = TRACEPARENT_RE.exec(head);
  if (!m) return undefined;
  const [, version, traceId, spanId, flags] = m as unknown as [string, string, string, string, string];
  if (version === 'ff') return undefined;
  if (version === '00' && value.length !== 55) return undefined;
  if (version !== '00' && value.length > 55 && value[55] !== '-') return undefined;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(ctx: Pick<TraceContext, 'traceId' | 'spanId' | 'sampled'>): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

/** A new span: a child of the incoming header when it is valid, else the root of a new trace. */
export function startSpan(incoming?: string | string[] | null): TraceContext {
  const parent = parseTraceparent(incoming ?? undefined);
  if (!parent) return { traceId: newTraceId(), spanId: newSpanId(), sampled: true };
  return { traceId: parent.traceId, spanId: newSpanId(), parentSpanId: parent.spanId, sampled: parent.sampled };
}

/** A child span of an existing context (an outgoing call, a unit of work). */
export function childSpan(ctx: TraceContext): TraceContext {
  return { traceId: ctx.traceId, spanId: newSpanId(), parentSpanId: ctx.spanId, sampled: ctx.sampled };
}

const store = new AsyncLocalStorage<TraceContext>();

export function currentTrace(): TraceContext | undefined {
  return store.getStore();
}

export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The header to send on an outgoing call: a fresh child of the current span, or nothing outside a trace. */
export function outgoingTraceparent(): string | undefined {
  const ctx = currentTrace();
  return ctx ? formatTraceparent(childSpan(ctx)) : undefined;
}
