import type { Tx } from '../db/pool.js';

export type PaymentRunStatus = 'queued' | 'paid' | 'cancelled';

export interface PaymentRunRow {
  tenant_id: string;
  id: string;
  currency: string;
  status: PaymentRunStatus;
  invoice_count: number;
  total_minor: string;
  comment: string | null;
  created_by: string;
  created_at: Date;
  closed_by: string | null;
  closed_at: Date | null;
  close_comment: string | null;
  version: number;
}

export async function insertPaymentRun(
  tx: Tx,
  r: { tenantId: string; id: string; currency: string; invoiceCount: number; totalMinor: bigint; comment: string | undefined; createdBy: string },
): Promise<PaymentRunRow> {
  const { rows } = await tx.query<PaymentRunRow>(
    `INSERT INTO payment_runs (tenant_id, id, currency, invoice_count, total_minor, comment, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [r.tenantId, r.id, r.currency, r.invoiceCount, r.totalMinor.toString(), r.comment ?? null, r.createdBy],
  );
  if (!rows[0]) throw new Error('payment run insert returned nothing');
  return rows[0];
}

export async function getPaymentRun(tx: Tx, id: string, opts: { forUpdate?: boolean } = {}): Promise<PaymentRunRow | undefined> {
  const { rows } = await tx.query<PaymentRunRow>(`SELECT * FROM payment_runs WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0];
}

export async function listPaymentRuns(tx: Tx, opts: { status?: PaymentRunStatus; limit: number }): Promise<PaymentRunRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (opts.status) {
    params.push(opts.status);
    where = 'WHERE status = $1';
  }
  params.push(opts.limit);
  const { rows } = await tx.query<PaymentRunRow>(
    `SELECT * FROM payment_runs ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export async function closePaymentRun(
  tx: Tx,
  id: string,
  expectedVersion: number,
  status: Exclude<PaymentRunStatus, 'queued'>,
  by: string,
  comment: string | undefined,
): Promise<boolean> {
  const res = await tx.query(
    `UPDATE payment_runs SET status = $3, closed_by = $4, closed_at = now(), close_comment = $5, version = version + 1
      WHERE id = $1 AND version = $2 AND status = 'queued'`,
    [id, expectedVersion, status, by, comment ?? null],
  );
  return res.rowCount === 1;
}

export async function assignRun(tx: Tx, invoiceIds: readonly string[], runId: string): Promise<void> {
  if (invoiceIds.length === 0) return;
  await tx.query('UPDATE invoices SET payment_run_id = $2 WHERE id = ANY($1::uuid[])', [invoiceIds, runId]);
}

export interface RunItemRow {
  run_id: string;
  invoice_id: string;
  vendor_id: string;
  vendor_name: string;
  account_last4: string | null;
  bank_change_id: string | null;
  amount_minor: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  state: string;
}

export async function insertRunItems(
  tx: Tx,
  tenantId: string,
  runId: string,
  items: ReadonlyArray<{ invoiceId: string; vendorId: string; accountLast4: string | null; bankChangeId: string | null; amountMinor: bigint }>,
): Promise<void> {
  for (const it of items) {
    await tx.query(
      `INSERT INTO payment_run_items (tenant_id, run_id, invoice_id, vendor_id, account_last4, bank_change_id, amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, runId, it.invoiceId, it.vendorId, it.accountLast4, it.bankChangeId, it.amountMinor.toString()],
    );
  }
}

export async function runItems(tx: Tx, runId: string): Promise<RunItemRow[]> {
  const { rows } = await tx.query<RunItemRow>(
    `SELECT p.run_id, p.invoice_id, p.vendor_id, v.name AS vendor_name, p.account_last4, p.bank_change_id,
            p.amount_minor, i.invoice_number, i.invoice_date, i.due_date, i.state
       FROM payment_run_items p
       JOIN invoices i ON i.id = p.invoice_id
       JOIN vendors v ON v.tenant_id = p.tenant_id AND v.id = p.vendor_id
      WHERE p.run_id = $1
      ORDER BY v.name, i.due_date NULLS LAST, i.invoice_number, p.invoice_id`,
    [runId],
  );
  return rows;
}

export async function clearRun(tx: Tx, runId: string): Promise<void> {
  await tx.query('UPDATE invoices SET payment_run_id = NULL WHERE payment_run_id = $1', [runId]);
}
