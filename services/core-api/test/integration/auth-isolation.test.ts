/** OIDC auth end to end: the tenant comes from a verified token, and tenants cannot see each other over HTTP. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { oidcAuthenticator } from '../../src/auth/auth.js';
import { bootstrapTenant } from '../../src/db/bootstrap.js';
import { AiStub } from '../support/ai-stub.js';
import { harness, key, multipart, type Harness } from '../support/app.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';
import { uniquePdf } from '../support/fixtures.js';
import { AUDIENCE, ISSUER, testIssuer, type TestIssuer } from '../support/jwt.js';

const A = randomUUID();
const B = randomUUID();

describeDb('OIDC auth and tenant isolation over HTTP', () => {
  let tdb: TestDatabase;
  let ai: AiStub;
  let h: Harness;
  let issuer: TestIssuer;
  let invoiceA: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await bootstrapTenant(tdb.ownerUrl, { id: A, name: 'A' });
    await bootstrapTenant(tdb.ownerUrl, { id: B, name: 'B' });
    ai = await new AiStub().start();
    issuer = await testIssuer();
    h = harness(tdb.appUrl, ai, { auth: oidcAuthenticator({ issuer: ISSUER, audience: AUDIENCE, keys: issuer.keys }) });
    const token = await issuer.token({ sub: 'alice', tenant_id: A, roles: ['ap_clerk'] });
    const mp = multipart(uniquePdf('auth'));
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/invoices',
      payload: mp.payload,
      headers: { ...mp.headers, authorization: `Bearer ${token}`, 'idempotency-key': key() },
    });
    expect(res.statusCode).toBe(201);
    invoiceA = res.json().id;
    await h.worker.drain();
  });

  afterAll(async () => {
    await h?.close();
    await ai?.stop();
    await tdb?.drop();
  });

  const as = async (claims: { sub: string; tenant_id?: string; roles?: string[] }, opts = {}) => ({
    authorization: `Bearer ${await issuer.token(claims, opts)}`,
  });

  it('refuses requests without a token, with a bad token, or with the wrong audience or issuer', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/v1/invoices' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/invoices', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    for (const opts of [{ audience: 'other' }, { issuer: 'https://evil.test/' }, { expiresIn: '-1m' }]) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/invoices', headers: await as({ sub: 'alice', tenant_id: A }, opts) });
      expect(res.statusCode, JSON.stringify(opts)).toBe(401);
    }
  });

  it('refuses a token without a tenant claim', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/invoices', headers: await as({ sub: 'alice' }) });
    expect(res.statusCode).toBe(401);
  });

  it('keeps /healthz public', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('tenant B cannot list, read, download or act on tenant A invoices', async () => {
    const bob = await as({ sub: 'bob', tenant_id: B, roles: ['cfo'] });
    expect((await h.app.inject({ method: 'GET', url: '/v1/invoices', headers: bob })).json().items).toEqual([]);
    expect((await h.app.inject({ method: 'GET', url: `/v1/invoices/${invoiceA}`, headers: bob })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `/v1/invoices/${invoiceA}/document`, headers: bob })).statusCode).toBe(404);
    const approve = await h.app.inject({ method: 'POST', url: `/v1/invoices/${invoiceA}/approve`, payload: {}, headers: { ...bob, 'idempotency-key': key() } });
    expect(approve.statusCode).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/v1/audit/verify', headers: bob })).json()).toEqual({ ok: true, entries: 0, checkpointsChecked: 0 });
  });

  it('approval needs a role that covers the tier: a clerk cannot approve 1,234.50, a manager can', async () => {
    const clerk = await as({ sub: 'alice', tenant_id: A, roles: ['ap_clerk'] });
    const denied = await h.app.inject({ method: 'POST', url: `/v1/invoices/${invoiceA}/approve`, payload: {}, headers: { ...clerk, 'idempotency-key': key() } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('ROLE_INSUFFICIENT');

    const manager = await as({ sub: 'maria', tenant_id: A, roles: ['ap_manager'] });
    const ok = await h.app.inject({ method: 'POST', url: `/v1/invoices/${invoiceA}/approve`, payload: {}, headers: { ...manager, 'idempotency-key': key() } });
    expect(ok.statusCode).toBe(200);
    const history = (await h.app.inject({ method: 'GET', url: `/v1/invoices/${invoiceA}`, headers: manager })).json().history;
    expect(history.at(-1).actor).toEqual({ kind: 'human', id: 'maria' });
  });

  it('the generic transitions route cannot be used to skip the approval-authority check', async () => {
    const mp = multipart(uniquePdf('auth-2'));
    const clerk = await as({ sub: 'alice', tenant_id: A, roles: ['ap_clerk'] });
    const id = (await h.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: { ...mp.headers, ...clerk, 'idempotency-key': key() } })).json().id;
    await h.worker.drain();
    const res = await h.app.inject({ method: 'POST', url: `/v1/invoices/${id}/transitions`, payload: { to: 'APPROVED' }, headers: { ...clerk, 'idempotency-key': key() } });
    expect(res.statusCode).toBe(403);
  });
});
