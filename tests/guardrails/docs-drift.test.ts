/** Planning docs must not drift from code, contracts and each other. */
import { describe, expect, it } from 'vitest';
import { INVOICE_STATES, REASON_CATALOG, REASON_CODES, TRANSITIONS } from '../../services/core-api/src/domain/index.js';
import { list, read, readYaml, tableAfter } from './helpers.js';

const domainDoc = read('docs/architecture/domain-model.md');
const threatModel = read('docs/threat-model/README.md');
const adrFiles = list('docs/adr').filter((f) => /^\d{4}-.+\.md$/.test(f));
const taxonomy = readYaml<{ categories: Array<{ variants: Array<{ id: string }> }> }>('data/redteam/taxonomy.yaml');
const variantIds = new Set(taxonomy.categories.flatMap((c) => c.variants.map((v) => v.id)));

describe('docs/architecture/domain-model.md', () => {
  const states = tableAfter(domainDoc, '## Invoice lifecycle');
  const reasons = tableAfter(domainDoc, '## Reason catalog');

  it('lists the 14 states in code order', () => {
    expect(states.map((r) => r[0])).toEqual([...INVOICE_STATES]);
  });

  it('lists the same next states as the code', () => {
    for (const [state, , next] of states) {
      const expected = TRANSITIONS[state as keyof typeof TRANSITIONS];
      const documented = next === '(terminal)' ? [] : (next ?? '').split(',').map((s) => s.trim());
      expect(documented, state).toEqual([...expected]);
    }
  });

  it('lists the 18 reason codes with matching source and outcomes', () => {
    expect(reasons.map((r) => r[0])).toEqual([...REASON_CODES]);
    for (const [code, source, outcomes] of reasons) {
      const def = REASON_CATALOG[code as keyof typeof REASON_CATALOG];
      expect(source, code).toBe(def.source);
      expect((outcomes ?? '').split(',').map((s) => s.trim()), code).toEqual([...def.allowedOutcomes]);
    }
  });
});

describe('ADRs', () => {
  const index = tableAfter(read('docs/adr/README.md'), '| ADR |'.slice(0, 5));

  it('there are 13 ADRs numbered 0001..0013 without gaps', () => {
    expect(adrFiles.map((f) => f.slice(0, 4))).toEqual(Array.from({ length: 13 }, (_, i) => String(i + 1).padStart(4, '0')));
  });

  it.each(adrFiles)('%s has a title, status, date and the standard sections', (file) => {
    const body = read(`docs/adr/${file}`);
    expect(body).toMatch(new RegExp(`^# ADR-${file.slice(0, 4)}: .+`));
    expect(body).toMatch(/- \*\*Status:\*\* (Proposed|Accepted|Superseded by ADR-\d{4}|Deprecated)/);
    expect(body).toMatch(/- \*\*Date:\*\* \d{4}-\d{2}-\d{2}/);
    for (const section of ['## Context', '## Decision', '## Consequences']) expect(body).toContain(section);
  });

  it('the index lists every ADR file with its title', () => {
    const linked = [...read('docs/adr/README.md').matchAll(/\]\((\d{4}-[^)]+\.md)\)/g)].map((m) => m[1]);
    expect(linked).toEqual(adrFiles);
    for (const file of adrFiles) {
      const title = read(`docs/adr/${file}`).split('\n')[0]?.replace(/^# ADR-\d{4}: /, '');
      expect(read('docs/adr/README.md'), file).toContain(`| ${title} |`);
    }
    expect(index.length).toBeGreaterThanOrEqual(0);
  });
});

describe('threat model', () => {
  const threats = tableAfter(threatModel, '## Threats');
  const abuseCases = [...threatModel.matchAll(/^### (AC-\d{2}):/gm)].map((m) => m[1]);

  it('has 26 uniquely, sequentially numbered threats', () => {
    expect(threats.map((r) => r[0])).toEqual(Array.from({ length: 26 }, (_, i) => `T-${String(i + 1).padStart(2, '0')}`));
  });

  it('every threat has a STRIDE category, mitigation and control reference', () => {
    const stride = ['Spoofing', 'Tampering', 'Repudiation', 'Information disclosure', 'Denial of service', 'Elevation of privilege'];
    for (const row of threats) {
      expect(stride, row[0]).toContain(row[1]);
      expect(row[4]?.length, row[0]).toBeGreaterThan(10);
      expect(row[5]?.length, row[0]).toBeGreaterThan(3);
    }
  });

  it('covers all six STRIDE categories', () => {
    expect(new Set(threats.map((r) => r[1])).size).toBe(6);
  });

  it('has 8 sequential abuse cases', () => {
    expect(abuseCases).toEqual(Array.from({ length: 8 }, (_, i) => `AC-${String(i + 1).padStart(2, '0')}`));
  });

  it('every cited ADR exists', () => {
    const cited = new Set([...threatModel.matchAll(/ADR-(\d{4})/g)].map((m) => m[1]));
    const existing = new Set(adrFiles.map((f) => f.slice(0, 4)));
    for (const n of cited) expect(existing.has(n as string), `ADR-${n}`).toBe(true);
  });

  it('every cited reason code exists', () => {
    const cited = new Set([...threatModel.matchAll(/\b([A-Z]+(?:_[A-Z]+){1,5})\b/g)].map((m) => m[1] as string));
    const known = new Set<string>(REASON_CODES);
    const unknown = [...cited].filter((c) => /^(AI|MATCH|DUPLICATE|VENDOR|VALIDATION|APPROVAL|POLICY)_/.test(c) && !known.has(c));
    expect(unknown).toEqual([]);
  });

  it('every cited red-team variant exists and every abuse case cites threats and variants', () => {
    const cited = [...threatModel.matchAll(/RT-[A-Z]{3}-\d{2}/g)].map((m) => m[0]);
    expect(cited.length).toBeGreaterThan(8);
    for (const id of cited) expect(variantIds.has(id), id).toBe(true);
    for (const block of threatModel.split('### AC-').slice(1)) {
      expect(block).toMatch(/T-\d{2}/);
      expect(block).toMatch(/RT-[A-Z]{3}-\d{2}/);
    }
  });

  it('every threat is referenced by at most one row id (no duplicates)', () => {
    const ids = threats.map((r) => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
