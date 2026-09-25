import { describe, expect, it } from 'vitest';
import { roleCovers } from '../src/auth/auth.js';
import { loadConfig } from '../src/config.js';
import { defaultPolicy } from '../src/db/bootstrap.js';
import { parsePolicy } from '../src/domain/index.js';
import { headerFrom } from '../src/invoices/pipeline.js';
import { checkApprovalAuthority, safeFilename, sniffContentType } from '../src/invoices/service.js';
import type { InvoiceRow } from '../src/invoices/store.js';
import { decodeCursor } from '../src/invoices/view.js';

const BASE = {
  DATABASE_URL: 'postgres://app@db/iq',
  AI_SERVICE_URL: 'http://ai:8001',
  AI_SIGNING_SECRET: 'x'.repeat(32),
};

describe('config', () => {
  it('defaults to OIDC and requires its settings', () => {
    expect(() => loadConfig(BASE)).toThrow(/OIDC_ISSUER is required/);
    const cfg = loadConfig({ ...BASE, OIDC_ISSUER: 'https://id.example/', OIDC_AUDIENCE: 'iq', OIDC_JWKS_URL: 'https://id.example/jwks' });
    expect(cfg.AUTH_MODE).toBe('oidc');
  });

  it('demo mode must be asked for and needs the owner URL to bootstrap its tenant', () => {
    expect(() => loadConfig({ ...BASE, AUTH_MODE: 'demo' })).toThrow(/MIGRATION_DATABASE_URL/);
    expect(loadConfig({ ...BASE, AUTH_MODE: 'demo', MIGRATION_DATABASE_URL: 'postgres://owner@db/iq' }).AUTH_MODE).toBe('demo');
  });

  it('refuses a short signing secret', () => {
    expect(() => loadConfig({ ...BASE, AUTH_MODE: 'demo', MIGRATION_DATABASE_URL: 'x', AI_SIGNING_SECRET: 'short' })).toThrow(/at least 32/);
  });
});

describe('upload helpers', () => {
  it.each([
    ['%PDF-1.7 ...', 'application/pdf'],
    ['\x89PNG\r\n\x1a\n....', 'image/png'],
    ['\xff\xd8\xff\xe0....', 'image/jpeg'],
    ['GIF89a', undefined],
    ['<html>%PDF-', undefined],
  ])('sniffs %j as %s', (bytes, type) => {
    expect(sniffContentType(Buffer.from(bytes, 'latin1'))).toBe(type);
  });

  it('strips paths, quotes and control characters from filenames', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\Users\\x\\inv "1".pdf')).toBe('inv 1.pdf');
    expect(safeFilename('a\r\nb.pdf')).toBe('ab.pdf');
    expect(safeFilename(undefined)).toBe('upload');
    expect(safeFilename('x'.repeat(300))).toHaveLength(255);
  });

  it('rejects cursors it did not issue', () => {
    expect(decodeCursor('garbage')).toBeUndefined();
    expect(decodeCursor(Buffer.from('2026-01-01T00:00:00Z|not-a-uuid').toString('base64url'))).toBeUndefined();
  });
});

describe('extraction header normalisation', () => {
  const field = (value: string | null) => ({ value, confidence: 0.95 });
  const ex = (over: Record<string, string | null>) => ({
    documentSha256: 'a'.repeat(64),
    provider: 'p',
    fields: {
      vendorName: field('ACME'),
      invoiceNumber: field('INV-1'),
      invoiceDate: field('2026-03-14'),
      currency: field('USD'),
      totalMinor: field('100'),
      ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, field(v)])),
    },
  });

  it('keeps well-formed values', () => {
    expect(headerFrom(ex({}))).toEqual({ vendorName: 'ACME', invoiceNumber: 'INV-1', invoiceDate: '2026-03-14', currency: 'USD', totalMinor: 100n });
  });

  it.each([
    ['totalMinor', '12.50'],
    ['totalMinor', '99999999999999999999'],
    ['currency', 'usd'],
    ['invoiceDate', '14/03/2026'],
    ['invoiceNumber', 'X'.repeat(65)],
    ['vendorName', '   '],
  ])('drops a malformed %s (%s) instead of guessing', (key, value) => {
    const header = headerFrom(ex({ [key]: value })) as unknown as Record<string, unknown>;
    expect(header[key]).toBeNull();
  });
});

describe('approval authority', () => {
  const policy = parsePolicy(defaultPolicy('5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f'));
  const inv = (total: string | null, currency: string | null = 'USD') => ({ total_minor: total, currency }) as InvoiceRow;
  const who = (roles: Array<'ap_clerk' | 'ap_manager' | 'controller' | 'cfo'>) => ({ tenantId: policy.tenantId, userId: 'u', roles });

  it('role seniority covers lower tiers only', () => {
    expect(roleCovers(['controller'], 'ap_manager')).toBe(true);
    expect(roleCovers(['ap_manager'], 'controller')).toBe(false);
    expect(roleCovers([], 'ap_clerk')).toBe(false);
  });

  it('picks the tier from the total', () => {
    expect(() => checkApprovalAuthority(who(['ap_clerk']), inv('100000'), policy)).not.toThrow();
    expect(() => checkApprovalAuthority(who(['ap_clerk']), inv('100001'), policy)).toThrow(/ap_manager/);
  });

  it('refuses without a total, above every tier, and needs the top role for a foreign currency', () => {
    expect(() => checkApprovalAuthority(who(['cfo']), inv(null), policy)).toThrow(/no extracted total/);
    expect(() => checkApprovalAuthority(who(['cfo']), inv('100000001'), policy)).toThrow(/above every approval tier/);
    expect(() => checkApprovalAuthority(who(['controller']), inv('100', 'EUR'), policy)).toThrow(/cfo/);
    expect(() => checkApprovalAuthority(who(['cfo']), inv('100', 'EUR'), policy)).not.toThrow();
  });
});
