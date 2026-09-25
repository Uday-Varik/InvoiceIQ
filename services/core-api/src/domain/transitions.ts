import { isAiReason, reasonAllows, type ReasonCode, type ReasonOutcome } from './reasons.js';
import { type InvoiceState, isTerminal } from './states.js';

export type ActorKind = 'system' | 'human' | 'ai';

export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}

/**
 * Allowed edges of the lifecycle graph, independent of who asks. Actor rules
 * (below) narrow this further. Terminal states have no outgoing edges.
 */
export const TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = {
  RECEIVED: ['EXTRACTING', 'HOLD', 'REJECTED'],
  EXTRACTING: ['EXTRACTED', 'EXCEPTION', 'HOLD'],
  EXTRACTED: ['VALIDATING', 'HOLD'],
  VALIDATING: ['VALIDATED', 'EXCEPTION', 'HOLD', 'REJECTED'],
  VALIDATED: ['MATCHING', 'HOLD'],
  MATCHING: ['MATCHED', 'EXCEPTION', 'HOLD', 'REJECTED'],
  MATCHED: ['PENDING_APPROVAL', 'HOLD'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'HOLD'],
  APPROVED: ['PAYMENT_QUEUED', 'HOLD'],
  REJECTED: [],
  HOLD: ['VALIDATING', 'PENDING_APPROVAL', 'EXCEPTION', 'REJECTED'],
  EXCEPTION: ['VALIDATING', 'HOLD', 'REJECTED'],
  PAYMENT_QUEUED: ['PAID', 'HOLD'],
  PAID: [],
};

/** Edges only a human may take: decisions that move money closer or undo a safety stop. */
const HUMAN_ONLY_TARGETS: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['APPROVED', 'REJECTED']);
const HUMAN_ONLY_SOURCES: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['HOLD', 'EXCEPTION']);

const OUTCOME_STATES: ReadonlySet<InvoiceState> = new Set<InvoiceState>(['HOLD', 'EXCEPTION', 'REJECTED']);

export interface TransitionRequest {
  readonly from: InvoiceState;
  readonly to: InvoiceState;
  readonly actor: Actor;
  readonly reasons?: readonly ReasonCode[];
}

export type TransitionResult =
  | { readonly ok: true; readonly from: InvoiceState; readonly to: InvoiceState }
  | { readonly ok: false; readonly error: TransitionError; readonly message: string };

export type TransitionError =
  | 'TERMINAL_STATE'
  | 'EDGE_NOT_ALLOWED'
  | 'AI_MAY_ONLY_HOLD'
  | 'AI_REASON_OUTSIDE_HOLD'
  | 'HUMAN_REQUIRED'
  | 'REASON_REQUIRED'
  | 'REASON_OUTCOME_MISMATCH';

function fail(error: TransitionError, message: string): TransitionResult {
  return { ok: false, error, message };
}

/**
 * The single gate for every state change. Pure: persistence and the audit ledger
 * record the result, they never re-decide it.
 *
 * Safety invariants enforced here (tested exhaustively in transitions.test.ts):
 *  1. Terminal states are final.
 *  2. An AI actor can only move an invoice into HOLD. It can never release a
 *     hold, approve, reject, or queue a payment (monotonic safety).
 *  3. An AI-sourced reason code can only justify HOLD, whoever submits it.
 *  4. APPROVED, REJECTED and leaving HOLD/EXCEPTION require a human.
 *  5. Entering HOLD, EXCEPTION or REJECTED requires at least one reason, and
 *     every reason must allow that outcome.
 */
export function evaluateTransition(req: TransitionRequest): TransitionResult {
  const { from, to, actor } = req;
  const reasons = req.reasons ?? [];

  if (isTerminal(from)) {
    return fail('TERMINAL_STATE', `${from} is terminal`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    return fail('EDGE_NOT_ALLOWED', `${from} -> ${to} is not a lifecycle edge`);
  }
  if (actor.kind === 'ai' && to !== 'HOLD') {
    return fail('AI_MAY_ONLY_HOLD', `AI actors may only move invoices to HOLD, not ${to}`);
  }
  if (to !== 'HOLD' && reasons.some(isAiReason)) {
    return fail('AI_REASON_OUTSIDE_HOLD', `AI-derived reasons can only justify HOLD, not ${to}`);
  }
  if (actor.kind !== 'human' && (HUMAN_ONLY_TARGETS.has(to) || HUMAN_ONLY_SOURCES.has(from))) {
    return fail('HUMAN_REQUIRED', `${from} -> ${to} requires a human actor`);
  }
  if (OUTCOME_STATES.has(to)) {
    if (reasons.length === 0) {
      return fail('REASON_REQUIRED', `moving to ${to} requires at least one reason code`);
    }
    const outcome = to as ReasonOutcome;
    const bad = reasons.find((code) => !reasonAllows(code, outcome));
    if (bad !== undefined) {
      return fail('REASON_OUTCOME_MISMATCH', `${bad} does not allow outcome ${to}`);
    }
  }
  return { ok: true, from, to };
}

export function canTransition(req: TransitionRequest): boolean {
  return evaluateTransition(req).ok;
}
