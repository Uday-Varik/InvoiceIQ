import { z } from 'zod';

/**
 * Per-tenant payment-safety policy. Validated at write time and again at load
 * time, so a hand-edited row cannot weaken a control past its floor.
 */

const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code');
const minorUnits = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^\d+$/)])
  .transform((v) => BigInt(v))
  .refine((v) => v >= 0n, 'must be non-negative');

export const MIN_BANK_CHANGE_QUARANTINE_HOURS = 24;
export const MAX_PRICE_TOLERANCE_BPS = 1_000; // 10 %

export const ApprovalTierSchema = z.object({
  name: z.string().min(1),
  maxAmountMinor: minorUnits,
  approverRole: z.enum(['ap_clerk', 'ap_manager', 'controller', 'cfo']),
  approvalsRequired: z.number().int().min(1).max(3).default(1),
});

export const PolicySchema = z
  .object({
    version: z.literal(1),
    tenantId: z.uuid(),
    baseCurrency: currencyCode,
    enabledCurrencies: z.array(currencyCode).min(1),
    matching: z.object({
      mode: z.enum(['two_way', 'three_way']).default('three_way'),
      priceToleranceBps: z.number().int().min(0).max(MAX_PRICE_TOLERANCE_BPS),
      quantityToleranceBps: z.number().int().min(0).max(MAX_PRICE_TOLERANCE_BPS),
    }),
    duplicates: z.object({
      windowDays: z.number().int().min(1).max(730),
      nearMatchMaxEditDistance: z.number().int().min(0).max(3).default(1),
    }),
    vendorBankChange: z.object({
      quarantineHours: z.number().int().min(MIN_BANK_CHANGE_QUARANTINE_HOURS).max(24 * 30),
      requireCallbackVerification: z.literal(true),
    }),
    approvalTiers: z.array(ApprovalTierSchema).min(1),
    ai: z.object({
      extractionConfidenceHoldBelow: z.number().min(0.5).max(1),
      anomalyScoreHoldAbove: z.number().min(0).max(1),
    }),
    manualReview: z
      .object({
        vendorIds: z.array(z.uuid()).default([]),
        amountAtLeastMinor: minorUnits.optional(),
      })
      .default({ vendorIds: [] }),
  })
  .superRefine((p, ctx) => {
    if (!p.enabledCurrencies.includes(p.baseCurrency)) {
      ctx.addIssue({ code: 'custom', path: ['enabledCurrencies'], message: 'must include baseCurrency' });
    }
    if (new Set(p.enabledCurrencies).size !== p.enabledCurrencies.length) {
      ctx.addIssue({ code: 'custom', path: ['enabledCurrencies'], message: 'must not contain duplicates' });
    }
    for (let i = 1; i < p.approvalTiers.length; i++) {
      const prev = p.approvalTiers[i - 1];
      const cur = p.approvalTiers[i];
      if (prev !== undefined && cur !== undefined && cur.maxAmountMinor <= prev.maxAmountMinor) {
        ctx.addIssue({
          code: 'custom',
          path: ['approvalTiers', i, 'maxAmountMinor'],
          message: 'approval tiers must be strictly ascending by maxAmountMinor',
        });
      }
    }
  });

export type Policy = z.output<typeof PolicySchema>;
export type PolicyInput = z.input<typeof PolicySchema>;
export type ApprovalTier = z.output<typeof ApprovalTierSchema>;

export function parsePolicy(input: unknown): Policy {
  return PolicySchema.parse(input);
}

/** The lowest tier whose ceiling covers the amount, or undefined if above every tier. */
export function approvalTierFor(policy: Policy, amountMinor: bigint): ApprovalTier | undefined {
  return policy.approvalTiers.find((t) => amountMinor <= t.maxAmountMinor);
}
