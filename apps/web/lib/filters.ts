import type { InvoiceState } from './api';
import { INVOICE_STATES } from './catalog';
import { parseMoneyInput } from './money';

/**
 * Dashboard filters as the person types them (amounts in major units of the
 * chosen currency, or two decimals when none is chosen), and
 * their translation into the API's query string (amounts in minor units).
 * The same query drives the list, the summary and the export links, so what
 * you see is exactly what you export.
 */
export interface DashboardFilters {
  state: InvoiceState | '';
  q: string;
  currency: string;
  dateFrom: string;
  dateTo: string;
  minTotal: string;
  maxTotal: string;
}

export const EMPTY_FILTERS: DashboardFilters = { state: '', q: '', currency: '', dateFrom: '', dateTo: '', minTotal: '', maxTotal: '' };

export type FilterErrors = Partial<Record<keyof DashboardFilters, string>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateFilters(f: DashboardFilters): FilterErrors {
  const errors: FilterErrors = {};
  if (f.q.trim().length > 100) errors.q = 'At most 100 characters';
  if (f.currency && !/^[A-Z]{3}$/.test(f.currency.trim().toUpperCase())) errors.currency = 'A 3-letter code like USD';
  if (f.dateFrom && !DATE_RE.test(f.dateFrom)) errors.dateFrom = 'Use YYYY-MM-DD';
  if (f.dateTo && !DATE_RE.test(f.dateTo)) errors.dateTo = 'Use YYYY-MM-DD';
  if (!errors.dateFrom && !errors.dateTo && f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) errors.dateTo = 'Must be on or after the start date';
  const min = f.minTotal ? parseMoneyInput(f.minTotal, f.currency) : undefined;
  const max = f.maxTotal ? parseMoneyInput(f.maxTotal, f.currency) : undefined;
  if (min && !min.ok) errors.minTotal = min.error;
  if (max && !max.ok) errors.maxTotal = max.error;
  if (min?.ok && max?.ok && BigInt(min.minor) > BigInt(max.minor)) errors.maxTotal = 'Must be at least the minimum';
  return errors;
}

/** Query string for the API (no leading "?"). Empty and invalid fields are left out. */
export function filtersToQuery(f: DashboardFilters): string {
  const errors = validateFilters(f);
  const p = new URLSearchParams();
  if (f.state) p.set('state', f.state);
  if (f.q.trim() && !errors.q) p.set('q', f.q.trim());
  if (f.currency.trim() && !errors.currency) p.set('currency', f.currency.trim().toUpperCase());
  if (f.dateFrom && !errors.dateFrom) p.set('dateFrom', f.dateFrom);
  if (f.dateTo && !errors.dateTo) p.set('dateTo', f.dateTo);
  for (const [field, param] of [
    ['minTotal', 'minTotalMinor'],
    ['maxTotal', 'maxTotalMinor'],
  ] as const) {
    if (!f[field] || errors[field]) continue;
    const parsed = parseMoneyInput(f[field], f.currency);
    if (parsed.ok) p.set(param, parsed.minor);
  }
  return p.toString();
}

/** Filters from the page URL, so a filtered dashboard can be bookmarked and shared. */
export function filtersFromSearch(search: string | URLSearchParams): DashboardFilters {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const state = p.get('state') ?? '';
  return {
    state: (INVOICE_STATES as readonly string[]).includes(state) ? (state as InvoiceState) : '',
    q: p.get('q') ?? '',
    currency: p.get('currency') ?? '',
    dateFrom: p.get('dateFrom') ?? '',
    dateTo: p.get('dateTo') ?? '',
    minTotal: p.get('minTotal') ?? '',
    maxTotal: p.get('maxTotal') ?? '',
  };
}

/** The page URL's own query: human-readable amounts, only the fields in use. */
export function filtersToSearch(f: DashboardFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  return p.toString();
}

export function activeFilterCount(f: DashboardFilters): number {
  return Object.values(f).filter((v) => v !== '').length;
}
