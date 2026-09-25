/**
 * The 14-state invoice lifecycle. Order matters: it is the canonical order used
 * by the OpenAPI contract and docs/architecture/domain-model.md, and the
 * guardrail tests compare all three.
 */
export const INVOICE_STATES = [
  'RECEIVED',
  'EXTRACTING',
  'EXTRACTED',
  'VALIDATING',
  'VALIDATED',
  'MATCHING',
  'MATCHED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'HOLD',
  'EXCEPTION',
  'PAYMENT_QUEUED',
  'PAID',
] as const;

export type InvoiceState = (typeof INVOICE_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['PAID', 'REJECTED']);

/** States from which money can move. Only a human-approved invoice ever gets here. */
export const PAYMENT_STATES: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['PAYMENT_QUEUED', 'PAID']);

export function isInvoiceState(value: unknown): value is InvoiceState {
  return typeof value === 'string' && (INVOICE_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: InvoiceState): boolean {
  return TERMINAL_STATES.has(state);
}
