import { randomUUID } from 'node:crypto';
import { paymentBlock, quarantineStatus, vendorMatchKey, type Actor, type PaymentBlock, type Policy, type VendorStatus } from '../domain/index.js';
import { withTenant, type Db, type Tx } from '../db/pool.js';
import type { Principal } from '../auth/auth.js';
import { requireDifferentPerson, requireRole } from '../auth/require.js';
import { HttpProblem } from '../http/problem.js';
import { idempotent, requestHash, type StoredResponse } from '../http/idempotency.js';
import { enqueue } from '../outbox/enqueue.js';
import { appendAudit } from '../invoices/audit.js';
import { loadPolicy } from '../db/policy.js';
import {
  bankChanges,
  getBankChange,
  getVendor,
  insertBankChange,
  insertVendor,
  latestBankChanges,
  listVendors,
  markBankChangeVerified,
  openInvoiceCounts,
  setVendorStatus,
  toBankChange,
  type BankChangeRow,
  type VendorRow,
} from './store.js';

/**
 * Vendor master and bank-detail changes (runbook: bank-change-quarantine.md).
 * Audit entries for vendors use the vendor id as their subject; the entry
 * type's `vendor.` prefix says what kind of subject it is.
 */

/** Find or register the vendor an invoice names. Auto-registered vendors are audited. */
export async function ensureVendor(tx: Tx, tenantId: string, name: string, actor: Actor): Promise<VendorRow | undefined> {
  const matchKey = vendorMatchKey(name);
  if (!matchKey) return undefined;
  const { row, created } = await insertVendor(tx, { tenantId, id: randomUUID(), name: name.trim().slice(0, 256), matchKey, createdBy: actor.id });
  if (created) {
    await appendAudit(tx, { tenantId, invoiceId: row.id, type: 'vendor.registered', actor, payload: { name: row.name, matchKey } });
  }
  return row;
}

/** Payment blocks for each vendor id, evaluated at `now` against the tenant policy. */
export async function paymentBlocks(tx: Tx, vendorIds: readonly string[], policy: Policy, now: Date): Promise<Map<string, PaymentBlock>> {
  const ids = [...new Set(vendorIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await tx.query<{ id: string; status: VendorStatus }>('SELECT id, status FROM vendors WHERE id = ANY($1::uuid[])', [ids]);
  const latest = await latestBankChanges(tx, ids);
  const hours = policy.vendorBankChange.quarantineHours;
  return new Map(
    rows.map((v) => {
      const change = latest.get(v.id);
      return [v.id, paymentBlock(v.status, change ? toBankChange(change) : undefined, now, hours)];
    }),
  );
}

export function paymentView(block: PaymentBlock) {
  if (!block.blocked) return { blocked: false };
  if (block.reason === 'VENDOR_INACTIVE') return { blocked: true, reason: block.reason };
  return { blocked: true, reason: block.reason, why: block.quarantine.why, releasesAt: block.quarantine.releasesAt };
}

function bankChangeView(r: BankChangeRow) {
  return {
    id: r.id,
    accountLast4: r.account_last4,
    evidenceSha256: r.evidence_sha256,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at.toISOString(),
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at?.toISOString() ?? null,
    callbackNote: r.callback_note,
  };
}

function vendorView(v: VendorRow, block: PaymentBlock | undefined, latest: BankChangeRow | undefined, open: number) {
  return {
    id: v.id,
    name: v.name,
    status: v.status,
    version: v.version,
    bankAccountLast4: latest?.account_last4 ?? null,
    openInvoices: open,
    payment: paymentView(block ?? { blocked: false }),
    createdBy: v.created_by,
    createdAt: v.created_at.toISOString(),
    updatedAt: v.updated_at.toISOString(),
  };
}

async function viewsOf(tx: Tx, vendors: readonly VendorRow[], policy: Policy) {
  const ids = vendors.map((v) => v.id);
  const [blocks, latest, open] = await Promise.all([
    paymentBlocks(tx, ids, policy, new Date()),
    latestBankChanges(tx, ids),
    openInvoiceCounts(tx, ids),
  ]);
  return vendors.map((v) => vendorView(v, blocks.get(v.id), latest.get(v.id), open.get(v.id) ?? 0));
}

export async function readVendors(db: Db, principal: Principal, opts: { q?: string; limit: number }) {
  return withTenant(db, principal.tenantId, async (tx) => ({ items: await viewsOf(tx, await listVendors(tx, opts), await loadPolicy(tx)) }));
}

async function mustVendor(tx: Tx, id: string, forUpdate = false): Promise<VendorRow> {
  const v = await getVendor(tx, id, { forUpdate });
  if (!v) throw new HttpProblem(404, 'Not found', `no vendor ${id}`);
  return v;
}

async function detail(tx: Tx, v: VendorRow) {
  const [view] = await viewsOf(tx, [v], await loadPolicy(tx));
  return { ...view, bankChanges: (await bankChanges(tx, v.id)).map(bankChangeView) };
}

export async function readVendor(db: Db, principal: Principal, id: string) {
  return withTenant(db, principal.tenantId, async (tx) => detail(tx, await mustVendor(tx, id)));
}

export async function createVendor(db: Db, principal: Principal, name: string, key: string): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'ap_clerk', 'registering a vendor');
  const trimmed = name.trim();
  if (!vendorMatchKey(trimmed)) throw new HttpProblem(422, 'Invalid vendor name', 'the name needs at least one letter or digit', 'INVALID_VENDOR');
  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, requestHash(['createVendor', trimmed]), async () => {
      const { row, created } = await insertVendor(tx, {
        tenantId: principal.tenantId,
        id: randomUUID(),
        name: trimmed.slice(0, 256),
        matchKey: vendorMatchKey(trimmed),
        createdBy: principal.userId,
      });
      if (!created) throw new HttpProblem(409, 'Vendor exists', `a vendor with this name already exists: ${row.id}`, 'VENDOR_EXISTS');
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: row.id,
        type: 'vendor.registered',
        actor: { kind: 'human', id: principal.userId },
        payload: { name: row.name, matchKey: row.match_key },
      });
      return { status: 201, body: await detail(tx, row) };
    }),
  );
}

export interface VendorUpdate {
  readonly expectedVersion: number;
  readonly status: VendorStatus;
  readonly comment?: string;
}

export async function updateVendor(db: Db, principal: Principal, id: string, input: VendorUpdate, key: string): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'ap_manager', 'changing a vendor status');
  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, requestHash(['updateVendor', id, JSON.stringify(input)]), async () => {
      const v = await mustVendor(tx, id, true);
      if (v.version !== input.expectedVersion) {
        throw new HttpProblem(409, 'Version conflict', `the vendor is at version ${v.version}; reload and retry`, 'VERSION_CONFLICT');
      }
      if (v.status === input.status) throw new HttpProblem(422, 'No changes', `the vendor is already ${v.status}`, 'NO_CHANGES');
      if (!(await setVendorStatus(tx, id, v.version, input.status))) {
        throw new HttpProblem(409, 'Version conflict', 'the vendor changed while this request was in flight', 'VERSION_CONFLICT');
      }
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: id,
        type: 'vendor.status_changed',
        actor: { kind: 'human', id: principal.userId },
        payload: { from: v.status, to: input.status, ...(input.comment ? { comment: input.comment } : {}) },
      });
      return { status: 200, body: await detail(tx, await mustVendor(tx, id)) };
    }),
  );
}

export interface BankChangeInput {
  readonly ibanOrAccountLast4: string;
  readonly evidenceDocumentSha256: string;
}

async function statusBody(tx: Tx, vendorId: string, change: BankChangeRow) {
  const policy = await loadPolicy(tx);
  const q = quarantineStatus(toBankChange(change), new Date(), policy.vendorBankChange.quarantineHours);
  return {
    vendorId,
    changeId: change.id,
    accountLast4: change.account_last4,
    quarantined: q.quarantined,
    ...(q.quarantined ? { releasesAt: q.releasesAt, why: q.why } : {}),
    requestedBy: change.requested_by,
    requestedAt: change.requested_at.toISOString(),
    verifiedBy: change.verified_by,
    verifiedAt: change.verified_at?.toISOString() ?? null,
  };
}

/**
 * Record a new remittance account. Payments to the vendor stop at once and
 * stay stopped until a different person records the callback verification
 * AND the policy's quarantine window has passed.
 */
export async function requestBankChange(
  db: Db,
  principal: Principal,
  vendorId: string,
  input: BankChangeInput,
  key: string,
): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'ap_clerk', 'recording a bank change');
  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, requestHash(['requestVendorBankChange', vendorId, JSON.stringify(input)]), async () => {
      await mustVendor(tx, vendorId, true);
      const change = await insertBankChange(tx, {
        tenantId: principal.tenantId,
        id: randomUUID(),
        vendorId,
        accountLast4: input.ibanOrAccountLast4,
        evidenceSha256: input.evidenceDocumentSha256,
        requestedBy: principal.userId,
      });
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: vendorId,
        type: 'vendor.bank_change_requested',
        actor: { kind: 'human', id: principal.userId },
        payload: { changeId: change.id, accountLast4: change.account_last4, evidenceSha256: change.evidence_sha256 },
      });
      await enqueue(tx, principal.tenantId, 'vendor.bank_change_requested', { vendorId, changeId: change.id });
      return { status: 202, body: await statusBody(tx, vendorId, change) };
    }),
  );
}

export interface BankChangeVerification {
  readonly callbackNote: string;
}

/** The out-of-band callback, recorded by someone other than the requester. */
export async function verifyBankChange(
  db: Db,
  principal: Principal,
  vendorId: string,
  changeId: string,
  input: BankChangeVerification,
  key: string,
): Promise<StoredResponse & { replayed: boolean }> {
  requireRole(principal, 'ap_manager', 'verifying a bank change');
  return withTenant(db, principal.tenantId, (tx) =>
    idempotent(tx, principal.tenantId, key, requestHash(['verifyVendorBankChange', vendorId, changeId, input.callbackNote]), async () => {
      const change = await getBankChange(tx, vendorId, changeId, { forUpdate: true });
      if (!change) throw new HttpProblem(404, 'Not found', `no bank change ${changeId} for vendor ${vendorId}`);
      requireDifferentPerson(principal, change.requested_by, 'the person who recorded a bank change cannot verify it');
      if (change.verified_by !== null) throw new HttpProblem(409, 'Already verified', `verified by ${change.verified_by}`, 'ALREADY_VERIFIED');
      const latest = (await latestBankChanges(tx, [vendorId])).get(vendorId);
      if (latest && latest.id !== change.id) {
        throw new HttpProblem(409, 'Superseded', 'a newer bank change exists for this vendor; verify that one', 'SUPERSEDED');
      }
      const verified = await markBankChangeVerified(tx, changeId, principal.userId, input.callbackNote.trim());
      if (!verified) throw new HttpProblem(409, 'Already verified', 'the change was verified while this request was in flight', 'ALREADY_VERIFIED');
      await appendAudit(tx, {
        tenantId: principal.tenantId,
        invoiceId: vendorId,
        type: 'vendor.bank_change_verified',
        actor: { kind: 'human', id: principal.userId },
        payload: { changeId, callbackNote: verified.callback_note },
      });
      return { status: 200, body: await statusBody(tx, vendorId, verified) };
    }),
  );
}
