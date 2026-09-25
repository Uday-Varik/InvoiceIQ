/** The README's Phase 0 table is the honest record of what was verified. */
import { describe, expect, it } from 'vitest';
import { read, tableAfter } from './helpers.js';

const readme = read('README.md');
const rows = tableAfter(readme, '## Phase 0 deliverables');

describe('README Phase 0 table', () => {
  it('lists the 12 Phase 0 deliverables', () => {
    expect(rows.map((r) => r[0])).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
  });

  it('labels every deliverable Verified-in-sandbox or Written-unverified', () => {
    for (const row of rows) expect(['Verified-in-sandbox', 'Written-unverified'], row[1]).toContain(row[2]);
  });

  it('only infrastructure that could not run here is Written-unverified', () => {
    const unverified = rows.filter((r) => r[2] === 'Written-unverified').map((r) => r[1] ?? '');
    for (const title of unverified) expect(title).toMatch(/docker|compose|terraform|k8s|infra/i);
  });

  it('links the docs it promises', () => {
    for (const link of ['docs/adr/README.md', 'docs/threat-model/README.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
      expect(readme).toContain(link);
    }
  });
});
