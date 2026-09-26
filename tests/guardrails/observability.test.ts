/** Alerts, dashboard and hosting config may only lean on what the services actually export and document. */
import { describe, expect, it } from 'vitest';
import { createCoreMetrics, metricNames } from '../../services/core-api/src/observability/catalog.js';
import { list, read, readYaml } from './helpers.js';

interface Rule {
  alert: string;
  expr: string;
  labels?: { severity?: string };
  annotations?: { summary?: string; runbook_url?: string };
}
interface Panel {
  id: number;
  title: string;
  targets?: Array<{ expr: string }>;
}
interface RuleTest {
  alert_rule_test?: Array<{ alertname: string }>;
}

const alerts = readYaml<{ groups: Array<{ rules: Rule[] }> }>('infra/observability/alerts.yml').groups.flatMap((g) => g.rules);
const alertTests = readYaml<{ tests: RuleTest[] }>('infra/observability/alerts.test.yml').tests;
const dashboard = JSON.parse(read('infra/observability/dashboard.json')) as { panels: Panel[] };
const runbook = read('docs/runbooks/observability.md');

const coreNames = metricNames(createCoreMetrics());
const aiNames = [...read('services/ai-service/src/ai_service/api/observability.py').matchAll(/"((?:invoiceiq|process)_[a-z0-9_]+)"/g)].map((m) => m[1]!);
const exported = new Set([...coreNames, ...aiNames]);

/** Metric names a PromQL expression reads, with histogram suffixes folded back to the family. */
function metricsIn(expr: string): string[] {
  const names = [...expr.matchAll(/\b((?:invoiceiq|process|nodejs)_[a-z0-9_]+)\b/g)].map((m) => m[1]!);
  return names.map((n) => (exported.has(n) ? n : n.replace(/_(bucket|sum|count)$/, '')));
}

describe('alert rules', () => {
  it('have unique names', () => {
    const names = alerts.map((a) => a.alert);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only use exported metrics', () => {
    for (const rule of alerts) for (const name of metricsIn(rule.expr)) expect(exported, `${rule.alert}: ${name}`).toContain(name);
  });

  it('carry a severity, a summary and a runbook section that exists', () => {
    const anchors = new Set([...runbook.matchAll(/^### (.+)$/gm)].map((m) => m[1]!.trim().toLowerCase()));
    for (const rule of alerts) {
      expect(['page', 'ticket', 'info'], rule.alert).toContain(rule.labels?.severity);
      expect(rule.annotations?.summary, rule.alert).toBeTruthy();
      const url = rule.annotations?.runbook_url ?? '';
      expect(url, rule.alert).toMatch(/^docs\/runbooks\/observability\.md#/);
      expect(anchors, rule.alert).toContain(url.split('#')[1]);
    }
  });

  it('test every paging alert with promtool', () => {
    const tested = new Set(alertTests.flatMap((t) => (t.alert_rule_test ?? []).map((a) => a.alertname)));
    for (const rule of alerts.filter((a) => a.labels?.severity === 'page')) expect(tested, rule.alert).toContain(rule.alert);
  });
});

describe('dashboard', () => {
  it('has unique panel ids', () => {
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only queries exported metrics', () => {
    const exprs = dashboard.panels.flatMap((p) => (p.targets ?? []).map((t) => ({ title: p.title, expr: t.expr })));
    expect(exprs.length).toBeGreaterThan(0);
    for (const { title, expr } of exprs) for (const name of metricsIn(expr)) expect(exported, `${title}: ${name}`).toContain(name);
  });
});

describe('metric labels', () => {
  it('never name a tenant, user, vendor or invoice', () => {
    const labels = read('services/core-api/src/observability/catalog.ts') + read('services/ai-service/src/ai_service/api/observability.py');
    expect(labels).not.toMatch(/['"](tenant|tenant_id|user|user_id|vendor_id|invoice_id)['"]/);
  });
});

describe('terraform', () => {
  const tf = list('infra/terraform')
    .filter((f) => f.endsWith('.tf'))
    .map((f) => read(`infra/terraform/${f}`))
    .join('\n');

  it('pins every provider to a version range', () => {
    const block = /required_providers\s*{([\s\S]*?)\n {2}}/.exec(read('infra/terraform/versions.tf'))?.[1] ?? '';
    const providers = [...block.matchAll(/^\s{4}(\w+)\s*=\s*{([^}]*)}/gm)];
    expect(providers.length).toBeGreaterThan(0);
    for (const [, name, body] of providers) expect(body, name).toMatch(/version\s*=\s*"~>/);
  });

  it('gives ai-service no database access (ADR-0007)', () => {
    const ai = /resource "render_web_service" "ai" {([\s\S]*?)\n}/.exec(tf)?.[1] ?? '';
    expect(ai).toContain('AI_SIGNING_SECRET');
    expect(ai).not.toMatch(/DATABASE_URL/);
  });

  it('generates secrets instead of writing them down', () => {
    for (const name of ['AI_SIGNING_SECRET', 'METRICS_TOKEN', 'APP_DB_PASSWORD']) {
      for (const m of tf.matchAll(new RegExp(`${name}\\s*=\\s*{\\s*value\\s*=\\s*([^}]+)}`, 'g'))) expect(m[1], name).not.toMatch(/"/);
    }
    expect(tf).not.toMatch(/-----BEGIN/);
  });

  it('keeps state and variable files out of git', () => {
    const ignore = read('.gitignore');
    for (const pattern of ['*.tfstate', '*.tfvars', '.terraform/']) expect(ignore).toContain(pattern);
  });
});

describe('CI', () => {
  const ci = read('.github/workflows/ci.yml');

  it('validates terraform and the alert rules with checksum-verified tools', () => {
    expect(ci).toContain('terraform -chdir=infra/terraform validate');
    expect(ci).toContain('infra/observability/check.sh');
    expect(ci.match(/sha256sum --check --strict/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
