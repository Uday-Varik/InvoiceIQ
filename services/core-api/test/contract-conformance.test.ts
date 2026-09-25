import { afterAll, describe, expect, it } from 'vitest';
import * as contract from '@invoiceiq/contracts/core-api/zod';
import {
  AI_REASON_CODES,
  INVOICE_STATES,
  REASON_CODES,
  TRANSITIONS,
  evaluateTransition,
  type ActorKind,
  type InvoiceState,
} from '../src/domain/index.js';
import { buildApp } from '../src/http/app.js';

const app = buildApp();
afterAll(async () => {
  await app.close();
});

describe('core-api conforms to packages/contracts', () => {
  it('state enum matches the contract, in order', () => {
    expect(contract.InvoiceState.options).toEqual([...INVOICE_STATES]);
  });

  it('reason code enum matches the contract, in order', () => {
    expect(contract.ReasonCode.options).toEqual([...REASON_CODES]);
  });

  it('transition error enum matches the domain', () => {
    const seen = new Set<string>();
    const actors: ActorKind[] = ['system', 'human', 'ai'];
    for (const from of INVOICE_STATES)
      for (const to of INVOICE_STATES)
        for (const kind of actors)
          for (const reasons of [[], ['DUPLICATE_NEAR'], ['VALIDATION_MISSING_FIELD'], [AI_REASON_CODES[0]]] as const) {
            const r = evaluateTransition({ from, to, actor: { kind, id: 'x' }, reasons: [...reasons] as never });
            if (!r.ok) seen.add(r.error);
          }
    expect([...seen].sort()).toEqual([...contract.TransitionError.options].sort());
  });

  it('GET /healthz matches Health', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(contract.Health.safeParse(res.json()).success).toBe(true);
  });

  it('GET /v1/lifecycle/states matches LifecycleStates', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/lifecycle/states' });
    expect(contract.LifecycleStates.parse(res.json()).states).toHaveLength(14);
  });

  it('GET /v1/reason-codes matches ReasonCodeList', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/reason-codes' });
    expect(contract.ReasonCodeList.parse(res.json()).reasonCodes).toHaveLength(18);
  });

  const edges = INVOICE_STATES.flatMap((from) => TRANSITIONS[from].map((to) => [from, to] as [InvoiceState, InvoiceState]));

  it.each(edges)('POST /v1/lifecycle/evaluate %s -> %s matches TransitionEvaluation', async (from, to) => {
    const payload = { from, to, actor: { kind: 'system', id: 'w' }, reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] };
    expect(contract.TransitionRequest.safeParse(payload).success).toBe(true);
    const res = await app.inject({ method: 'POST', url: '/v1/lifecycle/evaluate', payload });
    expect(contract.TransitionEvaluation.safeParse(res.json()).success).toBe(true);
  });

  it('422 responses match Problem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle/evaluate',
      payload: { from: 'NOPE', to: 'HOLD', actor: { kind: 'human', id: 'u' } },
    });
    expect(contract.Problem.safeParse(res.json()).success).toBe(true);
  });
});
