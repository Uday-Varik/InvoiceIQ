/** Supply-chain hygiene: pinned actions, exact versions, owners set. */
import { describe, expect, it } from 'vitest';
import { list, read, readYaml } from './helpers.js';

const workflows = list('.github/workflows').filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
const packageJsons = ['package.json', 'apps/web/package.json', 'services/core-api/package.json', 'packages/contracts/package.json'];
const pyprojects = ['pyproject.toml', 'services/ai-service/pyproject.toml', 'data/pyproject.toml', 'packages/contracts/pyproject.toml'];

describe('GitHub Actions', () => {
  it('has a CI workflow', () => {
    expect(workflows).toContain('ci.yml');
  });

  it.each(workflows)('%s pins every action to a full commit SHA with a version comment', (file) => {
    const uses = [...read(`.github/workflows/${file}`).matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/# v\d+/);
    }
  });

  it.each(workflows)('%s defaults to read-only permissions', (file) => {
    expect(readYaml<{ permissions?: Record<string, string> }>(`.github/workflows/${file}`).permissions).toEqual({ contents: 'read' });
  });

  it('CI runs the same make targets developers run', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('make check-ts');
    expect(ci).toContain('make check-py');
  });
});

describe('dependency pinning', () => {
  it.each(packageJsons)('%s uses exact versions only', (file) => {
    const pkg = JSON.parse(read(file)) as Record<string, Record<string, string> | undefined>;
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, version] of Object.entries(pkg[field] ?? {})) {
        expect(version, `${file} ${name}`).toMatch(/^(\d+\.\d+\.\d+|workspace:\*)$/);
      }
    }
  });

  it.each(pyprojects)('%s pins third-party Python dependencies with ==', (file) => {
    const deps = [...read(file).matchAll(/^\s*"([A-Za-z0-9_.\-[\]]+)([^"]*)",?\s*$/gm)]
      .map((m) => ({ name: m[1] as string, spec: m[2] as string }))
      .filter((d) => !d.name.startsWith('invoiceiq-') && !['ai_service', 'src/ai_service', 'src/invoiceiq_data'].includes(d.name));
    for (const d of deps) {
      if (/^(sqlalchemy|psycopg|psycopg2|asyncpg|sqlite3|pg8000|databases|sqlmodel|packages|layers)$/.test(d.name)) continue;
      if (d.name.includes('/') || d.name.startsWith('ai_service')) continue;
      expect(d.spec, `${file} ${d.name}`).toMatch(/^==\d/);
    }
  });

  it('typescript is pinned to 5.x (ADR-0011)', () => {
    const version = (JSON.parse(read('package.json')) as { devDependencies: Record<string, string> }).devDependencies['typescript'];
    expect(version).toMatch(/^5\.\d+\.\d+$/);
  });

  it('dependabot covers actions, npm and uv and ignores TypeScript majors', () => {
    const cfg = readYaml<{ updates: Array<{ 'package-ecosystem': string; ignore?: Array<{ 'dependency-name': string }> }> }>('.github/dependabot.yml');
    expect(cfg.updates.map((u) => u['package-ecosystem']).sort()).toEqual(['github-actions', 'npm', 'uv']);
    const npm = cfg.updates.find((u) => u['package-ecosystem'] === 'npm');
    expect(npm?.ignore?.map((i) => i['dependency-name'])).toContain('typescript');
  });

  it('lockfiles are committed', () => {
    expect(list('.')).toEqual(expect.arrayContaining(['pnpm-lock.yaml', 'uv.lock']));
  });
});

describe('ownership', () => {
  it('CODEOWNERS names a real owner, not a placeholder', () => {
    const owners = read('.github/CODEOWNERS');
    expect(owners).not.toContain('your-github-username');
    expect(owners).toMatch(/^\* @Uday-Varik$/m);
  });
});
