/** Phase 3 pure rules: approvals and separation of duties, vendors, payment runs, signed checkpoints, demo personas. */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPROVER_ROLES,
  appendEntry,
  canonicalJson,
  evaluateApproval,
  isApproverRole,
  keyIdOf,
  parsePolicy,
  paymentBlock,
  planPaymentRun,
  publicKeyDer,
  roleCovers,
  seniorRole,
  signCheckpoint,
  statementText,
  tierForInvoice,
  vendorMatchKey,
  verifyCheckpointSignature,
  type ApprovalFacts,
  type ApproverRole,
  type AuditEntry,
  type BankChange,
  type PaymentBlock,
  type PolicyInput,
  type SignedCheckpoint,
} from '../src/domain/index.js';
import { DEMO_PERSONAS, demoAuthenticator, demoPersona, AuthError } from '../src/auth/auth.js';
import { chainMatches, checkpointSigner } from '../src/audit/checkpoints.js';
import { parseCheckpointKey } from '../src/config.js';
import { PAYMENT_FILE_COLUMNS, paymentFileCsv } from '../src/payments/service.js';
import type { PaymentRunRow, RunItemRow } from '../src/payments/store.js';
import { requireDifferentPerson, requireRole } from '../src/auth/require.js';
import { HttpProblem } from '../src/http/problem.js';

const TENANT = '5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f';

function policyInput(): PolicyInput {
  return {
    version: 1,
    tenantId: TENANT,
    baseCurrency: 'USD',
    enabledCurrencies: ['USD', 'EUR'],
    matching: { mode: 'three_way', priceToleranceBps: 100, quantityToleranceBps: 0 },
    duplicates: { windowDays: 365, nearMatchMaxEditDistance: 1 },
    vendorBankChange: { quarantineHours: 72, requireCallbackVerification: true },
    approvalTiers: [
      { name: 'clerk', maxAmountMinor: '100000', approverRole: 'ap_clerk' },
      { name: 'manager', maxAmountMinor: '1000000', approverRole: 'ap_manager' },
      { name: 'controller', maxAmountMinor: '10000000', approverRole: 'controller' },
      { name: 'cfo', maxAmountMinor: '100000000', approverRole: 'cfo', approvalsRequired: 2 },
    ],
    ai: { extractionConfidenceHoldBelow: 0.8, anomalyScoreHoldAbove: 0.8 },
  };
}
const POLICY = parsePolicy(policyInput());

function facts(over: Partial<ApprovalFacts> = {}): ApprovalFacts {
  return {
    policy: POLICY,
    currency: 'USD',
    totalMinor: 123_450n,
    createdBy: 'uploader',
    correctedBy: new Set(),
    prior: [],
    approver: { id: 'maria', roles: ['ap_manager'] },
    ...over,
  };
}

describe('approver roles', () => {
  it('orders roles junior to senior', () => {
    expect(APPROVER_ROLES).toEqual(['ap_clerk', 'ap_manager', 'controller', 'cfo']);
  });

  it.each([
    [['cfo'], 'ap_clerk', true],
    [['cfo'], 'cfo', true],
    [['controller'], 'cfo', false],
    [['ap_clerk', 'controller'], 'ap_manager', true],
    [['ap_clerk'], 'ap_manager', false],
    [[], 'ap_clerk', false],
  ] as Array<[ApproverRole[], ApproverRole, boolean]>)('roles %j cover %s: %s', (roles, need, expected) => {
    expect(roleCovers(roles, need)).toBe(expected);
  });

  it('picks the most senior role, or none', () => {
    expect(seniorRole(['ap_clerk', 'controller', 'ap_manager'])).toBe('controller');
    expect(seniorRole(['cfo'])).toBe('cfo');
    expect(seniorRole([])).toBeUndefined();
  });

  it('recognises only the four roles', () => {
    for (const r of APPROVER_ROLES) expect(isApproverRole(r)).toBe(true);
    for (const r of ['admin', 'CFO', '', null, 3]) expect(isApproverRole(r)).toBe(false);
  });
});

describe('tierForInvoice', () => {
  it.each([
    [0n, 'clerk'],
    [100_000n, 'clerk'],
    [100_001n, 'manager'],
    [1_000_000n, 'manager'],
    [5_000_000n, 'controller'],
    [100_000_000n, 'cfo'],
  ])('%s USD needs the %s tier', (total, name) => {
    expect(tierForInvoice(POLICY, 'USD', total)?.name).toBe(name);
  });

  it('is undefined above every tier', () => {
    expect(tierForInvoice(POLICY, 'USD', 100_000_001n)).toBeUndefined();
  });

  it('a foreign currency needs the top tier whatever the amount (no FX yet)', () => {
    expect(tierForInvoice(POLICY, 'EUR', 1n)?.name).toBe('cfo');
    expect(tierForInvoice(POLICY, 'EUR', 999_999_999n)?.name).toBe('cfo');
  });
});

describe('evaluateApproval', () => {
  it('a manager approves a manager-tier invoice in one step', () => {
    const d = evaluateApproval(facts());
    expect(d).toMatchObject({ ok: true, role: 'ap_manager', count: 1, required: 1, complete: true });
    if (d.ok) expect(d.tier.name).toBe('manager');
  });

  it('records the approver by their most senior role', () => {
    const d = evaluateApproval(facts({ approver: { id: 'x', roles: ['ap_clerk', 'controller'] } }));
    expect(d.ok && d.role).toBe('controller');
  });

  it('refuses when the total is unknown', () => {
    expect(evaluateApproval(facts({ totalMinor: null }))).toMatchObject({ ok: false, code: 'TOTAL_UNKNOWN' });
    expect(evaluateApproval(facts({ currency: null }))).toMatchObject({ ok: false, code: 'TOTAL_UNKNOWN' });
  });

  it('refuses above every tier', () => {
    expect(evaluateApproval(facts({ totalMinor: 200_000_000n, approver: { id: 'c', roles: ['cfo'] } }))).toMatchObject({
      ok: false,
      code: 'APPROVAL_LIMIT_EXCEEDED',
    });
  });

  it('refuses a role below the tier', () => {
    const d = evaluateApproval(facts({ approver: { id: 'a', roles: ['ap_clerk'] } }));
    expect(d).toMatchObject({ ok: false, code: 'ROLE_INSUFFICIENT' });
    if (!d.ok) expect(d.message).toContain('ap_manager');
  });

  it('refuses the uploader, even a CFO', () => {
    expect(evaluateApproval(facts({ createdBy: 'boss', approver: { id: 'boss', roles: ['cfo'] } }))).toMatchObject({ ok: false, code: 'SELF_APPROVAL' });
  });

  it('refuses anyone who corrected the invoice', () => {
    const d = evaluateApproval(facts({ correctedBy: new Set(['maria']) }));
    expect(d).toMatchObject({ ok: false, code: 'CORRECTOR_APPROVAL' });
  });

  it('checks the role before separation of duties, so the message is the useful one', () => {
    expect(evaluateApproval(facts({ createdBy: 'a', approver: { id: 'a', roles: ['ap_clerk'] } }))).toMatchObject({ code: 'ROLE_INSUFFICIENT' });
  });

  it('a CFO-tier invoice needs two different CFOs', () => {
    const first = evaluateApproval(facts({ totalMinor: 50_000_000n, approver: { id: 'c1', roles: ['cfo'] } }));
    expect(first).toMatchObject({ ok: true, count: 1, required: 2, complete: false });
    const again = evaluateApproval(facts({ totalMinor: 50_000_000n, prior: [{ approverId: 'c1', role: 'cfo' }], approver: { id: 'c1', roles: ['cfo'] } }));
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_APPROVED' });
    const second = evaluateApproval(facts({ totalMinor: 50_000_000n, prior: [{ approverId: 'c1', role: 'cfo' }], approver: { id: 'c2', roles: ['cfo'] } }));
    expect(second).toMatchObject({ ok: true, count: 2, required: 2, complete: true });
  });

  it('an earlier approval by a role that no longer covers the tier does not count', () => {
    // A correction raised the total from the manager tier into the cfo tier.
    const d = evaluateApproval(facts({ totalMinor: 50_000_000n, prior: [{ approverId: 'm', role: 'ap_manager' }], approver: { id: 'c1', roles: ['cfo'] } }));
    expect(d).toMatchObject({ ok: true, count: 1, required: 2, complete: false });
  });

  it('extra approvals beyond the requirement still complete', () => {
    const d = evaluateApproval(
      facts({
        prior: [
          { approverId: 'x', role: 'cfo' },
          { approverId: 'y', role: 'cfo' },
        ],
        approver: { id: 'z', roles: ['ap_manager'] },
      }),
    );
    expect(d).toMatchObject({ ok: true, complete: true, count: 3, required: 1 });
  });

  it('a foreign-currency invoice needs the top tier and its two approvals', () => {
    expect(evaluateApproval(facts({ currency: 'EUR', totalMinor: 100n }))).toMatchObject({ ok: false, code: 'ROLE_INSUFFICIENT' });
    expect(evaluateApproval(facts({ currency: 'EUR', totalMinor: 100n, approver: { id: 'c', roles: ['cfo'] } }))).toMatchObject({
      ok: true,
      required: 2,
      complete: false,
    });
  });

  it('never approves on AI say-so: facts carry no AI input at all', () => {
    // The only inputs are policy, amounts, people and prior human approvals.
    expect(Object.keys(facts()).sort()).toEqual(['approver', 'correctedBy', 'createdBy', 'currency', 'policy', 'prior', 'totalMinor']);
  });
});

describe('vendorMatchKey', () => {
  it.each([
    ['ACME Industrial Supply', 'acme industrial supply'],
    ['  Acme   Industrial\tSupply ', 'acme industrial supply'],
    ['ACME, Industrial-Supply.', 'acme industrial supply'],
    ['Müller GmbH', 'müller gmbh'],
    ['ＡＣＭＥ', 'acme'],
    ['O\'Brien & Sons', 'o brien sons'],
  ])('%j -> %j', (name, key) => {
    expect(vendorMatchKey(name)).toBe(key);
  });

  it('keeps legal suffixes, which can mean different payees', () => {
    expect(vendorMatchKey('Acme Ltd')).not.toBe(vendorMatchKey('Acme Inc'));
  });

  it('is empty for names with no letters or digits', () => {
    expect(vendorMatchKey('!!! ---')).toBe('');
  });

  it('caps the key at 256 characters', () => {
    expect(vendorMatchKey('a'.repeat(400))).toHaveLength(256);
  });
});

describe('paymentBlock', () => {
  const now = new Date('2026-05-10T12:00:00Z');
  const change = (over: Partial<BankChange> = {}): BankChange => ({ vendorId: 'v', changedAt: '2026-05-09T12:00:00Z', changedBy: 'clerk', ...over });

  it('an active vendor with no bank change can be paid', () => {
    expect(paymentBlock('active', undefined, now, 72)).toEqual({ blocked: false });
  });

  it('an inactive vendor is blocked whatever its bank state', () => {
    expect(paymentBlock('inactive', undefined, now, 72)).toEqual({ blocked: true, reason: 'VENDOR_INACTIVE' });
  });

  it('an unverified change blocks with no release date', () => {
    expect(paymentBlock('active', change(), now, 72)).toMatchObject({ blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', quarantine: { why: 'UNVERIFIED', releasesAt: null } });
  });

  it('a verified change blocks until the window ends', () => {
    const b = paymentBlock('active', change({ verifiedBy: 'manager', verifiedAt: '2026-05-09T13:00:00Z' }), now, 72);
    expect(b).toMatchObject({ blocked: true, quarantine: { why: 'WINDOW_OPEN', releasesAt: '2026-05-12T12:00:00.000Z' } });
  });

  it('a verified change past its window unblocks', () => {
    expect(paymentBlock('active', change({ changedAt: '2026-05-01T00:00:00Z', verifiedBy: 'manager' }), now, 72)).toEqual({ blocked: false });
  });

  it('a self-verified change never unblocks', () => {
    expect(paymentBlock('active', change({ changedAt: '2026-01-01T00:00:00Z', verifiedBy: 'clerk' }), now, 72)).toMatchObject({ quarantine: { why: 'SELF_VERIFIED' } });
  });
});

describe('planPaymentRun', () => {
  const ok: PaymentBlock = { blocked: false };
  const blocks: Record<string, PaymentBlock> = {
    good: ok,
    off: { blocked: true, reason: 'VENDOR_INACTIVE' },
    q: { blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', quarantine: { quarantined: true, releasesAt: null, why: 'UNVERIFIED' } },
  };
  const c = (id: string, vendorId: string | null, totalMinor: bigint | null = 100n, currency: string | null = 'USD') => ({ id, vendorId, totalMinor, currency });
  const plan = (cs: ReturnType<typeof c>[]) => planPaymentRun('USD', cs, (v) => blocks[v]);

  it('queues payable invoices and sums them', () => {
    const p = plan([c('a', 'good', 100n), c('b', 'good', 250n)]);
    expect(p.queue.map((q) => q.id)).toEqual(['a', 'b']);
    expect(p.totalMinor).toBe(350n);
    expect(p.excluded).toEqual([]);
  });

  it('holds invoices of inactive and quarantined vendors', () => {
    const p = plan([c('a', 'off'), c('b', 'q'), c('c', 'good')]);
    expect(p.queue.map((q) => q.id)).toEqual(['c']);
    expect(p.excluded).toEqual([
      { id: 'a', action: 'hold', reason: 'VENDOR_INACTIVE' },
      { id: 'b', action: 'hold', reason: 'VENDOR_BANK_CHANGE_QUARANTINE' },
    ]);
  });

  it('holds invoices whose vendor is not in the vendor master', () => {
    expect(plan([c('a', 'ghost')]).excluded).toEqual([{ id: 'a', action: 'hold', reason: 'VENDOR_UNKNOWN' }]);
  });

  it('skips (never pays) invoices in another currency or with no total', () => {
    const p = plan([c('a', 'good', 100n, 'EUR'), c('b', 'good', null), c('c', 'good', -5n)]);
    expect(p.queue).toEqual([]);
    expect(p.excluded.map((x) => x.action === 'skip' && x.why)).toEqual(['CURRENCY_MISMATCH', 'TOTAL_UNKNOWN', 'TOTAL_UNKNOWN']);
    expect(p.totalMinor).toBe(0n);
  });

  it('an invoice with no vendor id is held as unknown', () => {
    expect(plan([c('a', null)]).excluded).toEqual([{ id: 'a', action: 'hold', reason: 'VENDOR_UNKNOWN' }]);
  });

  it('keeps the order it was given (oldest due first)', () => {
    expect(plan([c('z', 'good'), c('a', 'good'), c('m', 'good')]).queue.map((q) => q.id)).toEqual(['z', 'a', 'm']);
  });

  it('sums amounts beyond 2^53 exactly', () => {
    expect(plan([c('a', 'good', 2n ** 60n), c('b', 'good', 1n)]).totalMinor).toBe(2n ** 60n + 1n);
  });
});

describe('signed checkpoints', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const base = { tenantId: TENANT, seq: 41, hash: 'a'.repeat(64), createdAt: '2026-05-10T12:00:00.000Z' };
  const cp = signCheckpoint(base, privateKey);

  it('signs a canonical statement of the head', () => {
    expect(cp.v).toBe(1);
    expect(cp.statement).toBe(canonicalJson({ v: 1, tenantId: TENANT, seq: 41, hash: 'a'.repeat(64), createdAt: base.createdAt, keyId: cp.keyId }));
    expect(statementText(cp)).toBe(cp.statement);
    expect(Buffer.from(cp.signature, 'base64')).toHaveLength(64);
  });

  it('the key id is the first 16 hex of SHA-256 over the DER public key', () => {
    expect(cp.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(cp.keyId).toBe(keyIdOf(publicKeyDer(privateKey)));
    expect(cp.publicKey).toBe(publicKeyDer(privateKey).toString('base64'));
  });

  it('verifies', () => {
    expect(verifyCheckpointSignature(cp)).toEqual({ ok: true });
  });

  it('survives a JSON round trip, as a published copy would', () => {
    expect(verifyCheckpointSignature(JSON.parse(JSON.stringify(cp)) as SignedCheckpoint)).toEqual({ ok: true });
  });

  it.each([
    ['seq', { seq: 40 }],
    ['hash', { hash: 'b'.repeat(64) }],
    ['tenant', { tenantId: '00000000-0000-4000-8000-000000000001' }],
    ['time', { createdAt: '2027-01-01T00:00:00.000Z' }],
  ])('a changed %s no longer matches the statement', (_, change) => {
    expect(verifyCheckpointSignature({ ...cp, ...change })).toMatchObject({ ok: false, reason: 'statement does not match the checkpoint fields' });
  });

  it('a re-written statement with the old signature fails the signature', () => {
    const forged = { ...cp, hash: 'b'.repeat(64) };
    const statement = statementText(forged);
    expect(verifyCheckpointSignature({ ...forged, statement })).toMatchObject({ ok: false, reason: 'signature does not verify' });
  });

  it('a signature from another key fails', () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const signature = sign(null, Buffer.from(cp.statement), other).toString('base64');
    expect(verifyCheckpointSignature({ ...cp, signature })).toMatchObject({ ok: false, reason: 'signature does not verify' });
  });

  it('swapping in another public key breaks the key id', () => {
    const other = publicKeyDer(generateKeyPairSync('ed25519').privateKey).toString('base64');
    expect(verifyCheckpointSignature({ ...cp, publicKey: other })).toMatchObject({ ok: false, reason: 'key id does not match the public key' });
  });

  it('rejects garbage keys and non-Ed25519 keys', () => {
    expect(verifyCheckpointSignature({ ...cp, publicKey: 'bm90IGEga2V5' })).toMatchObject({ ok: false, reason: 'public key is not a valid SPKI key' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' });
    expect(verifyCheckpointSignature({ ...cp, publicKey: rsa.toString('base64') })).toMatchObject({ ok: false, reason: 'public key is not Ed25519' });
  });

  it('rejects truncated signatures and unknown versions', () => {
    expect(verifyCheckpointSignature({ ...cp, signature: cp.signature.slice(0, 20) })).toMatchObject({ ok: false });
    expect(verifyCheckpointSignature({ ...cp, v: 2 as 1 })).toMatchObject({ ok: false, reason: 'unsupported checkpoint version 2' });
  });

  it('refuses to sign with a non-Ed25519 key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    expect(() => signCheckpoint(base, rsa)).toThrow(/Ed25519/);
  });

  it('a signer generated at boot is flagged ephemeral; a configured one is not', () => {
    expect(checkpointSigner().ephemeral).toBe(true);
    const s = checkpointSigner(privateKey);
    expect(s.ephemeral).toBe(false);
    expect(s.keyId).toBe(cp.keyId);
  });
});

describe('chainMatches', () => {
  const event = (i: number) => ({
    tenantId: TENANT,
    invoiceId: '11111111-1111-4111-8111-111111111111',
    type: 'invoice.transitioned',
    actor: { kind: 'system', id: 'x' },
    occurredAt: `2026-05-10T12:00:0${i}.000Z`,
    payload: { i },
  });
  const chain: AuditEntry[] = [];
  for (let i = 0; i < 5; i++) chain.push(appendEntry(chain, event(i)));

  it('matches an intact chain at the checkpointed seq', () => {
    expect(chainMatches(chain, 3, chain[3]!.hash)).toEqual({ ok: true });
    expect(chainMatches(chain, 4, chain[4]!.hash)).toEqual({ ok: true });
  });

  it('a later entry being broken does not fail an earlier checkpoint', () => {
    const tampered = chain.map((e, i) => (i === 4 ? { ...e, payload: { i: 99 } } : e));
    expect(chainMatches(tampered, 2, chain[2]!.hash)).toEqual({ ok: true });
  });

  it('detects removed entries', () => {
    const r = chainMatches(chain.slice(0, 3), 4, chain[4]!.hash);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/entries were removed/);
  });

  it('detects a wholesale rewrite that re-hashed everything', () => {
    const rewritten: AuditEntry[] = [];
    for (let i = 0; i < 5; i++) rewritten.push(appendEntry(rewritten, i === 1 ? { ...event(1), payload: { i: 'forged' } } : event(i)));
    const r = chainMatches(rewritten, 3, chain[3]!.hash);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/rewritten/);
  });

  it('detects an edit that did not re-hash', () => {
    const edited = chain.map((e, i) => (i === 1 ? { ...e, payload: { i: 'x' } } : e));
    const r = chainMatches(edited, 3, chain[3]!.hash);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/broken at entry 1/);
  });
});

describe('checkpoint key config', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  it('reads PEM and base64 DER to the same key', () => {
    const a = parseCheckpointKey(pem);
    const b = parseCheckpointKey(der);
    expect(a && keyIdOf(publicKeyDer(a))).toBe(keyIdOf(publicKeyDer(privateKey)));
    expect(b && keyIdOf(publicKeyDer(b))).toBe(keyIdOf(publicKeyDer(privateKey)));
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseCheckpointKey(`\n  ${pem}\n`)).toBeDefined();
  });

  it('rejects other key types and garbage', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(parseCheckpointKey(rsa)).toBeUndefined();
    expect(parseCheckpointKey('not a key')).toBeUndefined();
    expect(parseCheckpointKey('')).toBeUndefined();
  });

  it('round-trips through createPrivateKey, as the runtime does', () => {
    expect(createPrivateKey(pem).asymmetricKeyType).toBe('ed25519');
  });
});

describe('demo personas', () => {
  const base = { tenantId: '00000000-0000-4000-8000-00000000d3e0', userId: 'demo-user', roles: ['cfo'] as ApproverRole[] };
  const auth = demoAuthenticator(base);

  it('offers one persona per duty, and two CFOs for two-person approvals', () => {
    expect(Object.keys(DEMO_PERSONAS)).toEqual(['demo-clerk', 'demo-manager', 'demo-controller', 'demo-cfo', 'demo-deputy-cfo']);
    expect(Object.values(DEMO_PERSONAS).filter((r) => r.includes('cfo'))).toHaveLength(2);
  });

  it('no persona means the base principal', async () => {
    expect(await auth.authenticate(undefined)).toEqual(base);
    expect(await auth.authenticate('Bearer whatever')).toEqual(base);
  });

  it('picks a persona from the Authorization header', async () => {
    expect(await auth.authenticate('Demo demo-manager')).toEqual({ tenantId: base.tenantId, userId: 'demo-manager', roles: ['ap_manager'] });
    expect(await auth.authenticate('demo   demo-clerk ')).toMatchObject({ userId: 'demo-clerk' });
  });

  it('picks a persona from the cookie, so plain links work too', async () => {
    expect(await auth.authenticate(undefined, 'theme=dark; iq_demo_persona=demo-controller; x=1')).toMatchObject({ userId: 'demo-controller', roles: ['controller'] });
  });

  it('the header wins over the cookie', async () => {
    expect(await auth.authenticate('Demo demo-cfo', 'iq_demo_persona=demo-clerk')).toMatchObject({ userId: 'demo-cfo' });
  });

  it('naming the base user explicitly is the base user', async () => {
    expect(await auth.authenticate('Demo demo-user')).toEqual(base);
  });

  it('refuses unknown personas, including prototype keys', async () => {
    await expect(auth.authenticate('Demo root')).rejects.toBeInstanceOf(AuthError);
    await expect(auth.authenticate('Demo constructor')).rejects.toBeInstanceOf(AuthError);
    await expect(auth.authenticate(undefined, 'iq_demo_persona=__proto__')).rejects.toBeInstanceOf(AuthError);
  });

  it('parses the persona without authenticating', () => {
    expect(demoPersona('Demo a', undefined)).toBe('a');
    expect(demoPersona(undefined, 'iq_demo_persona=b%2Dc')).toBe('b-c');
    expect(demoPersona(undefined, 'other=1')).toBeUndefined();
    expect(demoPersona('Bearer x', '')).toBeUndefined();
  });

  it('personas stay in the demo tenant', async () => {
    for (const id of Object.keys(DEMO_PERSONAS)) expect((await auth.authenticate(`Demo ${id}`)).tenantId).toBe(base.tenantId);
  });
});

describe('role and duty checks', () => {
  const p = { tenantId: TENANT, userId: 'u', roles: ['ap_manager'] as ApproverRole[] };

  it('requireRole passes at or above the role and throws 403 below it', () => {
    expect(() => requireRole(p, 'ap_clerk', 'x')).not.toThrow();
    expect(() => requireRole(p, 'ap_manager', 'x')).not.toThrow();
    try {
      requireRole(p, 'controller', 'confirming a payment run');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(HttpProblem);
      expect((e as HttpProblem).status).toBe(403);
      expect((e as HttpProblem).code).toBe('ROLE_INSUFFICIENT');
      expect((e as HttpProblem).detail).toContain('confirming a payment run needs role controller');
    }
  });

  it('requireDifferentPerson throws 403 SEPARATION_OF_DUTIES for the same person only', () => {
    expect(() => requireDifferentPerson(p, 'someone-else', 'x')).not.toThrow();
    expect(() => requireDifferentPerson(p, 'u', 'no')).toThrow(expect.objectContaining({ status: 403, code: 'SEPARATION_OF_DUTIES' }) as Error);
  });
});

describe('payment file', () => {
  const run: PaymentRunRow = {
    tenant_id: TENANT,
    id: '22222222-2222-4222-8222-222222222222',
    currency: 'USD',
    status: 'queued',
    invoice_count: 2,
    total_minor: '123500',
    comment: null,
    created_by: 'm',
    created_at: new Date('2026-05-10T00:00:00Z'),
    closed_by: null,
    closed_at: null,
    close_comment: null,
    version: 1,
  };
  const item = (over: Partial<RunItemRow> = {}): RunItemRow => ({
    run_id: run.id,
    invoice_id: '33333333-3333-4333-8333-333333333333',
    vendor_id: '44444444-4444-4444-8444-444444444444',
    vendor_name: 'ACME Industrial Supply',
    account_last4: '1234',
    bank_change_id: null,
    amount_minor: '123450',
    invoice_number: 'INV-1',
    invoice_date: '2026-03-14',
    due_date: '2026-04-13',
    state: 'PAYMENT_QUEUED',
    ...over,
  });
  const lines = (csv: string) => csv.replace(/^\uFEFF/, '').split('\r\n');

  it('starts with a BOM and a header, one CRLF row per invoice', () => {
    const csv = paymentFileCsv(run, [item(), item({ invoice_id: '55555555-5555-4555-8555-555555555555', amount_minor: '50' })]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const l = lines(csv);
    expect(l[0]).toBe(PAYMENT_FILE_COLUMNS.join(','));
    expect(l).toHaveLength(4);
  });

  it('writes a yen run in whole yen and a dinar run with three decimals', () => {
    const amount = (currency: string) => lines(paymentFileCsv({ ...run, currency }, [item({ amount_minor: '35200' })]))[1]!.split(',')[PAYMENT_FILE_COLUMNS.indexOf('amount')];
    expect([amount('JPY'), amount('BHD'), amount('USD')]).toEqual(['35200', '35.200', '352.00']);
  });

  it('writes amounts as decimals and minor units', () => {
    const row = lines(paymentFileCsv(run, [item()]))[1]!.split(',');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('amount')]).toBe('1234.50');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('amount_minor')]).toBe('123450');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('currency')]).toBe('USD');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('account_last4')]).toBe('1234');
  });

  it('neutralises formulas in vendor names from documents', () => {
    const l = lines(paymentFileCsv(run, [item({ vendor_name: '=HYPERLINK("http://x")' })]));
    expect(l[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  it('leaves unknown account and dates empty', () => {
    const row = lines(paymentFileCsv(run, [item({ account_last4: null, due_date: null, invoice_number: null })]))[1]!.split(',');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('account_last4')]).toBe('');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('due_date')]).toBe('');
    expect(row[PAYMENT_FILE_COLUMNS.indexOf('invoice_number')]).toBe('');
  });

  it('an empty run is just the header', () => {
    expect(lines(paymentFileCsv(run, []))).toEqual([PAYMENT_FILE_COLUMNS.join(','), '']);
  });
});
