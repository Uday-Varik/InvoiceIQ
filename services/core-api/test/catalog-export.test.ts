import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG_PATH, renderCatalog } from '../scripts/export-catalog.js';

describe('exported reason catalog', () => {
  it('committed JSON matches the domain catalog', () => {
    expect(readFileSync(CATALOG_PATH, 'utf8')).toBe(renderCatalog());
  });

  it('AI codes are HOLD-only in the exported JSON too', () => {
    const json = JSON.parse(renderCatalog()) as { reasonCodes: Record<string, { source: string; allowedOutcomes: string[] }> };
    for (const [code, r] of Object.entries(json.reasonCodes)) {
      if (r.source === 'ai') expect(r.allowedOutcomes, code).toEqual(['HOLD']);
    }
  });
});
