import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import * as ai from '../generated/ts/ai-service.zod.js';
import * as core from '../generated/ts/core-api.zod.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Operation = { operationId?: string; 'x-phase'?: number; responses?: Record<string, unknown>; security?: unknown[] };
type Spec = { paths: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], Operation>>> };

function load(name: string): Spec {
  return parse(readFileSync(join(import.meta.dirname, '..', 'openapi', `${name}.yaml`), 'utf8')) as Spec;
}

function operations(spec: Spec): Array<[string, Operation]> {
  return Object.entries(spec.paths).flatMap(([path, item]) =>
    HTTP_METHODS.flatMap((m) => (item[m] ? [[`${m.toUpperCase()} ${path}`, item[m]] as [string, Operation]] : [])),
  );
}

const SHA = 'a'.repeat(64);
const field = (value: string | null, confidence = 0.99) => ({ value, confidence });
const extraction = {
  documentSha256: SHA,
  provider: 'replay',
  fields: {
    vendorName: field('Acme'),
    invoiceNumber: field('INV-1'),
    invoiceDate: field('2026-01-01'),
    currency: field('USD'),
    totalMinor: field('1000'),
    subtotalMinor: field('900'),
    taxMinor: field('100'),
    dueDate: field(null),
  },
  lineItems: [{ description: 'Widgets', quantity: '2', unitPriceMinor: '450', amountMinor: '900', confidence: 0.85 }],
};

describe.each(['core-api', 'ai-service'])('%s spec conventions', (name) => {
  const ops = operations(load(name));

  it('has operations', () => {
    expect(ops.length).toBeGreaterThan(2);
  });

  it.each(ops)('%s has an operationId, an x-phase and a 4xx response', (_, op) => {
    expect(op.operationId).toMatch(/^[a-z][A-Za-z]+$/);
    expect([0, 1, 2, 3, 4]).toContain(op['x-phase']);
    expect(Object.keys(op.responses ?? {}).some((c) => c.startsWith('4'))).toBe(true);
  });

  it('operationIds are unique', () => {
    const ids = ops.map(([, op]) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only the /healthz and /readyz probes are unauthenticated', () => {
    const open = ops.filter(([, op]) => Array.isArray(op.security) && op.security.length === 0).map(([k]) => k);
    expect(open.filter((k) => k !== 'GET /readyz')).toEqual(['GET /healthz']);
  });
});

describe('core-api zod validators', () => {
  it('accept a valid transition request', () => {
    expect(core.TransitionRequest.safeParse({ from: 'HOLD', to: 'PENDING_APPROVAL', actor: { kind: 'human', id: 'u' } }).success).toBe(true);
  });

  it('reject unknown states, actors and extra fields', () => {
    expect(core.TransitionRequest.safeParse({ from: 'X', to: 'HOLD', actor: { kind: 'human', id: 'u' } }).success).toBe(false);
    expect(core.TransitionRequest.safeParse({ from: 'HOLD', to: 'HOLD', actor: { kind: 'robot', id: 'u' } }).success).toBe(false);
    expect(core.TransitionRequest.safeParse({ from: 'HOLD', to: 'HOLD', actor: { kind: 'ai', id: 'u' }, extra: 1 }).success).toBe(false);
  });

  it('money is a decimal string, never a float', () => {
    expect(core.Money.safeParse({ amountMinor: '12345', currency: 'USD' }).success).toBe(true);
    expect(core.Money.safeParse({ amountMinor: 123.45, currency: 'USD' }).success).toBe(false);
    expect(core.Money.safeParse({ amountMinor: '1.5', currency: 'USD' }).success).toBe(false);
    expect(core.Money.safeParse({ amountMinor: '1', currency: 'usd' }).success).toBe(false);
  });

  it('has 14 states and 18 reason codes', () => {
    expect(core.InvoiceState.options).toHaveLength(14);
    expect(core.ReasonCode.options).toHaveLength(18);
  });
});

describe('ai-service zod validators', () => {
  it('accept a HOLD signal', () => {
    const s = { reasonCode: 'AI_ANOMALY_SUSPECTED', outcome: 'HOLD', score: 0.9, evidence: 'amount 10x vendor median' };
    expect(ai.Signal.safeParse(s).success).toBe(true);
  });

  it.each(['APPROVED', 'REJECTED', 'EXCEPTION', 'RELEASE'])('reject a signal recommending %s', (outcome) => {
    const s = { reasonCode: 'AI_ANOMALY_SUSPECTED', outcome, score: 0.9, evidence: 'x' };
    expect(ai.Signal.safeParse(s).success).toBe(false);
  });

  it('reject a signal carrying a deterministic reason code', () => {
    const s = { reasonCode: 'DUPLICATE_EXACT', outcome: 'HOLD', score: 1, evidence: 'x' };
    expect(ai.Signal.safeParse(s).success).toBe(false);
  });

  it('accept a valid extraction and reject out-of-range confidence', () => {
    expect(ai.ExtractionResult.safeParse(extraction).success).toBe(true);
    const bad = { ...extraction, fields: { ...extraction.fields, currency: field('USD', 1.5) } };
    expect(ai.ExtractionResult.safeParse(bad).success).toBe(false);
  });

  it('signal requests cannot set the confidence floor below 0.5', () => {
    expect(ai.SignalRequest.safeParse({ extraction, extractionConfidenceHoldBelow: 0.4 }).success).toBe(false);
  });
});
