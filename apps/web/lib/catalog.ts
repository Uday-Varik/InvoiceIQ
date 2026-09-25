import catalog from '@invoiceiq/contracts/catalog/reason-codes.json' with { type: 'json' };

export type Outcome = 'HOLD' | 'EXCEPTION' | 'REJECTED';

export interface ReasonView {
  code: string;
  source: 'deterministic' | 'ai';
  severity: string;
  allowedOutcomes: readonly Outcome[];
  description: string;
}

export interface StateView {
  state: string;
  next: readonly string[];
  terminal: boolean;
}

const reasons = catalog.reasonCodes as Record<string, Omit<ReasonView, 'code'>>;
const transitions = catalog.transitions as Record<string, readonly string[]>;

export function reasonViews(): ReasonView[] {
  return Object.entries(reasons).map(([code, r]) => ({ code, ...r }));
}

export function stateViews(): StateView[] {
  return catalog.states.map((state) => {
    const next = transitions[state] ?? [];
    return { state, next, terminal: next.length === 0 };
  });
}

/** Deterministic codes grouped by the first word of the code (MATCH, DUPLICATE, ...). */
export function groupReasons(views: readonly ReasonView[]): Record<string, ReasonView[]> {
  const groups: Record<string, ReasonView[]> = {};
  for (const v of views) {
    const key = v.source === 'ai' ? 'AI' : (v.code.split('_')[0] ?? v.code);
    (groups[key] ??= []).push(v);
  }
  return groups;
}

/** The 14 lifecycle states in lifecycle order, from the exported catalog. */
export const INVOICE_STATES: readonly string[] = catalog.states;
