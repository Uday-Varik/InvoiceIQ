import type { InvoiceState } from './api';
import { minorToInput } from './money';

/** Format integer minor units in the currency's own decimal places, never through a float. */
export function formatMoney(amountMinor: string, currency: string): string {
  const plain = minorToInput(amountMinor, currency);
  const [whole = '', frac] = plain.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${frac === undefined ? grouped : `${grouped}.${frac}`} ${currency}`;
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
