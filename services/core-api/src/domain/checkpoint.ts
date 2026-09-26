import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson } from './audit-ledger.js';

/**
 * Signed audit checkpoints (ADR-0016). A checkpoint is an Ed25519-signed
 * statement of one tenant's chain head: "entry `seq` has hash `hash`". Anyone
 * holding a copy made earlier can later prove the chain was not rewritten,
 * because a rewrite changes the hash at that seq and the signature cannot be
 * forged without the key. The statement is canonical JSON, so it can be
 * re-verified with nothing but the public key.
 */

export const CHECKPOINT_VERSION = 1;

export interface CheckpointStatement {
  readonly v: typeof CHECKPOINT_VERSION;
  readonly tenantId: string;
  readonly seq: number;
  readonly hash: string;
  readonly createdAt: string;
  readonly keyId: string;
}

export interface SignedCheckpoint extends CheckpointStatement {
  /** Canonical JSON of the statement: exactly the bytes that were signed. */
  readonly statement: string;
  /** Base64 Ed25519 signature over `statement`. */
  readonly signature: string;
  /** Base64 DER (SPKI) public key. */
  readonly publicKey: string;
}

export function publicKeyDer(key: KeyObject): Buffer {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return pub.export({ type: 'spki', format: 'der' });
}

/** First 16 hex digits of the SHA-256 of the DER public key. */
export function keyIdOf(publicKeyDerBytes: Buffer): string {
  return createHash('sha256').update(publicKeyDerBytes).digest('hex').slice(0, 16);
}

export function statementText(s: CheckpointStatement): string {
  const { v, tenantId, seq, hash, createdAt, keyId } = s;
  return canonicalJson({ v, tenantId, seq, hash, createdAt, keyId });
}

export function signCheckpoint(input: Omit<CheckpointStatement, 'v' | 'keyId'>, privateKey: KeyObject): SignedCheckpoint {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('checkpoint keys must be Ed25519');
  const der = publicKeyDer(privateKey);
  const stmt: CheckpointStatement = { v: CHECKPOINT_VERSION, ...input, keyId: keyIdOf(der) };
  const statement = statementText(stmt);
  const signature = sign(null, Buffer.from(statement, 'utf8'), privateKey).toString('base64');
  return { ...stmt, statement, signature, publicKey: der.toString('base64') };
}

export type CheckpointCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Checks a checkpoint on its own terms: the statement matches its fields, the
 * key id matches the key, and the signature verifies. It does NOT say the key
 * is one you trust: compare `keyId` with the one you pinned.
 */
export function verifyCheckpointSignature(cp: SignedCheckpoint): CheckpointCheck {
  if (cp.v !== CHECKPOINT_VERSION) return { ok: false, reason: `unsupported checkpoint version ${String(cp.v)}` };
  if (statementText(cp) !== cp.statement) return { ok: false, reason: 'statement does not match the checkpoint fields' };
  let der: Buffer;
  let key: KeyObject;
  try {
    der = Buffer.from(cp.publicKey, 'base64');
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, reason: 'public key is not a valid SPKI key' };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: 'public key is not Ed25519' };
  if (keyIdOf(der) !== cp.keyId) return { ok: false, reason: 'key id does not match the public key' };
  const sig = Buffer.from(cp.signature, 'base64');
  if (sig.length !== 64 || !verify(null, Buffer.from(cp.statement, 'utf8'), key, sig)) {
    return { ok: false, reason: 'signature does not verify' };
  }
  return { ok: true };
}
