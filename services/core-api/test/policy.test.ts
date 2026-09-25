import { describe, expect, it } from 'vitest';
import { MIN_BANK_CHANGE_QUARANTINE_HOURS, PolicySchema, approvalTierFor, parsePolicy, type PolicyInput } from '../src/domain/index.js';

function validPolicy(): PolicyInput {
  return {
    version: 1,
    tenantId: '5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f',
    baseCurrency: 'USD',
    enabledCurrencies: ['USD', 'EUR'],
    matching: { mode: 'three_way', priceToleranceBps: 100, quantityToleranceBps: 0 },
    duplicates: { windowDays: 365, nearMatchMaxEditDistance: 1 },
    vendorBankChange: { quarantineHours: 72, requireCallbackVerification: true },
    approvalTiers: [
      { name: 'clerk', maxAmountMinor: 500_000, approverRole: 'ap_clerk' },
      { name: 'manager', maxAmountMinor: '5000000', approverRole: 'ap_manager' },
      { name: 'cfo', maxAmountMinor: 100_000_000n, approverRole: 'cfo', approvalsRequired: 2 },
    ],
    ai: { extractionConfidenceHoldBelow: 0.9, anomalyScoreHoldAbove: 0.8 },
  };
}

describe('policy schema', () => {
  it('accepts a valid policy and normalizes amounts to bigint', () => {
    const p = parsePolicy(validPolicy());
    expect(p.approvalTiers.map((t) => t.maxAmountMinor)).toEqual([500_000n, 5_000_000n, 100_000_000n]);
    expect(p.approvalTiers[0]?.approvalsRequired).toBe(1);
    expect(p.manualReview).toEqual({ vendorIds: [] });
  });

  it('requires baseCurrency to be enabled', () => {
    const p = { ...validPolicy(), enabledCurrencies: ['EUR'] };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it('rejects duplicate currencies', () => {
    const p = { ...validPolicy(), enabledCurrencies: ['USD', 'USD'] };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it(`refuses a bank-change quarantine shorter than ${MIN_BANK_CHANGE_QUARANTINE_HOURS}h`, () => {
    const p = { ...validPolicy(), vendorBankChange: { quarantineHours: 1, requireCallbackVerification: true as const } };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it('refuses to disable callback verification', () => {
    const p = { ...validPolicy(), vendorBankChange: { quarantineHours: 72, requireCallbackVerification: false } };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it('refuses price tolerance above 10%', () => {
    const p = { ...validPolicy(), matching: { mode: 'three_way' as const, priceToleranceBps: 1001, quantityToleranceBps: 0 } };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it('refuses an AI confidence threshold below 0.5', () => {
    const p = { ...validPolicy(), ai: { extractionConfidenceHoldBelow: 0.2, anomalyScoreHoldAbove: 0.8 } };
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it('requires strictly ascending approval tiers', () => {
    const p = validPolicy();
    p.approvalTiers = [
      { name: 'a', maxAmountMinor: 100, approverRole: 'ap_clerk' },
      { name: 'b', maxAmountMinor: 100, approverRole: 'ap_manager' },
    ];
    const r = PolicySchema.safeParse(p);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('strictly ascending');
  });

  it('rejects negative amounts and non-uuid tenant', () => {
    expect(PolicySchema.safeParse({ ...validPolicy(), tenantId: 'acme' }).success).toBe(false);
    const p = validPolicy();
    p.approvalTiers = [{ name: 'a', maxAmountMinor: -1, approverRole: 'ap_clerk' }];
    expect(PolicySchema.safeParse(p).success).toBe(false);
  });

  it.each([
    [1n, 'clerk'],
    [500_000n, 'clerk'],
    [500_001n, 'manager'],
    [100_000_000n, 'cfo'],
  ])('amount %s routes to tier %s', (amount, tier) => {
    expect(approvalTierFor(parsePolicy(validPolicy()), amount)?.name).toBe(tier);
  });

  it('amounts above every tier have no tier (APPROVAL_LIMIT_EXCEEDED)', () => {
    expect(approvalTierFor(parsePolicy(validPolicy()), 100_000_001n)).toBeUndefined();
  });
});
