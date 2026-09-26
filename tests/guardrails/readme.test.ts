/** The README's phase tables are the honest record of what was verified. */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, ROOT, tableAfter } from './helpers.js';

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

describe('README Phase 2 table', () => {
  const phase2 = tableAfter(readme, '## Phase 2 deliverables');

  it('lists 8 numbered deliverables, all run in the sandbox', () => {
    expect(phase2.map((r) => r[0])).toEqual(Array.from({ length: 8 }, (_, i) => String(i + 1)));
    for (const row of phase2) expect(row[2], row[1]).toBe('Verified-in-sandbox');
  });

  it('points every row at a path that exists', () => {
    for (const row of phase2) {
      const path = /`([^`]+)`/.exec(row[3] ?? '')?.[1];
      expect(path, row[1]).toBeDefined();
      expect(existsSync(join(ROOT, path!)), path).toBe(true);
    }
  });
});

describe('README Phase 3 table', () => {
  const phase3 = tableAfter(readme, '## Phase 3 deliverables');

  it('lists 8 numbered deliverables, all run in the sandbox', () => {
    expect(phase3.map((r) => r[0])).toEqual(Array.from({ length: 8 }, (_, i) => String(i + 1)));
    for (const row of phase3) expect(row[2], row[1]).toBe('Verified-in-sandbox');
  });

  it('points every row at a path that exists', () => {
    for (const row of phase3) {
      const path = /`([^`]+)`/.exec(row[3] ?? '')?.[1];
      expect(path, row[1]).toBeDefined();
      expect(existsSync(join(ROOT, path!)), path).toBe(true);
    }
  });

  it('links the ADR that records the Phase 3 decisions', () => {
    expect(readme).toContain('docs/adr/0016-');
  });
});

describe('README Phase 1 table', () => {
  const phase1 = tableAfter(readme, '## Phase 1 deliverables');

  it('lists 12 numbered deliverables with honest labels', () => {
    expect(phase1.map((r) => r[0])).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    for (const row of phase1) expect(['Verified-in-sandbox', 'Written-unverified'], row[1]).toContain(row[2]);
  });

  it('only hosted-deploy pieces that could not run here are Written-unverified, and they say W-UNV', () => {
    for (const row of phase1.filter((r) => r[2] === 'Written-unverified')) {
      expect(row[1]).toMatch(/render|vercel|neon|deploy/i);
      expect(row[1]).toContain('W-UNV');
    }
  });

  it('says W-UNV in the deploy files themselves', () => {
    expect(read('render.yaml')).toContain('W-UNV');
    expect(read('docs/runbooks/deploy-free-tier.md')).toContain('W-UNV');
  });
});
