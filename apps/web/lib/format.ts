import type { InvoiceState } from './api';

/** Format integer minor units without ever going through a float. Assumes 2 decimals (no JPY-style currencies yet). */
export function formatMoney(amountMinor: string, currency: string): string {
  const neg = amountMinor.startsWith('-');
  const digits = (neg ? amountMinor.slice(1) : amountMinor).padStart(3, '0');
  const whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${whole}.${digits.slice(-2)} ${currency}`;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

/** States the pipeline moves through on its own; the review page keeps polling while in them. */
export const IN_FLIGHT: ReadonlySet<InvoiceState> = new Set<InvoiceState>([
  'RECEIVED',
  'EXTRACTING',
  'EXTRACTED',
  'VALIDATING',
  'VALIDATED',
  'MATCHING',
  'MATCHED',
]);

export type ReviewAction = 'approve' | 'reject' | 'sendToApproval';

/** What a reviewer can do from each state. The server's gate is the authority; this only hides dead buttons. */
export function actionsFor(state: InvoiceState): ReviewAction[] {
  switch (state) {
    case 'PENDING_APPROVAL':
      return ['approve', 'reject'];
    case 'HOLD':
      return ['sendToApproval', 'reject'];
    case 'EXCEPTION':
      return ['reject'];
    default:
      return [];
  }
}

export const STATE_LABEL: Record<InvoiceState, string> = {
  RECEIVED: 'Received',
  EXTRACTING: 'Extracting',
  EXTRACTED: 'Extracted',
  VALIDATING: 'Validating',
  VALIDATED: 'Validated',
  MATCHING: 'Matching',
  MATCHED: 'Matched',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  HOLD: 'On hold',
  EXCEPTION: 'Exception',
  PAYMENT_QUEUED: 'Payment queued',
  PAID: 'Paid',
};
