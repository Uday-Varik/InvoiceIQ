import { evaluateApproval, tierForInvoice, type ApprovalRefusal, type ApproverRole, type Policy } from '../domain/index.js';
import type { Tx } from '../db/pool.js';
import type { Principal } from '../auth/auth.js';
import { HttpProblem } from '../http/problem.js';
import { appendAudit } from './audit.js';
import { transition } from './lifecycle.js';
import type { InvoiceRow } from './store.js';

export interface ApprovalRow {
  invoice_id: string;
  invoice_version: number;
  approver_id: string;
  approver_role: ApproverRole;
  comment: string | null;
  approved_at: Date;
}

export async function approvalsOf(tx: Tx, invoiceId: string): Promise<ApprovalRow[]> {
  const { rows } = await tx.query<ApprovalRow>(
    'SELECT invoice_id, invoice_version, approver_id, approver_role, comment, approved_at FROM invoice_approvals WHERE invoice_id = $1 ORDER BY approved_at, approver_id',
    [invoiceId],
  );
  return rows;
}

/** Everyone who has corrected the invoice, from the audit ledger (the record that cannot be edited). */
export async function correctorsOf(tx: Tx, invoiceId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ id: string }>(
    "SELECT DISTINCT actor->>'id' AS id FROM audit_log WHERE invoice_id = $1 AND type = 'invoice.corrected'",
    [invoiceId],
  );
  return new Set(rows.map((r) => r.id));
}

const REFUSAL_STATUS: Record<ApprovalRefusal, number> = {
  TOTAL_UNKNOWN: 409,
  APPROVAL_LIMIT_EXCEEDED: 403,
  ROLE_INSUFFICIENT: 403,
  SELF_APPROVAL: 403,
  CORRECTOR_APPROVAL: 403,
  ALREADY_APPROVED: 409,
};

const REFUSAL_TITLE: Record<ApprovalRefusal, string> = {
  TOTAL_UNKNOWN: 'Cannot approve',
  APPROVAL_LIMIT_EXCEEDED: 'Approval limit exceeded',
  ROLE_INSUFFICIENT: 'Insufficient approval authority',
  SELF_APPROVAL: 'Separation of duties',
  CORRECTOR_APPROVAL: 'Separation of duties',
  ALREADY_APPROVED: 'Already approved',
};

/**
 * One person's approval. It is recorded against the invoice's current version;
 * when it is the last one the tier needs, the invoice moves to APPROVED in the
 * same transaction. Otherwise it stays PENDING_APPROVAL for the next approver.
 */
export async function recordApproval(tx: Tx, principal: Principal, inv: InvoiceRow, policy: Policy, comment: string | undefined): Promise<InvoiceRow> {
  if (inv.state !== 'PENDING_APPROVAL') {
    throw new HttpProblem(409, 'Transition refused', `only PENDING_APPROVAL invoices can be approved; this one is ${inv.state}`, 'EDGE_NOT_ALLOWED');
  }
  const all = await approvalsOf(tx, inv.id);
  const prior = all.filter((a) => a.invoice_version === inv.version).map((a) => ({ approverId: a.approver_id, role: a.approver_role }));
  const decision = evaluateApproval({
    policy,
    currency: inv.currency,
    totalMinor: inv.total_minor === null ? null : BigInt(inv.total_minor),
    createdBy: inv.created_by,
    correctedBy: await correctorsOf(tx, inv.id),
    prior,
    approver: { id: principal.userId, roles: principal.roles },
  });
  if (!decision.ok) throw new HttpProblem(REFUSAL_STATUS[decision.code], REFUSAL_TITLE[decision.code], decision.message, decision.code);

  await tx.query(
    `INSERT INTO invoice_approvals (tenant_id, invoice_id, invoice_version, approver_id, approver_role, comment)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [inv.tenant_id, inv.id, inv.version, principal.userId, decision.role, comment ?? null],
  );
  const actor = { kind: 'human', id: principal.userId } as const;
  await appendAudit(tx, {
    tenantId: inv.tenant_id,
    invoiceId: inv.id,
    type: 'invoice.approval_recorded',
    actor,
    payload: {
      tier: decision.tier.name,
      role: decision.role,
      count: decision.count,
      required: decision.required,
      ...(comment ? { comment } : {}),
    },
  });
  if (!decision.complete) return inv;
  const approvers = [...prior.map((p) => p.approverId), principal.userId];
  return transition(tx, inv, {
    to: 'APPROVED',
    actor,
    ...(comment ? { comment } : {}),
    details: { tier: decision.tier.name, approvers },
  });
}

/** What the review screen shows: who approved at which version, and how many the tier needs now. */
export function approvalView(inv: InvoiceRow, rows: readonly ApprovalRow[], policy: Policy | undefined) {
  const approvals = rows.map((a) => ({
    approverId: a.approver_id,
    role: a.approver_role,
    approvedAt: a.approved_at.toISOString(),
    current: a.invoice_version === inv.version,
    ...(a.comment ? { comment: a.comment } : {}),
  }));
  if (inv.state !== 'PENDING_APPROVAL' || policy === undefined || inv.currency === null || inv.total_minor === null) return { approvals };
  const tier = tierForInvoice(policy, inv.currency, BigInt(inv.total_minor));
  if (tier === undefined) return { approvals };
  return { approvals, approvalTier: { name: tier.name, role: tier.approverRole, required: tier.approvalsRequired } };
}
