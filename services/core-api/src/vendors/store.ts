import type { BankChange, VendorStatus } from '../domain/index.js';
import type { Tx } from '../db/pool.js';

export interface VendorRow {
  tenant_id: string;
  id: string;
  name: string;
  match_key: string;
  status: VendorStatus;
  version: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface BankChangeRow {
  tenant_id: string;
  id: string;
  vendor_id: string;
  account_last4: string;
  evidence_sha256: string;
  requested_by: string;
  requested_at: Date;
  verified_by: string | null;
  verified_at: Date | null;
  callback_note: string | null;
}

export function toBankChange(r: BankChangeRow): BankChange {
  return {
    vendorId: r.vendor_id,
    changedAt: r.requested_at.toISOString(),
    changedBy: r.requested_by,
    ...(r.verified_by !== null ? { verifiedBy: r.verified_by } : {}),
    ...(r.verified_at !== null ? { verifiedAt: r.verified_at.toISOString() } : {}),
  };
}

export async function getVendor(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<VendorRow | undefined> {
  const { rows } = await tx.query<VendorRow>(`SELECT * FROM vendors WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0];
}

export async function findVendorByKey(tx: Tx, matchKey: string): Promise<VendorRow | undefined> {
  const { rows } = await tx.query<VendorRow>('SELECT * FROM vendors WHERE match_key = $1', [matchKey]);
  return rows[0];
}

/** Insert unless a vendor with the same match key exists; returns the row and whether it is new. */
export async function insertVendor(
  tx: Tx,
  v: { tenantId: string; id: string; name: string; matchKey: string; createdBy: string },
): Promise<{ row: VendorRow; created: boolean }> {
  const { rows } = await tx.query<VendorRow>(
    `INSERT INTO vendors (tenant_id, id, name, match_key, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, match_key) DO NOTHING RETURNING *`,
    [v.tenantId, v.id, v.name, v.matchKey, v.createdBy],
  );
  if (rows[0]) return { row: rows[0], created: true };
  const existing = await findVendorByKey(tx, v.matchKey);
  if (!existing) throw new Error('vendor insert conflicted but no row is visible');
  return { row: existing, created: false };
}

export async function listVendors(tx: Tx, opts: { q?: string; limit: number }): Promise<VendorRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (opts.q) {
    params.push(`%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where = `WHERE name ILIKE $1 ESCAPE '\\'`;
  }
  params.push(opts.limit);
  const { rows } = await tx.query<VendorRow>(`SELECT * FROM vendors ${where} ORDER BY lower(name), id LIMIT $${params.length}`, params);
  return rows;
}

export async function setVendorStatus(tx: Tx, id: string, expectedVersion: number, status: VendorStatus): Promise<boolean> {
  const res = await tx.query(
    'UPDATE vendors SET status = $3, version = version + 1, updated_at = now() WHERE id = $1 AND version = $2',
    [id, expectedVersion, status],
  );
  return res.rowCount === 1;
}

export async function bankChanges(tx: Tx, vendorId: string): Promise<BankChangeRow[]> {
  const { rows } = await tx.query<BankChangeRow>(
    'SELECT * FROM vendor_bank_changes WHERE vendor_id = $1 ORDER BY requested_at DESC, id DESC',
    [vendorId],
  );
  return rows;
}

/** The latest change of each vendor, keyed by vendor id. */
export async function latestBankChanges(tx: Tx, vendorIds: readonly string[]): Promise<Map<string, BankChangeRow>> {
  if (vendorIds.length === 0) return new Map();
  const { rows } = await tx.query<BankChangeRow>(
    `SELECT DISTINCT ON (vendor_id) * FROM vendor_bank_changes
      WHERE vendor_id = ANY($1::uuid[]) ORDER BY vendor_id, requested_at DESC, id DESC`,
    [vendorIds],
  );
  return new Map(rows.map((r) => [r.vendor_id, r]));
}

export async function getBankChange(tx: Tx, vendorId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<BankChangeRow | undefined> {
  const { rows } = await tx.query<BankChangeRow>(
    `SELECT * FROM vendor_bank_changes WHERE vendor_id = $1 AND id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [vendorId, id],
  );
  return rows[0];
}

export async function insertBankChange(
  tx: Tx,
  c: { tenantId: string; id: string; vendorId: string; accountLast4: string; evidenceSha256: string; requestedBy: string },
): Promise<BankChangeRow> {
  const { rows } = await tx.query<BankChangeRow>(
    `INSERT INTO vendor_bank_changes (tenant_id, id, vendor_id, account_last4, evidence_sha256, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [c.tenantId, c.id, c.vendorId, c.accountLast4, c.evidenceSha256, c.requestedBy],
  );
  if (!rows[0]) throw new Error('bank change insert returned nothing');
  return rows[0];
}

export async function markBankChangeVerified(tx: Tx, id: string, by: string, note: string): Promise<BankChangeRow | undefined> {
  const { rows } = await tx.query<BankChangeRow>(
    `UPDATE vendor_bank_changes SET verified_by = $2, verified_at = now(), callback_note = $3
      WHERE id = $1 AND verified_by IS NULL RETURNING *`,
    [id, by, note],
  );
  return rows[0];
}

/** Count of invoices per vendor that are not yet paid or rejected. */
export async function openInvoiceCounts(tx: Tx, vendorIds: readonly string[]): Promise<Map<string, number>> {
  if (vendorIds.length === 0) return new Map();
  const { rows } = await tx.query<{ vendor_id: string; n: number }>(
    `SELECT vendor_id, count(*)::int AS n FROM invoices
      WHERE vendor_id = ANY($1::uuid[]) AND state NOT IN ('PAID', 'REJECTED') GROUP BY vendor_id`,
    [vendorIds],
  );
  return new Map(rows.map((r) => [r.vendor_id, r.n]));
}

export async function linkInvoiceVendor(tx: Tx, invoiceId: string, vendorId: string | null): Promise<void> {
  await tx.query('UPDATE invoices SET vendor_id = $2 WHERE id = $1', [invoiceId, vendorId]);
}
