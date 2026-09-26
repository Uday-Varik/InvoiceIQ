import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import {
  keyIdOf,
  publicKeyDer,
  signCheckpoint,
  verifyChain,
  verifyCheckpointSignature,
  type AuditEntry,
  type SignedCheckpoint,
} from '../domain/index.js';
import { withTenant, type Db, type Tx } from '../db/pool.js';
import type { Principal } from '../auth/auth.js';
import { requireRole } from '../auth/require.js';
import { HttpProblem } from '../http/problem.js';
import { tenantChain } from '../invoices/audit.js';

/**
 * Signed checkpoints of the audit chain head (ADR-0016). Publishing a
 * checkpoint somewhere the database owner cannot edit (a ticket, an email to
 * the auditors, a public repository) is what makes a wholesale rewrite of the
 * chain detectable: the rewritten chain no longer has the signed hash at the
 * signed seq.
 */

export interface CheckpointSigner {
  readonly key: KeyObject;
  readonly keyId: string;
  /** Base64 DER (SPKI). */
  readonly publicKey: string;
  /** True when the key was generated at boot rather than configured. */
  readonly ephemeral: boolean;
}

export function checkpointSigner(key?: KeyObject): CheckpointSigner {
  const k = key ?? generateKeyPairSync('ed25519').privateKey;
  const der = publicKeyDer(k);
  return { key: k, keyId: keyIdOf(der), publicKey: der.toString('base64'), ephemeral: key === undefined };
}

interface CheckpointRow {
  tenant_id: string;
  seq: string;
  hash: string;
  key_id: string;
  public_key: string;
  signature: string;
  statement: string;
  created_by: string;
  created_at: Date;
}

function toCheckpoint(r: CheckpointRow): SignedCheckpoint & { createdBy: string } {
  return {
    v: 1,
    tenantId: r.tenant_id,
    seq: Number(r.seq),
    hash: r.hash,
    createdAt: r.created_at.toISOString(),
    keyId: r.key_id,
    statement: r.statement,
    signature: r.signature,
    publicKey: r.public_key,
    createdBy: r.created_by,
  };
}

async function storedCheckpoints(tx: Tx, limit?: number): Promise<CheckpointRow[]> {
  const { rows } = await tx.query<CheckpointRow>(
    `SELECT * FROM audit_checkpoints ORDER BY seq DESC${limit ? ' LIMIT $1' : ''}`,
    limit ? [limit] : [],
  );
  return rows;
}

export async function createCheckpoint(db: Db, principal: Principal, signer: CheckpointSigner) {
  requireRole(principal, 'ap_manager', 'signing an audit checkpoint');
  return withTenant(db, principal.tenantId, async (tx) => {
    // Serialise with appenders, so the head cannot move while it is signed.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 42))', [`audit:${principal.tenantId}`]);
    const chain = await tenantChain(tx, principal.tenantId);
    const head = chain.at(-1);
    if (!head) throw new HttpProblem(409, 'Nothing to sign', 'the audit chain is empty', 'CHAIN_EMPTY');
    const result = verifyChain(chain);
    if (!result.ok) {
      throw new HttpProblem(409, 'Audit chain broken', `refusing to sign a broken chain: entry ${result.brokenAt}: ${result.reason}`, 'CHAIN_BROKEN');
    }
    const { rows: existing } = await tx.query<CheckpointRow>('SELECT * FROM audit_checkpoints WHERE seq = $1', [head.seq]);
    if (existing[0]) return { status: 200, body: toCheckpoint(existing[0]) };

    const cp = signCheckpoint({ tenantId: principal.tenantId, seq: head.seq, hash: head.hash, createdAt: new Date().toISOString() }, signer.key);
    await tx.query(
      `INSERT INTO audit_checkpoints (tenant_id, seq, hash, key_id, public_key, signature, statement, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [cp.tenantId, cp.seq, cp.hash, cp.keyId, cp.publicKey, cp.signature, cp.statement, principal.userId, cp.createdAt],
    );
    return { status: 201, body: { ...cp, createdBy: principal.userId } };
  });
}

export async function listCheckpoints(db: Db, principal: Principal, signer: CheckpointSigner, limit: number) {
  return withTenant(db, principal.tenantId, async (tx) => ({
    currentKeyId: signer.keyId,
    currentPublicKey: signer.publicKey,
    items: (await storedCheckpoints(tx, limit)).map(toCheckpoint),
  }));
}

export type ChainCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Does this chain still contain the checkpointed entry, unchanged? */
export function chainMatches(chain: readonly AuditEntry[], seq: number, hash: string): ChainCheck {
  const upTo = chain.slice(0, seq + 1);
  if (upTo.length <= seq) return { ok: false, reason: `the chain has ${chain.length} entries; the checkpoint covers entry ${seq}, so entries were removed` };
  const v = verifyChain(upTo);
  if (!v.ok) return { ok: false, reason: `the chain is broken at entry ${v.brokenAt}: ${v.reason}` };
  if (upTo[seq]?.hash !== hash) return { ok: false, reason: `entry ${seq} has a different hash than the checkpoint: the chain was rewritten` };
  return { ok: true };
}

/**
 * Check a checkpoint someone kept outside the system. `trustedKey` says
 * whether it was signed by this deployment's current key or by a key this
 * tenant has signed checkpoints with before.
 */
export async function verifyExternalCheckpoint(db: Db, principal: Principal, signer: CheckpointSigner, cp: SignedCheckpoint) {
  const sig = verifyCheckpointSignature(cp);
  if (!sig.ok) return { ok: false, reason: sig.reason, trustedKey: false };
  if (cp.tenantId !== principal.tenantId) return { ok: false, reason: 'the checkpoint is for another tenant', trustedKey: false };
  return withTenant(db, principal.tenantId, async (tx) => {
    const known = await tx.query('SELECT 1 FROM audit_checkpoints WHERE key_id = $1 LIMIT 1', [cp.keyId]);
    const trustedKey = cp.keyId === signer.keyId || (known.rowCount ?? 0) > 0;
    const match = chainMatches(await tenantChain(tx, principal.tenantId), cp.seq, cp.hash);
    return match.ok ? { ok: true, trustedKey, seq: cp.seq } : { ok: false, reason: match.reason, trustedKey, seq: cp.seq };
  });
}

/** Stored checkpoints that the current chain contradicts, for the verify endpoint. */
export async function checkpointFindings(tx: Tx, chain: readonly AuditEntry[]): Promise<{ checked: number; failure?: { seq: number; reason: string } }> {
  const rows = await storedCheckpoints(tx);
  for (const r of rows.slice().reverse()) {
    const m = chainMatches(chain, Number(r.seq), r.hash);
    if (!m.ok) return { checked: rows.length, failure: { seq: Number(r.seq), reason: m.reason } };
  }
  return { checked: rows.length };
}
