import type { AuditCheckpoint, Invoice, Me, PaymentRun, PaymentRunResult, Vendor } from './api';
import { formatMoney } from './format';
import { personaLabel } from './personas';

/**
 * Phase 3 helpers for the approvals, vendor, payment-run and audit screens.
 * The server enforces every rule; these only explain them before a click and
 * hide buttons that cannot work for the current person.
 */

const ROLE_ORDER = ['ap_clerk', 'ap_manager', 'controller', 'cfo'] as const;
type Role = (typeof ROLE_ORDER)[number];

export function covers(roles: readonly string[], need: Role): boolean {
  const n = ROLE_ORDER.indexOf(need);
  return roles.some((r) => ROLE_ORDER.indexOf(r as Role) >= n);
}

// Approvals -------------------------------------------------------------------

/** "1 of 2 approvals" for a pending invoice, or undefined when no tier applies. */
export function approvalProgress(inv: Invoice): { have: number; need: number; text: string } | undefined {
  if (inv.state !== 'PENDING_APPROVAL' || !inv.approvalTier) return undefined;
  const have = (inv.approvals ?? []).filter((a) => a.current).length;
  const need = inv.approvalTier.required;
  return { have, need, text: `${have} of ${need} approval${need === 1 ? '' : 's'}` };
}

/** Who uploaded the invoice and who corrected it, from its history. */
export function dutiesFromHistory(inv: Invoice): { uploader?: string; correctors: Set<string> } {
  const history = inv.history ?? [];
  const uploader = history.find((e) => e.type === 'invoice.received')?.actor.id;
  const correctors = new Set(history.filter((e) => e.type === 'invoice.corrected').map((e) => e.actor.id));
  return { ...(uploader ? { uploader } : {}), correctors };
}

/** Why `me` cannot approve this invoice, or undefined if they may try. */
export function approveBlocker(me: Me | undefined, inv: Invoice): string | undefined {
  if (!me || inv.state !== 'PENDING_APPROVAL') return undefined;
  const tier = inv.approvalTier;
  if (tier && !covers(me.roles, tier.role as Role)) return `This total needs the ${tier.name} tier (role ${tier.role}). Switch to someone with that role.`;
  const { uploader, correctors } = dutiesFromHistory(inv);
  if (uploader === me.userId) return 'You uploaded this invoice, so someone else must approve it.';
  if (correctors.has(me.userId)) return 'You corrected this invoice, so someone else must approve it.';
  if ((inv.approvals ?? []).some((a) => a.current && a.approverId === me.userId)) return 'You have already approved this invoice; it needs another person.';
  return undefined;
}

// Vendors ---------------------------------------------------------------------

export function paymentStatusText(v: Pick<Vendor, 'payment' | 'status'>, now: Date = new Date()): string {
  const p = v.payment;
  if (!p.blocked) return 'Can be paid';
  if (p.reason === 'VENDOR_INACTIVE') return 'Inactive: payments blocked';
  if (p.why === 'UNVERIFIED') return 'Bank change awaiting callback verification';
  if (p.why === 'SELF_VERIFIED') return 'Bank change verified by its requester: blocked';
  if (p.releasesAt) {
    const hours = Math.max(0, Math.ceil((Date.parse(p.releasesAt) - now.getTime()) / 3_600_000));
    return `Bank change in quarantine: releases in ${hours} h`;
  }
  return 'Bank change in quarantine';
}

export function validateLast4(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim().toUpperCase();
  if (!/^[0-9A-Z]{4}$/.test(value)) return { ok: false, error: 'The last 4 letters or digits of the new account' };
  return { ok: true, value };
}

export function validateCallbackNote(raw: string): string | undefined {
  const t = raw.trim();
  if (t.length < 10) return 'Say who you called, on which number from the vendor file, and what they confirmed';
  if (t.length > 2000) return 'At most 2000 characters';
  return undefined;
}

/** SHA-256 of a file's bytes as lowercase hex (the evidence hash sent with a bank change). */
export async function sha256Hex(data: ArrayBuffer, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Payment runs ----------------------------------------------------------------

export const RUN_STATUS_LABEL: Record<PaymentRun['status'], string> = { queued: 'Queued', paid: 'Paid', cancelled: 'Cancelled' };

export function runTotal(run: Pick<PaymentRun, 'total'>): string {
  return formatMoney(run.total.amountMinor, run.total.currency);
}

/** Why `me` cannot confirm this run, or undefined. Mirrors the server: controller+, not the assembler. */
export function confirmBlocker(me: Me | undefined, run: PaymentRun): string | undefined {
  if (run.status !== 'queued') return `The run is ${run.status}.`;
  if (!me) return undefined;
  if (!covers(me.roles, 'controller')) return 'Confirming a payment run needs a controller or CFO.';
  if (me.userId === run.createdBy) return `${personaLabel(run.createdBy)} assembled this run, so someone else must confirm it.`;
  return undefined;
}

export function canAssemble(me: Me | undefined): boolean {
  return !!me && covers(me.roles, 'ap_manager');
}

/** One line on what assembling a run did. */
export function runResultText(r: PaymentRunResult): string {
  const held = r.held.length > 0 ? ` ${r.held.length} held because the vendor cannot be paid now.` : '';
  if (!r.run) return `Nothing to pay.${held}`;
  return `Queued ${r.run.invoiceCount} invoice${r.run.invoiceCount === 1 ? '' : 's'} for ${runTotal(r.run)}.${held}`;
}

// Audit checkpoints -----------------------------------------------------------

const CHECKPOINT_KEYS = ['v', 'tenantId', 'seq', 'hash', 'createdAt', 'keyId', 'statement', 'signature', 'publicKey'] as const;

/** Parse a checkpoint someone pasted back in; the server does the real check. */
export function parseCheckpoint(text: string): { ok: true; checkpoint: AuditCheckpoint } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Paste the checkpoint JSON exactly as it was saved' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'A checkpoint is a JSON object' };
  const o = raw as Record<string, unknown>;
  const missing = CHECKPOINT_KEYS.filter((k) => !(k in o));
  if (missing.length > 0) return { ok: false, error: `Missing ${missing.join(', ')}` };
  if (o['v'] !== 1 || typeof o['seq'] !== 'number' || !Number.isInteger(o['seq'])) return { ok: false, error: 'Not a version 1 checkpoint' };
  const picked = Object.fromEntries(CHECKPOINT_KEYS.map((k) => [k, o[k]]));
  return { ok: true, checkpoint: picked as unknown as AuditCheckpoint };
}

/** The text to save or publish: exactly the fields needed to verify later, pretty-printed. */
export function checkpointText(cp: AuditCheckpoint): string {
  return JSON.stringify(Object.fromEntries(CHECKPOINT_KEYS.map((k) => [k, cp[k]])), null, 2);
}
