import { describe, expect, it } from 'vitest';
import {
  AI_REASON_CODES,
  INVOICE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  evaluateTransition,
  type Actor,
  type InvoiceState,
  type ReasonCode,
} from '../src/domain/index.js';

const human: Actor = { kind: 'human', id: 'u-1' };
const system: Actor = { kind: 'system', id: 'worker' };
const ai: Actor = { kind: 'ai', id: 'ai-service' };

const VALID_REASON: Partial<Record<InvoiceState, ReasonCode>> = {
  HOLD: 'POLICY_MANUAL_REVIEW_REQUIRED',
  EXCEPTION: 'VALIDATION_MISSING_FIELD',
  REJECTED: 'VENDOR_UNKNOWN',
};

function reasonsFor(to: InvoiceState): ReasonCode[] {
  const r = VALID_REASON[to];
  return r === undefined ? [] : [r];
}

const ALL_PAIRS = INVOICE_STATES.flatMap((from) => INVOICE_STATES.map((to) => [from, to] as const));

describe('lifecycle graph', () => {
  it('has 14 states', () => {
    expect(INVOICE_STATES).toHaveLength(14);
  });

  it.each(ALL_PAIRS)('human %s -> %s is allowed iff it is an edge', (from, to) => {
    const result = evaluateTransition({ from, to, actor: human, reasons: reasonsFor(to) });
    expect(result.ok).toBe(TRANSITIONS[from].includes(to));
  });

  it('terminal states have no outgoing edges', () => {
    for (const s of TERMINAL_STATES) expect(TRANSITIONS[s]).toEqual([]);
  });

  it('reports TERMINAL_STATE when leaving a terminal state', () => {
    const r = evaluateTransition({ from: 'PAID', to: 'HOLD', actor: human, reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
    expect(r).toMatchObject({ ok: false, error: 'TERMINAL_STATE' });
  });

  it('every state is reachable from RECEIVED', () => {
    const seen = new Set<InvoiceState>(['RECEIVED']);
    const queue: InvoiceState[] = ['RECEIVED'];
    while (queue.length > 0) {
      const s = queue.shift() as InvoiceState;
      for (const n of TRANSITIONS[s]) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect([...seen].sort()).toEqual([...INVOICE_STATES].sort());
  });

  it.each(INVOICE_STATES.filter((s) => !TERMINAL_STATES.has(s)))('%s can reach a terminal state', (start) => {
    const seen = new Set<InvoiceState>([start]);
    const queue: InvoiceState[] = [start];
    let reached = false;
    while (queue.length > 0 && !reached) {
      const s = queue.shift() as InvoiceState;
      for (const n of TRANSITIONS[s]) {
        if (TERMINAL_STATES.has(n)) reached = true;
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect(reached).toBe(true);
  });

  it('PAYMENT_QUEUED is only reachable from APPROVED', () => {
    const sources = INVOICE_STATES.filter((s) => TRANSITIONS[s].includes('PAYMENT_QUEUED'));
    expect(sources).toEqual(['APPROVED']);
  });

  it('PAID is only reachable from PAYMENT_QUEUED', () => {
    const sources = INVOICE_STATES.filter((s) => TRANSITIONS[s].includes('PAID'));
    expect(sources).toEqual(['PAYMENT_QUEUED']);
  });

  it('every non-terminal state except HOLD and EXCEPTION can be put on HOLD', () => {
    for (const s of INVOICE_STATES) {
      if (TERMINAL_STATES.has(s) || s === 'HOLD') continue;
      expect(TRANSITIONS[s], s).toContain('HOLD');
    }
  });
});

describe('monotonic AI safety', () => {
  const nonHoldEdges = INVOICE_STATES.flatMap((from) =>
    TRANSITIONS[from].filter((to) => to !== 'HOLD').map((to) => [from, to] as const),
  );

  it.each(nonHoldEdges)('AI actor cannot move %s -> %s', (from, to) => {
    const r = evaluateTransition({ from, to, actor: ai, reasons: reasonsFor(to) });
    expect(r).toMatchObject({ ok: false, error: 'AI_MAY_ONLY_HOLD' });
  });

  const holdSources = INVOICE_STATES.filter((s) => TRANSITIONS[s].includes('HOLD') && s !== 'EXCEPTION');
  const holdCases = holdSources.flatMap((from) => AI_REASON_CODES.map((code) => [from, code] as const));

  it.each(holdCases)('AI actor can hold %s with %s', (from, code) => {
    expect(evaluateTransition({ from, to: 'HOLD', actor: ai, reasons: [code] }).ok).toBe(true);
  });

  const aiOutsideHold = AI_REASON_CODES.flatMap((code) =>
    (['EXCEPTION', 'REJECTED', 'APPROVED', 'VALIDATED', 'PENDING_APPROVAL'] as const).map((to) => [code, to] as const),
  );

  it.each(aiOutsideHold)('AI reason %s cannot justify %s even from a human', (code, to) => {
    const from = INVOICE_STATES.find((s) => TRANSITIONS[s].includes(to)) as InvoiceState;
    const r = evaluateTransition({ from, to, actor: human, reasons: [code] });
    expect(r).toMatchObject({ ok: false, error: 'AI_REASON_OUTSIDE_HOLD' });
  });

  it('AI cannot release a HOLD', () => {
    for (const to of TRANSITIONS.HOLD) {
      expect(evaluateTransition({ from: 'HOLD', to, actor: ai, reasons: reasonsFor(to) }).ok).toBe(false);
    }
  });

  it('a random walk driven only by AI never reaches a payment state', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let walk = 0; walk < 200; walk++) {
      let state: InvoiceState = 'RECEIVED';
      for (let step = 0; step < 30; step++) {
        const options = TRANSITIONS[state];
        if (options.length === 0) break;
        const to = options[Math.floor(rand() * options.length)] as InvoiceState;
        const code = AI_REASON_CODES[Math.floor(rand() * AI_REASON_CODES.length)] as ReasonCode;
        const r = evaluateTransition({ from: state, to, actor: ai, reasons: [code] });
        if (r.ok) state = to;
      }
      expect(['APPROVED', 'PAYMENT_QUEUED', 'PAID']).not.toContain(state);
    }
  });
});

describe('human-only decisions', () => {
  it.each([
    ['PENDING_APPROVAL', 'APPROVED'],
    ['PENDING_APPROVAL', 'REJECTED'],
    ['HOLD', 'PENDING_APPROVAL'],
    ['HOLD', 'VALIDATING'],
    ['EXCEPTION', 'VALIDATING'],
  ] as const)('system actor cannot move %s -> %s', (from, to) => {
    const r = evaluateTransition({ from, to, actor: system, reasons: reasonsFor(to) });
    expect(r).toMatchObject({ ok: false, error: 'HUMAN_REQUIRED' });
  });

  it('system actor drives the happy path up to PENDING_APPROVAL', () => {
    const path: InvoiceState[] = ['RECEIVED', 'EXTRACTING', 'EXTRACTED', 'VALIDATING', 'VALIDATED', 'MATCHING', 'MATCHED', 'PENDING_APPROVAL'];
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1] as InvoiceState;
      const to = path[i] as InvoiceState;
      expect(evaluateTransition({ from, to, actor: system }).ok, `${from}->${to}`).toBe(true);
    }
  });

  it('system actor can queue and settle an approved payment', () => {
    expect(evaluateTransition({ from: 'APPROVED', to: 'PAYMENT_QUEUED', actor: system }).ok).toBe(true);
    expect(evaluateTransition({ from: 'PAYMENT_QUEUED', to: 'PAID', actor: system }).ok).toBe(true);
  });
});

describe('reason requirements', () => {
  it.each(['HOLD', 'EXCEPTION', 'REJECTED'] as const)('entering %s without a reason fails', (to) => {
    const from = INVOICE_STATES.find((s) => TRANSITIONS[s].includes(to) && s !== 'HOLD' && s !== 'EXCEPTION') as InvoiceState;
    expect(evaluateTransition({ from, to, actor: human })).toMatchObject({ ok: false, error: 'REASON_REQUIRED' });
  });

  it('rejects a reason that does not allow the outcome', () => {
    const r = evaluateTransition({ from: 'VALIDATING', to: 'REJECTED', actor: human, reasons: ['VALIDATION_MISSING_FIELD'] });
    expect(r).toMatchObject({ ok: false, error: 'REASON_OUTCOME_MISMATCH' });
  });

  it('bank change quarantine can only hold, never reject', () => {
    const r = evaluateTransition({ from: 'PENDING_APPROVAL', to: 'REJECTED', actor: human, reasons: ['VENDOR_BANK_CHANGE_QUARANTINE'] });
    expect(r).toMatchObject({ ok: false, error: 'REASON_OUTCOME_MISMATCH' });
  });

  it('accepts multiple reasons when all allow the outcome', () => {
    const r = evaluateTransition({
      from: 'MATCHING',
      to: 'HOLD',
      actor: system,
      reasons: ['MATCH_PRICE_VARIANCE', 'DUPLICATE_NEAR', 'AI_ANOMALY_SUSPECTED'],
    });
    expect(r.ok).toBe(true);
  });
});
