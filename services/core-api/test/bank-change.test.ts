import { describe, expect, it } from 'vitest';
import { quarantineStatus, type BankChange } from '../src/domain/index.js';

const change: BankChange = { vendorId: 'v1', changedAt: '2026-05-01T12:00:00Z', changedBy: 'alice' };
const at = (iso: string) => new Date(iso);

describe('vendor bank-change quarantine', () => {
  it('is clear when there is no change', () => {
    expect(quarantineStatus(undefined, at('2026-05-01T12:00:00Z'), 72)).toEqual({ quarantined: false });
  });

  it('holds an unverified change indefinitely', () => {
    expect(quarantineStatus(change, at('2027-01-01T00:00:00Z'), 72)).toMatchObject({ quarantined: true, why: 'UNVERIFIED' });
  });

  it('holds a self-verified change (no four-eyes)', () => {
    const c = { ...change, verifiedBy: 'alice', verifiedAt: '2026-05-01T13:00:00Z' };
    expect(quarantineStatus(c, at('2027-01-01T00:00:00Z'), 72)).toMatchObject({ quarantined: true, why: 'SELF_VERIFIED' });
  });

  it('holds a verified change until the window elapses', () => {
    const c = { ...change, verifiedBy: 'bob', verifiedAt: '2026-05-01T13:00:00Z' };
    expect(quarantineStatus(c, at('2026-05-04T11:59:59Z'), 72)).toEqual({
      quarantined: true,
      releasesAt: '2026-05-04T12:00:00.000Z',
      why: 'WINDOW_OPEN',
    });
  });

  it('releases a verified change once the window has elapsed', () => {
    const c = { ...change, verifiedBy: 'bob', verifiedAt: '2026-05-01T13:00:00Z' };
    expect(quarantineStatus(c, at('2026-05-04T12:00:00Z'), 72)).toEqual({ quarantined: false });
  });
});
