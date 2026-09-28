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

/** What the review page shows while the pipeline has the invoice. The upload is done once there is an invoice. */
export const PIPELINE_STEPS = ['Uploaded', 'Reading the invoice with AI', 'Checking totals and rules'] as const;

/** Index into PIPELINE_STEPS of the step in progress, or undefined once a person has the invoice. */
export function pipelineStep(state: InvoiceState): number | undefined {
  switch (state) {
    case 'RECEIVED':
    case 'EXTRACTING':
      return 1;
    case 'EXTRACTED':
    case 'VALIDATING':
    case 'VALIDATED':
    case 'MATCHING':
    case 'MATCHED':
      return 2;
    default:
      return undefined;
  }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return 'over an hour';
}

/** Set expectations once the wait is longer than a one-page invoice normally takes. */
export function progressHint(elapsedMs: number): string | undefined {
  if (elapsedMs > 120_000) return 'This is taking longer than usual. The pipeline retries on its own, and puts the invoice on hold for a person if extraction keeps failing.';
  if (elapsedMs > 20_000) return 'Long invoices, or a service waking up after being idle, can take up to a minute.';
  return undefined;
}

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
