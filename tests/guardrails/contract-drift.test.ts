/** Code, contracts and exported catalog must agree. */
import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_ROUTES } from '../../services/core-api/src/http/app.js';
import { AI_REASON_CODES, INVOICE_STATES, REASON_CATALOG, REASON_CODES } from '../../services/core-api/src/domain/index.js';
import { operations, read, readYaml, type OpenApi } from './helpers.js';

const core = readYaml<OpenApi>('packages/contracts/openapi/core-api.yaml');
const ai = readYaml<OpenApi>('packages/contracts/openapi/ai-service.yaml');
const catalog = JSON.parse(read('packages/contracts/catalog/reason-codes.json')) as {
  states: string[];
  reasonCodes: Record<string, { source: string; allowedOutcomes: string[] }>;
};

describe('core-api routes vs contract', () => {
  const ops = operations(core);

  it('every implemented route is in the contract', () => {
    const keys = new Set(ops.map((o) => o.key));
    for (const r of IMPLEMENTED_ROUTES) expect(keys.has(r), r).toBe(true);
  });

  it('every x-phase 0 and 1 operation is implemented, and nothing from a later phase', () => {
    const due = ops.filter((o) => o.op['x-phase'] <= 1).map((o) => o.key).sort();
    expect(due).toEqual([...IMPLEMENTED_ROUTES].sort());
  });
});

describe('enums', () => {
  it('core-api InvoiceState enum equals the domain', () => {
    expect(core.components.schemas['InvoiceState']?.enum).toEqual([...INVOICE_STATES]);
  });

  it('core-api ReasonCode enum equals the domain', () => {
    expect(core.components.schemas['ReasonCode']?.enum).toEqual([...REASON_CODES]);
  });

  it('ai-service AiReasonCode equals the AI_ subset of core-api ReasonCode', () => {
    const coreAi = (core.components.schemas['ReasonCode']?.enum ?? []).filter((c) => c.startsWith('AI_'));
    expect(ai.components.schemas['AiReasonCode']?.enum).toEqual(coreAi);
    expect(coreAi).toEqual([...AI_REASON_CODES]);
  });

  it('ai-service Signal.outcome is const HOLD', () => {
    expect(ai.components.schemas['Signal']?.properties?.['outcome']?.const).toBe('HOLD');
  });

  it('exported catalog equals the domain catalog', () => {
    expect(catalog.states).toEqual([...INVOICE_STATES]);
    expect(Object.keys(catalog.reasonCodes)).toEqual([...REASON_CODES]);
    for (const code of REASON_CODES) {
      expect(catalog.reasonCodes[code]?.allowedOutcomes).toEqual([...REASON_CATALOG[code].allowedOutcomes]);
    }
  });
});
