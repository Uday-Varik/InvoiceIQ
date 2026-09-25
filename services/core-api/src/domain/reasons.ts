/**
 * The 18-code reason catalog.
 *
 * Every hold, exception or rejection carries one or more reason codes. A reason is
 * either `deterministic` (computed by rules the tenant can audit) or `ai`
 * (produced by the ai-service). AI-derived reasons are structurally locked to
 * HOLD: their type only admits `allowedOutcomes: readonly ['HOLD']`, so the
 * compiler rejects a catalog entry that lets an AI signal reject, raise an
 * exception, or (worse) approve. See ADR-0007.
 */

export type ReasonOutcome = 'HOLD' | 'EXCEPTION' | 'REJECTED';
export type Severity = 'low' | 'medium' | 'high' | 'critical';

interface ReasonBase {
  readonly description: string;
  readonly severity: Severity;
}

export interface DeterministicReason extends ReasonBase {
  readonly source: 'deterministic';
  readonly allowedOutcomes: readonly [ReasonOutcome, ...ReasonOutcome[]];
}

export interface AiReason extends ReasonBase {
  readonly source: 'ai';
  readonly allowedOutcomes: readonly ['HOLD'];
}

export type ReasonDefinition = DeterministicReason | AiReason;

const DETERMINISTIC_REASONS = {
  MATCH_PRICE_VARIANCE: {
    source: 'deterministic',
    severity: 'medium',
    allowedOutcomes: ['HOLD', 'EXCEPTION'],
    description: 'Invoice unit price differs from the purchase order beyond the tenant tolerance.',
  },
  MATCH_QUANTITY_VARIANCE: {
    source: 'deterministic',
    severity: 'medium',
    allowedOutcomes: ['HOLD', 'EXCEPTION'],
    description: 'Invoiced quantity exceeds the received quantity beyond the tenant tolerance.',
  },
  MATCH_PO_NOT_FOUND: {
    source: 'deterministic',
    severity: 'high',
    allowedOutcomes: ['EXCEPTION', 'REJECTED'],
    description: 'The referenced purchase order does not exist for this tenant.',
  },
  MATCH_RECEIPT_MISSING: {
    source: 'deterministic',
    severity: 'medium',
    allowedOutcomes: ['HOLD', 'EXCEPTION'],
    description: 'No goods receipt exists for one or more purchase order lines.',
  },
  DUPLICATE_EXACT: {
    source: 'deterministic',
    severity: 'critical',
    allowedOutcomes: ['HOLD', 'REJECTED'],
    description: 'Same vendor, normalized invoice number and amount as an existing invoice.',
  },
  DUPLICATE_NEAR: {
    source: 'deterministic',
    severity: 'high',
    allowedOutcomes: ['HOLD'],
    description: 'Same vendor and amount within the duplicate window with a similar invoice number.',
  },
  VENDOR_BANK_CHANGE_QUARANTINE: {
    source: 'deterministic',
    severity: 'critical',
    allowedOutcomes: ['HOLD'],
    description: 'Vendor bank details changed and are inside the quarantine window.',
  },
  VENDOR_UNKNOWN: {
    source: 'deterministic',
    severity: 'high',
    allowedOutcomes: ['EXCEPTION', 'REJECTED'],
    description: 'The vendor is not in the tenant vendor master.',
  },
  VENDOR_INACTIVE: {
    source: 'deterministic',
    severity: 'high',
    allowedOutcomes: ['HOLD', 'REJECTED'],
    description: 'The vendor exists but is deactivated or blocked.',
  },
  VALIDATION_MISSING_FIELD: {
    source: 'deterministic',
    severity: 'medium',
    allowedOutcomes: ['EXCEPTION'],
    description: 'A required header field is missing after extraction.',
  },
  VALIDATION_TOTALS_MISMATCH: {
    source: 'deterministic',
    severity: 'high',
    allowedOutcomes: ['EXCEPTION', 'REJECTED'],
    description: 'Line totals plus tax do not equal the invoice total.',
  },
  VALIDATION_CURRENCY_UNSUPPORTED: {
    source: 'deterministic',
    severity: 'medium',
    allowedOutcomes: ['EXCEPTION', 'REJECTED'],
    description: 'Invoice currency is not enabled in the tenant policy.',
  },
  APPROVAL_LIMIT_EXCEEDED: {
    source: 'deterministic',
    severity: 'high',
    allowedOutcomes: ['HOLD'],
    description: 'Invoice amount exceeds the highest approval tier in the tenant policy.',
  },
  POLICY_MANUAL_REVIEW_REQUIRED: {
    source: 'deterministic',
    severity: 'low',
    allowedOutcomes: ['HOLD'],
    description: 'Tenant policy requires manual review for this vendor, amount or category.',
  },
} as const satisfies Record<string, DeterministicReason>;

const AI_REASONS = {
  AI_EXTRACTION_LOW_CONFIDENCE: {
    source: 'ai',
    severity: 'medium',
    allowedOutcomes: ['HOLD'],
    description: 'Extraction confidence for a money-bearing field is below the policy threshold.',
  },
  AI_ANOMALY_SUSPECTED: {
    source: 'ai',
    severity: 'medium',
    allowedOutcomes: ['HOLD'],
    description: 'The invoice is unusual for this vendor (amount, cadence or line mix).',
  },
  AI_DOCUMENT_TAMPERING_SUSPECTED: {
    source: 'ai',
    severity: 'high',
    allowedOutcomes: ['HOLD'],
    description: 'The document shows signs of editing (fonts, overlays, metadata inconsistencies).',
  },
  AI_SEMANTIC_DUPLICATE_SUSPECTED: {
    source: 'ai',
    severity: 'high',
    allowedOutcomes: ['HOLD'],
    description: 'The invoice is semantically similar to an existing invoice despite differing identifiers.',
  },
} as const satisfies Record<string, AiReason>;

export const REASON_CATALOG = { ...DETERMINISTIC_REASONS, ...AI_REASONS } as const;

export type DeterministicReasonCode = keyof typeof DETERMINISTIC_REASONS;
export type AiReasonCode = keyof typeof AI_REASONS;
export type ReasonCode = DeterministicReasonCode | AiReasonCode;

export const REASON_CODES = Object.keys(REASON_CATALOG) as ReasonCode[];
export const AI_REASON_CODES = Object.keys(AI_REASONS) as AiReasonCode[];
export const DETERMINISTIC_REASON_CODES = Object.keys(DETERMINISTIC_REASONS) as DeterministicReasonCode[];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && Object.hasOwn(REASON_CATALOG, value);
}

export function isAiReason(code: ReasonCode): code is AiReasonCode {
  return REASON_CATALOG[code].source === 'ai';
}

export function reasonAllows(code: ReasonCode, outcome: ReasonOutcome): boolean {
  return (REASON_CATALOG[code].allowedOutcomes as readonly ReasonOutcome[]).includes(outcome);
}
