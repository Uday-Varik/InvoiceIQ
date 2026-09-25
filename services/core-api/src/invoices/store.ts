import type { InvoiceState, ReasonCode } from '../domain/index.js';
import type { Tx } from '../db/pool.js';
import type { ExtractionResult } from '../clients/ai-service.js';

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
  readonly state?: InvoiceState;
  readonly limit: number;
  readonly cursor?: { createdAt: string; id: string };
}

export async function listInvoices(tx: Tx, opts: ListOptions): Promise<InvoiceRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.state) {
    params.push(opts.state);
    where.push(`i.state = $${params.length}`);
  }
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
}

export async function saveExtraction(tx: Tx, id: string, header: ExtractedHeader, extraction: StoredExtraction): Promise<void> {
  await tx.query(
    `UPDATE invoices
        SET vendor_name = $2, invoice_number = $3, invoice_date = $4, currency = $5, total_minor = $6,
            extraction = $7, updated_at = now()
      WHERE id = $1`,
    [
      id,
      header.vendorName,
      header.invoiceNumber,
      header.invoiceDate,
      header.currency,
      header.totalMinor === null ? null : header.totalMinor.toString(),
      JSON.stringify(extraction),
    ],
  );
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
