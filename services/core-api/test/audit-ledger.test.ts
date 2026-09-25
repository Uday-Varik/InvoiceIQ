import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, appendEntry, canonicalJson, verifyChain, type AuditEntry, type AuditEvent } from '../src/domain/index.js';

function event(i: number): AuditEvent {
  return {
    tenantId: 't-1',
    invoiceId: `inv-${i % 3}`,
    type: 'STATE_CHANGED',
    actor: { kind: 'system', id: 'worker' },
    occurredAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
    payload: { from: 'RECEIVED', to: 'EXTRACTING', amountMinor: BigInt(i * 100) },
  };
}

function buildChain(n: number): AuditEntry[] {
  const chain: AuditEntry[] = [];
  for (let i = 0; i < n; i++) chain.push(appendEntry(chain, event(i)));
  return chain;
}

describe('canonicalJson', () => {
  it('sorts keys and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [true, null], c: undefined })).toBe('{"a":[true,null],"b":1}');
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ x: { b: 2, a: 1 } })).toBe(canonicalJson({ x: { a: 1, b: 2 } }));
  });

  it('encodes bigint as a string', () => {
    expect(canonicalJson({ v: 10n })).toBe('{"v":"10"}');
  });

  it('rejects non-finite numbers and functions', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe('hash-chained ledger', () => {
  it('starts from the genesis hash', () => {
    const [first] = buildChain(1);
    expect(first?.prevHash).toBe(GENESIS_HASH);
    expect(first?.seq).toBe(0);
    expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each entry to the previous hash', () => {
    const chain = buildChain(5);
    for (let i = 1; i < chain.length; i++) expect(chain[i]?.prevHash).toBe(chain[i - 1]?.hash);
  });

  it('is deterministic', () => {
    expect(buildChain(4).map((e) => e.hash)).toEqual(buildChain(4).map((e) => e.hash));
  });

  it('verifies an untouched chain', () => {
    expect(verifyChain(buildChain(20))).toEqual({ ok: true });
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('detects an edited payload', () => {
    const chain = buildChain(10);
    chain[4] = { ...(chain[4] as AuditEntry), payload: { from: 'RECEIVED', to: 'PAID' } };
    expect(verifyChain(chain)).toMatchObject({ ok: false, brokenAt: 4 });
  });

  it('detects an edited actor', () => {
    const chain = buildChain(3);
    chain[1] = { ...(chain[1] as AuditEntry), actor: { kind: 'human', id: 'mallory' } };
    expect(verifyChain(chain)).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('detects a deleted entry', () => {
    const chain = buildChain(6);
    chain.splice(2, 1);
    expect(verifyChain(chain)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects reordering', () => {
    const chain = buildChain(4);
    const [a, b] = [chain[1] as AuditEntry, chain[2] as AuditEntry];
    chain[1] = b;
    chain[2] = a;
    expect(verifyChain(chain).ok).toBe(false);
  });

  it('detects a rehashed forgery that does not re-link successors', () => {
    const chain = buildChain(5);
    const forged = appendEntry(chain.slice(0, 2), { ...event(2), payload: { forged: true } });
    chain[2] = forged;
    expect(verifyChain(chain)).toMatchObject({ ok: false, brokenAt: 3 });
  });
});
