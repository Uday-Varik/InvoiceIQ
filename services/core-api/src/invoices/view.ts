import type { AuditEntry, InvoiceState, ReasonCode } from '../domain/index.js';
import type { InvoiceRow } from './store.js';

/** Contract shapes (packages/contracts/openapi/core-api.yaml#/components/schemas/Invoice). */
export interface InvoiceEventView {
  seq: number;
  type: string;
  actor: { kind: 'system' | 'human' | 'ai'; id: string };
  occurredAt: string;
  from?: InvoiceState;
  to?: InvoiceState;
  reasons?: ReasonCode[];
  comment?: string;
}

export function toEvent(e: AuditEntry): InvoiceEventView {
  const p = e.payload as { from?: InvoiceState; to?: InvoiceState; reasons?: ReasonCode[]; comment?: string };
  return {
    seq: e.seq,
    type: e.type,
    actor: e.actor as InvoiceEventView['actor'],
    occurredAt: e.occurredAt,
    ...(p.from ? { from: p.from } : {}),
    ...(p.to ? { to: p.to } : {}),
    ...(p.reasons ? { reasons: p.reasons } : {}),
    ...(p.comment ? { comment: p.comment } : {}),
  };
}

export function toInvoice(row: InvoiceRow, history?: readonly AuditEntry[]) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    state: row.state,
    reasons: row.reasons,
    version: row.version,
    ...(row.vendor_name !== null ? { vendorName: row.vendor_name } : {}),
    ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
    ...(row.invoice_date !== null ? { invoiceDate: row.invoice_date } : {}),
    ...(row.total_minor !== null && row.currency !== null ? { total: { amountMinor: row.total_minor, currency: row.currency } } : {}),
    document: {
      sha256: row.document_sha256,
      contentType: row.document_content_type,
      filename: row.document_filename,
      sizeBytes: row.document_size_bytes,
    },
    ...(row.extraction
      ? { extraction: { provider: row.extraction.provider, extractedAt: row.extraction.extractedAt, fields: row.extraction.fields } }
      : {}),
    ...(history ? { history: history.map(toEvent) } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function encodeCursor(row: InvoiceRow): string {
  return Buffer.from(`${row.cursor_ts}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return { createdAt, id };
}
