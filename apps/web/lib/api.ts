import type { components } from '@invoiceiq/contracts/core-api';

export type Invoice = components['schemas']['Invoice'];
export type InvoicePage = components['schemas']['InvoicePage'];
export type InvoiceState = components['schemas']['InvoiceState'];
export type ReasonCode = components['schemas']['ReasonCode'];
export type Problem = components['schemas']['Problem'];
export type ExtractedField = components['schemas']['ExtractedField'];

/** Browser calls go to same-origin /api/core, which next.config.ts rewrites to core-api. */
export const API_BASE = '/api/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem>,
  ) {
    super(problem.detail ?? problem.title ?? `request failed (${status})`);
    this.name = 'ApiError';
  }
}

type Fetch = typeof fetch;

async function call<T>(path: string, init: RequestInit = {}, fetchFn: Fetch = fetch): Promise<T> {
  const res = await fetchFn(`${API_BASE}${path}`, { ...init, headers: { accept: 'application/json', ...init.headers } });
  const text = await res.text();
  let body: unknown = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // A proxy error page while the backend wakes up is not JSON.
  }
  if (!res.ok) throw new ApiError(res.status, (body as Partial<Problem>) ?? { title: res.statusText });
  return body as T;
}

export function idempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

export function listInvoices(fetchFn?: Fetch): Promise<InvoicePage> {
  return call('/v1/invoices?limit=20', {}, fetchFn);
}

export function getInvoice(id: string, fetchFn?: Fetch): Promise<Invoice> {
  return call(`/v1/invoices/${encodeURIComponent(id)}`, {}, fetchFn);
}

export function documentUrl(id: string): string {
  return `${API_BASE}/v1/invoices/${encodeURIComponent(id)}/document`;
}

export function uploadInvoice(file: File, fetchFn?: Fetch): Promise<Invoice> {
  const form = new FormData();
  form.append('sourceChannel', 'upload');
  form.append('file', file, file.name);
  return call('/v1/invoices', { method: 'POST', body: form, headers: { 'idempotency-key': idempotencyKey() } }, fetchFn);
}

function postJson<T>(path: string, body: unknown, key: string, fetchFn?: Fetch): Promise<T> {
  return call(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'idempotency-key': key } }, fetchFn);
}

export function approveInvoice(id: string, comment: string | undefined, key = idempotencyKey(), fetchFn?: Fetch): Promise<Invoice> {
  return postJson(`/v1/invoices/${encodeURIComponent(id)}/approve`, comment ? { comment } : {}, key, fetchFn);
}

export function rejectInvoice(id: string, reasons: ReasonCode[], comment: string | undefined, key = idempotencyKey(), fetchFn?: Fetch): Promise<Invoice> {
  return postJson(`/v1/invoices/${encodeURIComponent(id)}/reject`, { reasons, ...(comment ? { comment } : {}) }, key, fetchFn);
}

export function sendToApproval(id: string, comment: string | undefined, key = idempotencyKey(), fetchFn?: Fetch): Promise<Invoice> {
  return postJson(`/v1/invoices/${encodeURIComponent(id)}/transitions`, { to: 'PENDING_APPROVAL', ...(comment ? { comment } : {}) }, key, fetchFn);
}
