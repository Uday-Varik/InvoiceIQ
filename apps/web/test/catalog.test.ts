import { describe, expect, it } from 'vitest';
import { groupReasons, reasonViews, stateViews } from '../lib/catalog';

describe('web catalog view', () => {
  it('shows 14 states with PAID and REJECTED terminal', () => {
    const states = stateViews();
    expect(states).toHaveLength(14);
    expect(states.filter((s) => s.terminal).map((s) => s.state).sort()).toEqual(['PAID', 'REJECTED']);
  });

  it('shows 18 reason codes', () => {
    expect(reasonViews()).toHaveLength(18);
  });

  it('groups AI codes together and they are HOLD-only', () => {
    const groups = groupReasons(reasonViews());
    expect(groups['AI']).toHaveLength(4);
    for (const r of groups['AI'] ?? []) expect(r.allowedOutcomes).toEqual(['HOLD']);
  });

  it('groups deterministic codes by prefix', () => {
    const groups = groupReasons(reasonViews());
    expect(Object.keys(groups).sort()).toEqual(['AI', 'APPROVAL', 'DUPLICATE', 'MATCH', 'POLICY', 'VALIDATION', 'VENDOR']);
  });
});
