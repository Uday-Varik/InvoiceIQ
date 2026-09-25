/**
 * Proves the ESLint architecture rules actually fire. Each probe is linted as if
 * it lived at a real path, so a broken glob or renamed directory fails here.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers.js';

const eslint = new ESLint({ cwd: ROOT });

async function restrictedImportErrors(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${ROOT}/${filePath}` });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('core-api domain purity', () => {
  it.each([
    ["import Fastify from 'fastify';", 'HTTP framework'],
    ["import { Pool } from 'pg';", 'database'],
    ["import { buildApp } from '../http/app.js';", 'HTTP layer'],
    ["import { request } from 'node:https';", 'no I/O'],
    ["import OpenAI from 'openai';", 'never calls a model'],
  ])('flags %s in src/domain', async (code, needle) => {
    const errors = await restrictedImportErrors('services/core-api/src/domain/probe.ts', `${code}\nexport {};\n`);
    expect(errors.join('\n')).toContain(needle);
  });

  it('allows pure imports in src/domain', async () => {
    const errors = await restrictedImportErrors('services/core-api/src/domain/probe.ts', "import { money } from './money.js';\nexport { money };\n");
    expect(errors).toEqual([]);
  });

  it('allows fastify in src/http but still forbids model SDKs there', async () => {
    expect(await restrictedImportErrors('services/core-api/src/http/probe.ts', "import Fastify from 'fastify';\nexport { Fastify };\n")).toEqual([]);
    const errors = await restrictedImportErrors('services/core-api/src/http/probe.ts', "import x from '@anthropic-ai/sdk';\nexport { x };\n");
    expect(errors.join('\n')).toContain('never calls a model');
  });
});

describe('web boundary', () => {
  it.each([
    "import { buildApp } from '../../services/core-api/src/http/app';",
    "import x from '@invoiceiq/core-api';",
  ])('flags %s in apps/web', async (code) => {
    const errors = await restrictedImportErrors('apps/web/lib/probe.ts', `${code}\nexport {};\n`);
    expect(errors.join('\n')).toContain('only through @invoiceiq/contracts');
  });

  it('allows contracts in apps/web', async () => {
    const errors = await restrictedImportErrors('apps/web/lib/probe.ts', "import type { paths } from '@invoiceiq/contracts/core-api';\nexport type P = paths;\n");
    expect(errors).toEqual([]);
  });
});

describe('the real tree is clean', () => {
  it('has no lint errors in core-api domain', async () => {
    const results = await eslint.lintFiles(['services/core-api/src/domain/**/*.ts']);
    expect(results.length).toBeGreaterThan(5);
    expect(results.flatMap((r) => r.messages)).toEqual([]);
  });
});
