import type { InvoiceState, ReasonCode } from '../domain/index.js';
import type { Tx } from '../db/pool.js';
import type { ExtractionResult } from '../clients/ai-service.js';
import { filterSql, type InvoiceFilter } from './filters.js';

export type SourceChannel = 'upload' | 'email' | 'api';
export type DocumentContentType = 'application/pdf' | 'image/png' | 'image/jpeg';

export interface StoredExtraction extends ExtractionResult {
  readonly extractedAt: string;
}

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  state: InvoiceState;
  reasons: ReasonCode[];
  version: number;
  source_channel: SourceChannel;
  document_sha256: string;
  document_filename: string;
  document_content_type: DocumentContentType;
  document_size_bytes: number;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  currency: string | null;
  total_minor: string | null;
  due_date: string | null;
  subtotal_minor: string | null;
  tax_minor: string | null;
  corrected_fields: string[];
  vendor_id: string | null;
  payment_run_id: string | null;
  extraction: StoredExtraction | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  /** created_at at full microsecond precision, for keyset pagination. */
  cursor_ts: string;
}

const SELECT_INVOICE = `
  SELECT i.*, d.content_type AS document_content_type, d.size_bytes AS document_size_bytes,
         to_json(i.created_at) #>> '{}' AS cursor_ts
    FROM invoices i
    JOIN documents d ON d.tenant_id = i.tenant_id AND d.sha256 = i.document_sha256`;

export async function getInvoice(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<InvoiceRow | undefined> {
  const { rows } = await tx.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.id = $1${opts.forUpdate ? ' FOR UPDATE OF i' : ''}`, [id]);
  return rows[0];
}

export async function findByDocument(tx: Tx, sha256: string): Promise<InvoiceRow | undefined> {
  const { rows } = await tx.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.document_sha256 = $1`, [sha256]);
  return rows[0];
}

export interface ListOptions {
  readonly filter?: InvoiceFilter;
  readonly limit: number;
  readonly cursor?: { createdAt: string; id: string };
}

export async function listInvoices(tx: Tx, opts: ListOptions): Promise<InvoiceRow[]> {
  const params: unknown[] = [];
  const where = filterSql(opts.filter ?? {}, params);
  if (opts.cursor) {
    params.push(opts.cursor.createdAt, opts.cursor.id);
    where.push(`(i.created_at, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(opts.limit);
  const sql = `${SELECT_INVOICE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.created_at DESC, i.id DESC LIMIT $${params.length}`;
  const { rows } = await tx.query<InvoiceRow>(sql, params);
  return rows;
}

export interface InvoiceSummaryRows {
  readonly byState: ReadonlyArray<{ state: InvoiceState; count: number }>;
  readonly byCurrency: ReadonlyArray<{ currency: string; count: number; amountMinor: string }>;
}

/** Counts per state and exact per-currency sums (numeric, so no bigint overflow), under the same filter as the list. */
export async function summarizeInvoices(tx: Tx, filter: InvoiceFilter): Promise<InvoiceSummaryRows> {
  const params: unknown[] = [];
  const where = filterSql(filter, params);
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const byState = await tx.query<{ state: InvoiceState; count: string }>(
    `SELECT i.state, count(*) AS count FROM invoices i${clause} GROUP BY i.state`,
    params,
  );
  const withTotal = [...where, 'i.total_minor IS NOT NULL', 'i.currency IS NOT NULL'];
  const byCurrency = await tx.query<{ currency: string; count: string; amount_minor: string }>(
    `SELECT i.currency, count(*) AS count, sum(i.total_minor::numeric)::text AS amount_minor
       FROM invoices i WHERE ${withTotal.join(' AND ')} GROUP BY i.currency ORDER BY i.currency`,
    params,
  );
  return {
    byState: byState.rows.map((r) => ({ state: r.state, count: Number(r.count) })),
    byCurrency: byCurrency.rows.map((r) => ({ currency: r.currency, count: Number(r.count), amountMinor: r.amount_minor })),
  };
}

export interface LineItemRow {
  invoice_id: string;
  position: number;
  description: string;
  /** numeric(16,4) as text, trailing zeros trimmed by the query. */
  quantity: string | null;
  unit_price_minor: string | null;
  amount_minor: string | null;
}

const SELECT_LINES = `
  SELECT invoice_id, position, description,
         CASE WHEN quantity IS NULL THEN NULL ELSE trim_scale(quantity)::text END AS quantity,
         unit_price_minor, amount_minor
    FROM invoice_line_items`;

export async function getLineItems(tx: Tx, invoiceId: string): Promise<LineItemRow[]> {
  const { rows } = await tx.query<LineItemRow>(`${SELECT_LINES} WHERE invoice_id = $1 ORDER BY position`, [invoiceId]);
  return rows;
}

/** Lines of many invoices in one query, grouped by invoice id (for exports). */
export async function getLineItemsFor(tx: Tx, invoiceIds: readonly string[]): Promise<Map<string, LineItemRow[]>> {
  const out = new Map<string, LineItemRow[]>();
  if (invoiceIds.length === 0) return out;
  const { rows } = await tx.query<LineItemRow>(`${SELECT_LINES} WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_id, position`, [
    invoiceIds,
  ]);
  for (const r of rows) {
    const list = out.get(r.invoice_id) ?? [];
    list.push(r);
    out.set(r.invoice_id, list);
  }
  return out;
}

export interface LineItemInput {
  readonly description: string;
  readonly quantity: string | null;
  readonly unitPriceMinor: string | null;
  readonly amountMinor: string | null;
}

/** Replace every line of one invoice. Positions are 1-based and follow array order. */
export async function replaceLineItems(tx: Tx, tenantId: string, invoiceId: string, lines: readonly LineItemInput[]): Promise<void> {
  await tx.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  if (lines.length === 0) return;
  const params: unknown[] = [];
  const values = lines.map((l, i) => {
    params.push(tenantId, invoiceId, i + 1, l.description, l.quantity, l.unitPriceMinor, l.amountMinor);
    const b = params.length - 7;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::numeric, $${b + 6}::bigint, $${b + 7}::bigint)`;
  });
  await tx.query(
    `INSERT INTO invoice_line_items (tenant_id, invoice_id, position, description, quantity, unit_price_minor, amount_minor)
     VALUES ${values.join(', ')}`,
    params,
  );
}

export async function insertDocument(
  tx: Tx,
  doc: { tenantId: string; sha256: string; contentType: DocumentContentType; content: Buffer },
): Promise<void> {
  await tx.query(
    `INSERT INTO documents (tenant_id, sha256, content_type, size_bytes, content)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, sha256) DO NOTHING`,
    [doc.tenantId, doc.sha256, doc.contentType, doc.content.length, doc.content],
  );
}

export async function getDocument(tx: Tx, sha256: string): Promise<{ contentType: DocumentContentType; content: Buffer } | undefined> {
  const { rows } = await tx.query<{ content_type: DocumentContentType; content: Buffer }>(
    'SELECT content_type, content FROM documents WHERE sha256 = $1',
    [sha256],
  );
  const row = rows[0];
  return row ? { contentType: row.content_type, content: row.content } : undefined;
}

export async function insertInvoice(
  tx: Tx,
  inv: { id: string; tenantId: string; sourceChannel: SourceChannel; documentSha256: string; filename: string; createdBy: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO invoices (id, tenant_id, state, source_channel, document_sha256, document_filename, created_by)
     VALUES ($1, $2, 'RECEIVED', $3, $4, $5, $6)`,
    [inv.id, inv.tenantId, inv.sourceChannel, inv.documentSha256, inv.filename, inv.createdBy],
  );
}

export interface ExtractedHeader {
  readonly vendorName: string | null;
  readonly invoiceNumber: string | null;
  readonly invoiceDate: string | null;
  readonly currency: string | null;
  readonly totalMinor: bigint | null;
  readonly subtotalMinor: bigint | null;
  readonly taxMinor: bigint | null;
  readonly dueDate: string | null;
}

const minorText = (v: bigint | null) => (v === null ? null : v.toString());

export async function saveExtraction(tx: Tx, id: string, header: ExtractedHeader, extraction: StoredExtraction): Promise<void> {
  await tx.query(
    `UPDATE invoices
        SET vendor_name = $2, invoice_number = $3, invoice_date = $4, currency = $5, total_minor = $6,
            subtotal_minor = $7, tax_minor = $8, due_date = $9, extraction = $10, updated_at = now()
      WHERE id = $1`,
    [
      id,
      header.vendorName,
      header.invoiceNumber,
      header.invoiceDate,
      header.currency,
      minorText(header.totalMinor),
      minorText(header.subtotalMinor),
      minorText(header.taxMinor),
      header.dueDate,
      JSON.stringify(extraction),
    ],
  );
}

/** The row's current header, as the validator sees it (after any human corrections). */
export function headerOf(row: InvoiceRow): ExtractedHeader {
  const big = (v: string | null) => (v === null ? null : BigInt(v));
  return {
    vendorName: row.vendor_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    currency: row.currency,
    totalMinor: big(row.total_minor),
    subtotalMinor: big(row.subtotal_minor),
    taxMinor: big(row.tax_minor),
    dueDate: row.due_date,
  };
}

/** Column values a correction writes. Every key present is written; absent keys keep their value. */
export interface HeaderUpdate {
  vendor_name?: string;
  invoice_number?: string;
  invoice_date?: string;
  due_date?: string | null;
  currency?: string;
  total_minor?: string;
  subtotal_minor?: string | null;
  tax_minor?: string | null;
}

const UPDATABLE: ReadonlyArray<keyof HeaderUpdate> = [
  'vendor_name',
  'invoice_number',
  'invoice_date',
  'due_date',
  'currency',
  'total_minor',
  'subtotal_minor',
  'tax_minor',
];

/**
 * Apply a reviewer's correction with compare-and-set on version. The version
 * bumps, so a second reviewer holding the old version gets a conflict instead
 * of silently overwriting.
 */
export async function applyCorrection(
  tx: Tx,
  id: string,
  expectedVersion: number,
  update: HeaderUpdate,
  correctedFields: readonly string[],
): Promise<boolean> {
  const params: unknown[] = [id, expectedVersion, correctedFields];
  const sets = ['version = version + 1', 'updated_at = now()', 'corrected_fields = ARRAY(SELECT DISTINCT unnest(corrected_fields || $3::text[]) ORDER BY 1)'];
  for (const col of UPDATABLE) {
    if (!(col in update)) continue;
    params.push(update[col]);
    sets.push(`${col} = $${params.length}`);
  }
  const res = await tx.query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $1 AND version = $2`, params);
  return res.rowCount === 1;
}

/** Compare-and-set on version, so two writers can never both apply a transition. */
export async function updateState(
  tx: Tx,
  id: string,
  expectedVersion: number,
  to: InvoiceState,
  reasons: readonly ReasonCode[],
): Promise<boolean> {
  const res = await tx.query(
    `UPDATE invoices SET state = $3, reasons = $4, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2`,
    [id, expectedVersion, to, reasons],
  );
  return res.rowCount === 1;
}

/** Approved invoices in one currency, oldest due first, locked for a payment run. */
export async function lockApproved(tx: Tx, currency: string, ids: readonly string[] | undefined, limit: number): Promise<InvoiceRow[]> {
  const params: unknown[] = [currency, limit];
  const byId = ids === undefined ? '' : ` AND i.id = ANY($3::uuid[])`;
  if (ids !== undefined) params.push(ids);
  const { rows } = await tx.query<InvoiceRow>(
    `${SELECT_INVOICE} WHERE i.state = 'APPROVED' AND i.currency = $1${byId}
      ORDER BY i.due_date NULLS LAST, i.created_at, i.id LIMIT $2 FOR UPDATE OF i`,
    params,
  );
  return rows;
}

/** The invoices a payment run currently holds, locked. */
export async function lockRunInvoices(tx: Tx, runId: string): Promise<InvoiceRow[]> {
  const { rows } = await tx.query<InvoiceRow>(`${SELECT_INVOICE} WHERE i.payment_run_id = $1 ORDER BY i.id FOR UPDATE OF i`, [runId]);
  return rows;
}
