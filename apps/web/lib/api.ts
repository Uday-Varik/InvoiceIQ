import type { components } from '@invoiceiq/contracts/core-api';

export type Invoice = components['schemas']['Invoice'];
export type InvoicePage = components['schemas']['InvoicePage'];
export type InvoiceState = components['schemas']['InvoiceState'];
export type ReasonCode = components['schemas']['ReasonCode'];
export type Problem = components['schemas']['Problem'];
export type ExtractedField = components['schemas']['ExtractedField'];
export type InvoiceSummary = components['schemas']['InvoiceSummary'];
export type InvoiceCorrection = components['schemas']['InvoiceCorrection'];
export type LineItem = components['schemas']['LineItem'];
export type CorrectableField = components['schemas']['CorrectableField'];

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

/** `query` is a filtersToQuery() string; `cursor` continues a previous page. */
export function listInvoices(query = '', opts: { limit?: number; cursor?: string } = {}, fetchFn?: Fetch): Promise<InvoicePage> {
  const p = new URLSearchParams(query);
  p.set('limit', String(opts.limit ?? 20));
  if (opts.cursor) p.set('cursor', opts.cursor);
  return call(`/v1/invoices?${p.toString()}`, {}, fetchFn);
}

export function getSummary(query = '', fetchFn?: Fetch): Promise<InvoiceSummary> {
  return call(`/v1/invoices/summary${query ? `?${query}` : ''}`, {}, fetchFn);
}

/** A plain link: the browser downloads through the same-origin proxy with the server's filename. */
export function exportUrl(format: 'csv' | 'json', query = ''): string {
  const p = new URLSearchParams(query);
  p.set('format', format);
  return `${API_BASE}/v1/invoices/export?${p.toString()}`;
}

export function correctInvoice(id: string, body: InvoiceCorrection, key = idempotencyKey(), fetchFn?: Fetch): Promise<Invoice> {
  return call(
    `/v1/invoices/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'idempotency-key': key } },
    fetchFn,
  );
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

// Phase 3: who am I, vendors, payment runs, audit checkpoints ------------------

export type Me = components['schemas']['Me'];
export type ApproverRole = components['schemas']['ApproverRole'];
export type Vendor = components['schemas']['Vendor'];
export type VendorDetail = components['schemas']['VendorDetail'];
export type VendorList = components['schemas']['VendorList'];
export type BankChange = components['schemas']['BankChange'];
export type BankChangeStatus = components['schemas']['BankChangeStatus'];
export type PaymentRun = components['schemas']['PaymentRun'];
export type PaymentRunList = components['schemas']['PaymentRunList'];
export type PaymentRunResult = components['schemas']['PaymentRunResult'];
export type PaymentRunStatus = components['schemas']['PaymentRunStatus'];
export type AuditCheckpoint = components['schemas']['AuditCheckpoint'];
export type AuditCheckpointList = components['schemas']['AuditCheckpointList'];
export type AuditCheckpointVerification = components['schemas']['AuditCheckpointVerification'];
export type AuditVerification = components['schemas']['AuditVerification'];

function sendJson<T>(method: 'POST' | 'PATCH', path: string, body: unknown, key: string | null, fetchFn?: Fetch): Promise<T> {
  return call(
    path,
    { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) } },
    fetchFn,
  );
}

export function getMe(fetchFn?: Fetch): Promise<Me> {
  return call('/v1/me', {}, fetchFn);
}

export function listVendors(q = '', fetchFn?: Fetch): Promise<VendorList> {
  const p = new URLSearchParams({ limit: '200' });
  if (q.trim()) p.set('q', q.trim());
  return call(`/v1/vendors?${p.toString()}`, {}, fetchFn);
}

export function getVendor(id: string, fetchFn?: Fetch): Promise<VendorDetail> {
  return call(`/v1/vendors/${encodeURIComponent(id)}`, {}, fetchFn);
}

export function createVendor(name: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<VendorDetail> {
  return sendJson('POST', '/v1/vendors', { name }, key, fetchFn);
}

export function setVendorStatus(id: string, expectedVersion: number, status: Vendor['status'], comment?: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<VendorDetail> {
  return sendJson('PATCH', `/v1/vendors/${encodeURIComponent(id)}`, { expectedVersion, status, ...(comment ? { comment } : {}) }, key, fetchFn);
}

export function requestBankChange(vendorId: string, last4: string, evidenceSha256: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<BankChangeStatus> {
  return sendJson('POST', `/v1/vendors/${encodeURIComponent(vendorId)}/bank-changes`, { ibanOrAccountLast4: last4, evidenceDocumentSha256: evidenceSha256 }, key, fetchFn);
}

export function verifyBankChange(vendorId: string, changeId: string, callbackNote: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<BankChangeStatus> {
  return sendJson(
    'POST',
    `/v1/vendors/${encodeURIComponent(vendorId)}/bank-changes/${encodeURIComponent(changeId)}/verify`,
    { callbackNote },
    key,
    fetchFn,
  );
}

export function listPaymentRuns(status?: PaymentRunStatus, fetchFn?: Fetch): Promise<PaymentRunList> {
  return call(`/v1/payment-runs${status ? `?status=${status}` : ''}`, {}, fetchFn);
}

export function getPaymentRun(id: string, fetchFn?: Fetch): Promise<PaymentRun> {
  return call(`/v1/payment-runs/${encodeURIComponent(id)}`, {}, fetchFn);
}

export function createPaymentRun(currency: string, comment?: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<PaymentRunResult> {
  return sendJson('POST', '/v1/payment-runs', { currency, ...(comment ? { comment } : {}) }, key, fetchFn);
}

export function confirmPaymentRun(id: string, expectedVersion: number, comment?: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<PaymentRun> {
  return sendJson('POST', `/v1/payment-runs/${encodeURIComponent(id)}/confirm`, { expectedVersion, ...(comment ? { comment } : {}) }, key, fetchFn);
}

export function cancelPaymentRun(id: string, expectedVersion: number, comment: string, key = idempotencyKey(), fetchFn?: Fetch): Promise<PaymentRun> {
  return sendJson('POST', `/v1/payment-runs/${encodeURIComponent(id)}/cancel`, { expectedVersion, comment }, key, fetchFn);
}

export function paymentFileUrl(id: string): string {
  return `${API_BASE}/v1/payment-runs/${encodeURIComponent(id)}/file`;
}

export function verifyAudit(fetchFn?: Fetch): Promise<AuditVerification> {
  return call('/v1/audit/verify', {}, fetchFn);
}

export function listCheckpoints(fetchFn?: Fetch): Promise<AuditCheckpointList> {
  return call('/v1/audit/checkpoints', {}, fetchFn);
}

export function createCheckpoint(fetchFn?: Fetch): Promise<AuditCheckpoint> {
  return sendJson('POST', '/v1/audit/checkpoints', {}, null, fetchFn);
}

export function verifyCheckpoint(cp: AuditCheckpoint, fetchFn?: Fetch): Promise<AuditCheckpointVerification> {
  return sendJson('POST', '/v1/audit/checkpoints/verify', cp, null, fetchFn);
}
