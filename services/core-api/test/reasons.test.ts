import { describe, expect, it } from 'vitest';
import {
  AI_REASON_CODES,
  DETERMINISTIC_REASON_CODES,
  REASON_CATALOG,
  REASON_CODES,
  isAiReason,
  isReasonCode,
  reasonAllows,
  type AiReason,
} from '../src/domain/index.js';

describe('reason catalog', () => {
  it('has exactly 18 codes', () => {
    expect(REASON_CODES).toHaveLength(18);
  });

  it('splits into 14 deterministic and 4 AI codes', () => {
    expect(DETERMINISTIC_REASON_CODES).toHaveLength(14);
    expect(AI_REASON_CODES).toHaveLength(4);
  });

  it('codes are unique SCREAMING_SNAKE_CASE', () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const c of REASON_CODES) expect(c).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/);
  });

  it.each(REASON_CODES)('%s has a description and at least one outcome', (code) => {
    const r = REASON_CATALOG[code];
    expect(r.description.length).toBeGreaterThan(10);
    expect(r.allowedOutcomes.length).toBeGreaterThan(0);
  });

  it.each(AI_REASON_CODES)('AI reason %s is HOLD-only', (code) => {
    expect(REASON_CATALOG[code].allowedOutcomes).toEqual(['HOLD']);
    expect(isAiReason(code)).toBe(true);
    expect(reasonAllows(code, 'EXCEPTION')).toBe(false);
    expect(reasonAllows(code, 'REJECTED')).toBe(false);
  });

  it('AI codes are exactly the AI_ prefixed codes', () => {
    expect(REASON_CODES.filter((c) => c.startsWith('AI_')).sort()).toEqual([...AI_REASON_CODES].sort());
  });

  it('isReasonCode rejects unknown values and prototype keys', () => {
    expect(isReasonCode('DUPLICATE_EXACT')).toBe(true);
    expect(isReasonCode('NOPE')).toBe(false);
    expect(isReasonCode('toString')).toBe(false);
    expect(isReasonCode(42)).toBe(false);
  });

  it('the type system forbids an AI reason with a non-HOLD outcome', () => {
    // @ts-expect-error AI reasons are structurally locked to ['HOLD']
    const bad: AiReason = { source: 'ai', severity: 'low', description: 'x', allowedOutcomes: ['EXCEPTION'] };
    expect(bad.source).toBe('ai');
  });
});
