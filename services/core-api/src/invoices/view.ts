import type { AuditEntry, InvoiceState, ReasonCode } from '../domain/index.js';
import type { InvoiceRow, LineItemRow } from './store.js';

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
  changes?: Record<string, { from: unknown; to: unknown }>;
}

export function toEvent(e: AuditEntry): InvoiceEventView {
  const p = e.payload as {
    from?: InvoiceState;
    to?: InvoiceState;
    reasons?: ReasonCode[];
    comment?: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
  };
  return {
    seq: e.seq,
    type: e.type,
    actor: e.actor as InvoiceEventView['actor'],
    occurredAt: e.occurredAt,
    ...(p.from ? { from: p.from } : {}),
    ...(p.to ? { to: p.to } : {}),
    ...(p.reasons ? { reasons: p.reasons } : {}),
    ...(p.comment ? { comment: p.comment } : {}),
    ...(p.changes ? { changes: p.changes } : {}),
  };
}

export interface LineItemView {
  position: number;
  description: string;
  quantity?: string;
  unitPriceMinor?: string;
  amountMinor?: string;
}

export function toLineItem(r: LineItemRow): LineItemView {
  return {
    position: r.position,
    description: r.description,
    ...(r.quantity !== null ? { quantity: r.quantity } : {}),
    ...(r.unit_price_minor !== null ? { unitPriceMinor: r.unit_price_minor } : {}),
    ...(r.amount_minor !== null ? { amountMinor: r.amount_minor } : {}),
  };
}

export interface InvoiceViewExtras {
  readonly history?: readonly AuditEntry[];
  readonly lineItems?: readonly LineItemRow[];
  readonly approval?: {
    readonly approvals: ReadonlyArray<{ approverId: string; role: string; approvedAt: string; current: boolean; comment?: string }>;
    readonly approvalTier?: { name: string; role: string; required: number };
  };
}

function money(amountMinor: string | null, currency: string | null) {
  return amountMinor !== null && currency !== null ? { amountMinor, currency } : undefined;
}

export function toInvoice(row: InvoiceRow, extras: InvoiceViewExtras = {}) {
  const total = money(row.total_minor, row.currency);
  const subtotal = money(row.subtotal_minor, row.currency);
  const tax = money(row.tax_minor, row.currency);
  const ex = row.extraction;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    state: row.state,
    reasons: row.reasons,
    version: row.version,
    ...(row.vendor_id !== null ? { vendorId: row.vendor_id } : {}),
    ...(row.vendor_name !== null ? { vendorName: row.vendor_name } : {}),
    ...(row.invoice_number !== null ? { invoiceNumber: row.invoice_number } : {}),
    ...(row.invoice_date !== null ? { invoiceDate: row.invoice_date } : {}),
    ...(row.due_date !== null ? { dueDate: row.due_date } : {}),
    ...(total ? { total } : {}),
    ...(subtotal ? { subtotal } : {}),
    ...(tax ? { tax } : {}),
    ...(extras.lineItems ? { lineItems: extras.lineItems.map(toLineItem) } : {}),
    ...(row.corrected_fields.length > 0 ? { corrections: row.corrected_fields } : {}),
    document: {
      sha256: row.document_sha256,
      contentType: row.document_content_type,
      filename: row.document_filename,
      sizeBytes: row.document_size_bytes,
    },
    ...(ex
      ? {
          extraction: {
            provider: ex.provider,
            extractedAt: ex.extractedAt,
            fields: ex.fields,
            // Phase 1 rows were stored before line items were extracted.
            ...(ex.lineItems ? { lineItems: ex.lineItems } : {}),
          },
        }
      : {}),
    ...(row.payment_run_id !== null ? { paymentRunId: row.payment_run_id } : {}),
    ...(extras.approval ? { approvals: extras.approval.approvals } : {}),
    ...(extras.approval?.approvalTier ? { approvalTier: extras.approval.approvalTier } : {}),
    ...(extras.history ? { history: extras.history.map(toEvent) } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export type InvoiceView = ReturnType<typeof toInvoice>;

export function encodeCursor(row: InvoiceRow): string {
  return Buffer.from(`${row.cursor_ts}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return { createdAt, id };
}
