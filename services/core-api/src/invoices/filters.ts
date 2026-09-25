import { isInvoiceState, type InvoiceState } from '../domain/index.js';
import { HttpProblem } from '../http/problem.js';

/**
 * Dashboard filters shared by listInvoices, getInvoiceSummary and
 * exportInvoices. Parsing is strict (a filter the API cannot honour is a 400,
 * never silently ignored) and the SQL is built from parameters only.
 */
export interface InvoiceFilter {
  readonly state?: InvoiceState;
  /** Case-insensitive substring of vendor name, invoice number or file name. */
  readonly q?: string;
  readonly currency?: string;
  /** Inclusive invoice-date bounds, YYYY-MM-DD. */
  readonly dateFrom?: string;
  readonly dateTo?: string;
  /** Inclusive total bounds in minor units. */
  readonly minTotalMinor?: bigint;
  readonly maxTotalMinor?: bigint;
}

export interface RawFilterQuery {
  state?: string;
  q?: string;
  currency?: string;
  dateFrom?: string;
  dateTo?: string;
  minTotalMinor?: string;
  maxTotalMinor?: string;
}

/** JSON-schema fragment for the query parameters (Fastify validates before the handler runs). */
export const FILTER_QUERY_PROPERTIES = {
  q: { type: 'string', minLength: 1, maxLength: 100 },
  currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  dateFrom: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  dateTo: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  minTotalMinor: { type: 'string', pattern: '^-?[0-9]{1,18}$' },
  maxTotalMinor: { type: 'string', pattern: '^-?[0-9]{1,18}$' },
} as const;

const MINOR_RE = /^-?[0-9]{1,18}$/;

export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function bad(detail: string): HttpProblem {
  return new HttpProblem(400, 'Invalid filter', detail, 'INVALID_FILTER');
}

export function parseFilter(raw: RawFilterQuery): InvoiceFilter {
  const out: {
    -readonly [K in keyof InvoiceFilter]: InvoiceFilter[K];
  } = {};
  if (raw.state !== undefined) {
    if (!isInvoiceState(raw.state)) throw bad(`${raw.state} is not a lifecycle state`);
    out.state = raw.state;
  }
  if (raw.q !== undefined) {
    const q = raw.q.trim();
    if (q.length > 100) throw bad('q is at most 100 characters');
    if (q) out.q = q;
  }
  if (raw.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(raw.currency)) throw bad('currency must be an ISO 4217 code such as USD');
    out.currency = raw.currency;
  }
  for (const key of ['dateFrom', 'dateTo'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isCalendarDate(v)) throw bad(`${key} must be a real date as YYYY-MM-DD`);
    out[key] = v;
  }
  for (const key of ['minTotalMinor', 'maxTotalMinor'] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!MINOR_RE.test(v)) throw bad(`${key} must be an integer number of minor units`);
    out[key] = BigInt(v);
  }
  if (out.dateFrom && out.dateTo && out.dateFrom > out.dateTo) throw bad('dateFrom is after dateTo');
  if (out.minTotalMinor !== undefined && out.maxTotalMinor !== undefined && out.minTotalMinor > out.maxTotalMinor) {
    throw bad('minTotalMinor is above maxTotalMinor');
  }
  return out;
}

/** Escape LIKE wildcards so a search for "50%" means the characters, not a pattern. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * WHERE fragments for a filter, against the `invoices` table aliased `i`.
 * Values go into `params` (mutated); fragments only reference placeholders.
 */
export function filterSql(filter: InvoiceFilter, params: unknown[]): string[] {
  const where: string[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filter.state) where.push(`i.state = ${bind(filter.state)}`);
  if (filter.q) {
    const p = bind(likePattern(filter.q));
    where.push(`(i.vendor_name ILIKE ${p} OR i.invoice_number ILIKE ${p} OR i.document_filename ILIKE ${p})`);
  }
  if (filter.currency) where.push(`i.currency = ${bind(filter.currency)}`);
  if (filter.dateFrom) where.push(`i.invoice_date >= ${bind(filter.dateFrom)}::date`);
  if (filter.dateTo) where.push(`i.invoice_date <= ${bind(filter.dateTo)}::date`);
  if (filter.minTotalMinor !== undefined) where.push(`i.total_minor >= ${bind(filter.minTotalMinor.toString())}::bigint`);
  if (filter.maxTotalMinor !== undefined) where.push(`i.total_minor <= ${bind(filter.maxTotalMinor.toString())}::bigint`);
  return where;
}
