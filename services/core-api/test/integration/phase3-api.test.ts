/**
 * Phase 3 end to end on real Postgres: multi-person approvals with separation
 * of duties, the vendor master and bank-change quarantine, payment runs, and
 * signed audit checkpoints that catch a rewritten chain.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as contract from '@invoiceiq/contracts/core-api/zod';
import { appendEntry, type AuditEntry } from '../../src/domain/index.js';
import { bootstrapTenant, DEMO_TENANT_ID } from '../../src/db/bootstrap.js';
import { PAYMENT_FILE_COLUMNS } from '../../src/payments/service.js';
import { AiStub, GOOD_FIELDS, type StubFields } from '../support/ai-stub.js';
import { harness, key, multipart, type Harness } from '../support/app.js';
import { createTestDatabase, describeDb, type TestDatabase } from '../support/db.js';
import { uniquePdf } from '../support/fixtures.js';

type Persona = 'demo-user' | 'demo-clerk' | 'demo-manager' | 'demo-controller' | 'demo-cfo' | 'demo-deputy-cfo';
const f = (value: string | null, confidence = 0.95) => ({ value, confidence });
const SHA = 'e'.repeat(64);

describeDb('Phase 3 controls (real Postgres)', () => {
  let tdb: TestDatabase;
  let ai: AiStub;
  let h: Harness;
  let owner: pg.Client;
  let n = 0;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await bootstrapTenant(tdb.ownerUrl, { id: DEMO_TENANT_ID, name: 'Demo' });
    ai = await new AiStub().start();
    h = harness(tdb.appUrl, ai, { maxAttempts: 2 });
    owner = new pg.Client({ connectionString: tdb.ownerUrl });
    await owner.connect();
    await owner.query("SELECT set_config('app.tenant_id', $1, false)", [DEMO_TENANT_ID]);
  });

  afterAll(async () => {
    await owner?.end();
    await h?.close();
    await ai?.stop();
    await tdb?.drop();
  });

  const as = (persona: Persona) => ({ authorization: `Demo ${persona}` });
  const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, persona: Persona = 'demo-user', payload?: object, idem: string | null = key()) =>
    h.app.inject({ method, url, ...(payload ? { payload } : {}), headers: { ...as(persona), ...(idem && method !== 'GET' ? { 'idempotency-key': idem } : {}) } });
  const get = async (url: string, persona: Persona = 'demo-user') => (await inject('GET', url, persona)).json();

  /** Upload as the clerk with these fields and drain the pipeline; returns the settled invoice. */
  const invoice = async (over: Partial<Record<keyof StubFields, string | null>> = {}) => {
    const fields: StubFields = { ...GOOD_FIELDS };
    for (const [k, v] of Object.entries(over)) fields[k as keyof StubFields] = f(v);
    ai.mode = { kind: 'fields', fields };
    const mp = multipart(uniquePdf(`p3-${++n}-${randomUUID()}`), 'inv.pdf');
    const res = await h.app.inject({ method: 'POST', url: '/v1/invoices', payload: mp.payload, headers: { ...mp.headers, ...as('demo-clerk'), 'idempotency-key': key() } });
    expect(res.statusCode).toBe(201);
    await h.worker.drain();
    return get(`/v1/invoices/${res.json().id as string}`);
  };
  const approve = (id: string, persona: Persona, comment?: string, idem = key()) =>
    inject('POST', `/v1/invoices/${id}/approve`, persona, comment ? { comment } : {}, idem);
  const transitionTo = (id: string, to: string, persona: Persona, extra: object = {}) =>
    inject('POST', `/v1/invoices/${id}/transitions`, persona, { to, ...extra });
  /** A pending invoice for a vendor of its own, approved by a manager. */
  const approved = async (vendorName: string, totalMinor = '123450', currency = 'USD') => {
    const inv = await invoice({ vendorName, totalMinor, currency });
    expect(inv.state).toBe('PENDING_APPROVAL');
    const res = await approve(inv.id as string, 'demo-manager');
    expect(res.json().state).toBe('APPROVED');
    return res.json();
  };
  const vendorOf = async (id: string) => get(`/v1/vendors/${id}`);
  const bankChange = (vendorId: string, last4: string, persona: Persona = 'demo-clerk') =>
    inject('POST', `/v1/vendors/${vendorId}/bank-changes`, persona, { ibanOrAccountLast4: last4, evidenceDocumentSha256: SHA });
  const verifyChange = (vendorId: string, changeId: string, persona: Persona, note = 'Called the number on file; confirmed by AP lead') =>
    inject('POST', `/v1/vendors/${vendorId}/bank-changes/${changeId}/verify`, persona, { callbackNote: note });
  /** Move a bank change into the past, as if the quarantine window had run. */
  const age = (changeId: string, hours: number) =>
    owner.query("UPDATE vendor_bank_changes SET requested_at = now() - make_interval(hours => $2), verified_at = CASE WHEN verified_at IS NULL THEN NULL ELSE now() END WHERE id = $1", [changeId, hours]);
  /** Record and clear a bank change for a vendor, so its runs pay a known account. */
  const clearedChange = async (vendorId: string, last4: string) => {
    const c = (await bankChange(vendorId, last4)).json();
    expect((await verifyChange(vendorId, c.changeId as string, 'demo-manager')).statusCode).toBe(200);
    await age(c.changeId as string, 200);
    return c.changeId as string;
  };
  const createRun = (body: object, persona: Persona = 'demo-manager') => inject('POST', '/v1/payment-runs', persona, body);

  describe('audit checkpoints on an empty chain', () => {
    it('refuses to sign an empty chain', async () => {
      const res = await inject('POST', '/v1/audit/checkpoints', 'demo-manager', undefined, null);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CHAIN_EMPTY');
    });

    it('lists no checkpoints yet, with the signing key', async () => {
      const body = contract.AuditCheckpointList.parse(await get('/v1/audit/checkpoints'));
      expect(body.items).toEqual([]);
      expect(body.currentKeyId).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('who am I', () => {
    it('the default demo caller, with the personas on offer', async () => {
      const me = contract.Me.parse(await get('/v1/me'));
      expect(me).toMatchObject({ userId: 'demo-user', roles: ['cfo'], authMode: 'demo' });
      expect(me.personas?.map((p) => p.id)).toContain('demo-controller');
    });

    it('a persona from the header or the cookie', async () => {
      expect(await get('/v1/me', 'demo-clerk')).toMatchObject({ userId: 'demo-clerk', roles: ['ap_clerk'] });
      const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: 'iq_demo_persona=demo-cfo' } });
      expect(res.json()).toMatchObject({ userId: 'demo-cfo' });
    });

    it('an unknown persona is 401', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Demo mallory' } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('approvals and separation of duties', () => {
    it('shows the tier an invoice needs while it waits', async () => {
      const inv = contract.Invoice.parse(await invoice());
      expect(inv.state).toBe('PENDING_APPROVAL');
      expect(inv.approvalTier).toEqual({ name: 'manager', role: 'ap_manager', required: 1 });
      expect(inv.approvals).toEqual([]);
    });

    it('the uploader cannot approve their own invoice', async () => {
      const inv = await invoice();
      const res = await approve(inv.id, 'demo-clerk');
      expect(res.statusCode).toBe(403);
      // The clerk also lacks the role; the role check comes first.
      expect(res.json().code).toBe('ROLE_INSUFFICIENT');
      // A manager who uploads is still refused on their own invoice.
      const byUser = await invoice();
      await owner.query('UPDATE invoices SET created_by = $2 WHERE id = $1', [byUser.id, 'demo-manager']);
      const self = await approve(byUser.id as string, 'demo-manager');
      expect(self.statusCode).toBe(403);
      expect(self.json()).toMatchObject({ code: 'SELF_APPROVAL', title: 'Separation of duties' });
    });

    it('whoever corrected an invoice cannot approve it', async () => {
      const inv = await invoice();
      const patched = await inject('PATCH', `/v1/invoices/${inv.id as string}`, 'demo-manager', { expectedVersion: inv.version, invoiceNumber: 'INV-FIXED-1' });
      expect(patched.json().state).toBe('PENDING_APPROVAL');
      const res = await approve(inv.id as string, 'demo-manager');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('CORRECTOR_APPROVAL');
      expect((await approve(inv.id as string, 'demo-controller')).json().state).toBe('APPROVED');
    });

    it('a clerk cannot approve a manager-tier total', async () => {
      const inv = await invoice();
      const res = await h.app.inject({ method: 'POST', url: `/v1/invoices/${inv.id as string}/approve`, payload: {}, headers: { ...as('demo-clerk'), 'idempotency-key': key() } });
      expect(res.json().code).toBe('ROLE_INSUFFICIENT');
    });

    it('a manager approves; the approval is recorded and the history names them', async () => {
      const inv = await invoice();
      const res = await approve(inv.id as string, 'demo-manager', 'checked against the PO');
      const body = contract.Invoice.parse(res.json());
      expect(body.state).toBe('APPROVED');
      expect(body.approvals).toHaveLength(1);
      expect(body.approvals?.[0]).toMatchObject({ approverId: 'demo-manager', role: 'ap_manager', comment: 'checked against the PO', current: false });
      const full = await get(`/v1/invoices/${inv.id as string}`);
      const types = (full.history as Array<{ type: string }>).map((e) => e.type);
      expect(types.slice(-2)).toEqual(['invoice.approval_recorded', 'invoice.transitioned']);
      expect(full.history.at(-1)).toMatchObject({ to: 'APPROVED', actor: { kind: 'human', id: 'demo-manager' } });
    });

    it('a CFO-tier invoice needs two different CFOs', async () => {
      const inv = await invoice({ totalMinor: '50000000' });
      expect(inv.approvalTier).toEqual({ name: 'cfo', role: 'cfo', required: 2 });
      expect((await approve(inv.id as string, 'demo-controller')).json().code).toBe('ROLE_INSUFFICIENT');

      const first = await approve(inv.id as string, 'demo-cfo');
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ state: 'PENDING_APPROVAL', approvalTier: { required: 2 } });
      expect(first.json().approvals).toEqual([expect.objectContaining({ approverId: 'demo-cfo', current: true })]);

      const again = await approve(inv.id as string, 'demo-cfo');
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('ALREADY_APPROVED');

      const second = await approve(inv.id as string, 'demo-deputy-cfo');
      expect(second.json().state).toBe('APPROVED');
      const last = (await get(`/v1/invoices/${inv.id as string}`)).history.at(-1);
      expect(last).toMatchObject({ to: 'APPROVED', actor: { id: 'demo-deputy-cfo' } });
    });

    it('a correction between approvals resets the count', async () => {
      const inv = await invoice({ totalMinor: '50000000' });
      await approve(inv.id as string, 'demo-cfo');
      const cur = await get(`/v1/invoices/${inv.id as string}`);
      await inject('PATCH', `/v1/invoices/${inv.id as string}`, 'demo-clerk', { expectedVersion: cur.version, invoiceNumber: 'INV-R-1' });
      const after = await get(`/v1/invoices/${inv.id as string}`);
      expect(after.state).toBe('PENDING_APPROVAL');
      expect(after.approvals).toEqual([expect.objectContaining({ approverId: 'demo-cfo', current: false })]);
      expect((await approve(inv.id as string, 'demo-deputy-cfo')).json().state).toBe('PENDING_APPROVAL');
      expect((await approve(inv.id as string, 'demo-cfo')).json().state).toBe('APPROVED');
    });

    it('a replayed approval is not counted twice', async () => {
      const inv = await invoice({ totalMinor: '50000000' });
      const idem = key();
      const a = await approve(inv.id as string, 'demo-cfo', undefined, idem);
      const b = await approve(inv.id as string, 'demo-cfo', undefined, idem);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(b.json()).toEqual(a.json());
      expect((await get(`/v1/invoices/${inv.id as string}`)).approvals).toHaveLength(1);
    });

    it('the transitions endpoint applies the same approval rules', async () => {
      const inv = await invoice();
      const res = await transitionTo(inv.id as string, 'APPROVED', 'demo-clerk');
      expect(res.statusCode).toBe(403);
      expect((await transitionTo(inv.id as string, 'APPROVED', 'demo-manager')).json().state).toBe('APPROVED');
    });

    it('payments cannot be moved by hand, only through payment runs', async () => {
      const inv = await approved('Hand Mover Ltd');
      const res = await transitionTo(inv.id as string, 'PAYMENT_QUEUED', 'demo-cfo');
      expect(res.statusCode).toBe(409);
      expect(res.json().detail).toContain('payment runs');
    });

    it('a held invoice released by a human still needs approval', async () => {
      const inv = await invoice({ totalMinor: '123450' });
      const held = await transitionTo(inv.id as string, 'HOLD', 'demo-manager', { reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
      expect(held.json().state).toBe('HOLD');
      expect((await transitionTo(inv.id as string, 'PENDING_APPROVAL', 'demo-manager')).json().state).toBe('PENDING_APPROVAL');
      expect((await approve(inv.id as string, 'demo-controller')).json().state).toBe('APPROVED');
    });
  });

  describe('vendor master', () => {
    it('the pipeline registers and links the vendor it reads', async () => {
      const inv = contract.Invoice.parse(await invoice({ vendorName: 'Northwind Traders' }));
      expect(inv.vendorId).toBeDefined();
      const v = contract.VendorDetail.parse(await vendorOf(inv.vendorId as string));
      expect(v).toMatchObject({ name: 'Northwind Traders', status: 'active', openInvoices: 1, payment: { blocked: false }, bankAccountLast4: null, createdBy: 'core-api:pipeline' });
      expect(v.bankChanges).toEqual([]);
    });

    it('another spelling of the same name links to the same vendor', async () => {
      const a = await invoice({ vendorName: 'Contoso, Ltd.' });
      const b = await invoice({ vendorName: 'CONTOSO LTD' });
      expect(b.vendorId).toBe(a.vendorId);
      expect((await vendorOf(a.vendorId as string)).openInvoices).toBe(2);
    });

    it('lists vendors by name and searches them', async () => {
      const list = contract.VendorList.parse(await get('/v1/vendors'));
      const names = list.items.map((v) => v.name);
      expect(names).toEqual([...names].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
      const found = await get('/v1/vendors?q=northwind');
      expect(found.items.map((v: { name: string }) => v.name)).toEqual(['Northwind Traders']);
      expect((await get('/v1/vendors?q=%25')).items).toEqual([]);
    });

    it('registers a vendor by hand, once', async () => {
      const res = await inject('POST', '/v1/vendors', 'demo-clerk', { name: 'Fabrikam Inc' });
      expect(res.statusCode).toBe(201);
      contract.VendorDetail.parse(res.json());
      const dup = await inject('POST', '/v1/vendors', 'demo-clerk', { name: 'fabrikam, inc.' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe('VENDOR_EXISTS');
      expect((await inject('POST', '/v1/vendors', 'demo-clerk', { name: '!!!' })).json().code).toBe('INVALID_VENDOR');
    });

    it('an unknown vendor is 404', async () => {
      expect((await inject('GET', `/v1/vendors/${randomUUID()}`)).statusCode).toBe(404);
    });

    it('deactivating needs a manager, the current version, and a real change', async () => {
      const v = (await inject('POST', '/v1/vendors', 'demo-clerk', { name: 'Dormant Co' })).json();
      expect((await inject('PATCH', `/v1/vendors/${v.id as string}`, 'demo-clerk', { expectedVersion: 1, status: 'inactive' })).json().code).toBe('ROLE_INSUFFICIENT');
      expect((await inject('PATCH', `/v1/vendors/${v.id as string}`, 'demo-manager', { expectedVersion: 9, status: 'inactive' })).json().code).toBe('VERSION_CONFLICT');
      expect((await inject('PATCH', `/v1/vendors/${v.id as string}`, 'demo-manager', { expectedVersion: 1, status: 'active' })).json().code).toBe('NO_CHANGES');
      const off = await inject('PATCH', `/v1/vendors/${v.id as string}`, 'demo-manager', { expectedVersion: 1, status: 'inactive', comment: 'no longer used' });
      expect(off.json()).toMatchObject({ status: 'inactive', version: 2, payment: { blocked: true, reason: 'VENDOR_INACTIVE' } });
    });

    it('an invoice from an inactive vendor is held', async () => {
      const inv = await invoice({ vendorName: 'Dormant Co' });
      expect(inv).toMatchObject({ state: 'HOLD', reasons: ['VENDOR_INACTIVE'] });
    });
  });

  describe('bank-change quarantine', () => {
    let vendorId: string;
    let changeId: string;

    it('recording a change quarantines the vendor at once', async () => {
      vendorId = (await invoice({ vendorName: 'Litware Payments' })).vendorId as string;
      const res = await bankChange(vendorId, '9876');
      expect(res.statusCode).toBe(202);
      const status = contract.BankChangeStatus.parse(res.json());
      expect(status).toMatchObject({ vendorId, accountLast4: '9876', quarantined: true, why: 'UNVERIFIED', releasesAt: null, requestedBy: 'demo-clerk', verifiedBy: null });
      changeId = status.changeId;
      const v = await vendorOf(vendorId);
      expect(v).toMatchObject({ bankAccountLast4: '9876', payment: { blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', why: 'UNVERIFIED' } });
      expect(v.bankChanges).toHaveLength(1);
    });

    it('new invoices from a quarantined vendor are held', async () => {
      const inv = await invoice({ vendorName: 'Litware Payments' });
      expect(inv).toMatchObject({ state: 'HOLD', reasons: ['VENDOR_BANK_CHANGE_QUARANTINE'] });
    });

    it('the requester cannot verify their own change', async () => {
      const own = await inject('POST', '/v1/vendors', 'demo-manager', { name: 'Self Check GmbH' });
      const c = (await bankChange(own.json().id as string, '1111', 'demo-manager')).json();
      const res = await verifyChange(own.json().id as string, c.changeId as string, 'demo-manager');
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('SEPARATION_OF_DUTIES');
    });

    it('a clerk cannot verify, and the note must say something', async () => {
      expect((await verifyChange(vendorId, changeId, 'demo-clerk')).json().code).toBe('ROLE_INSUFFICIENT');
      expect((await verifyChange(vendorId, changeId, 'demo-manager', 'ok')).statusCode).toBe(400);
    });

    it('a manager verifies by callback; the window still has to run', async () => {
      const res = await verifyChange(vendorId, changeId, 'demo-manager');
      expect(res.statusCode).toBe(200);
      const s = contract.BankChangeStatus.parse(res.json());
      expect(s).toMatchObject({ quarantined: true, why: 'WINDOW_OPEN', verifiedBy: 'demo-manager' });
      const hours = (Date.parse(s.releasesAt as string) - Date.now()) / 3_600_000;
      // The demo policy quarantines bank changes for 72 hours.
      expect(hours).toBeGreaterThan(71);
      expect(hours).toBeLessThanOrEqual(72);
      expect((await verifyChange(vendorId, changeId, 'demo-controller')).json().code).toBe('ALREADY_VERIFIED');
    });

    it('once the window has run the vendor can be paid again', async () => {
      await age(changeId, 73);
      expect((await vendorOf(vendorId)).payment).toEqual({ blocked: false });
    });

    it('only the latest change can be verified', async () => {
      const older = (await bankChange(vendorId, '2222')).json().changeId as string;
      await owner.query("UPDATE vendor_bank_changes SET requested_at = now() - interval '1 minute' WHERE id = $1", [older]);
      await bankChange(vendorId, '3333');
      const res = await verifyChange(vendorId, older, 'demo-manager');
      expect(res.json().code).toBe('SUPERSEDED');
      expect((await vendorOf(vendorId)).bankAccountLast4).toBe('3333');
    });

    it('the database itself refuses a self-verification', async () => {
      await expect(owner.query("UPDATE vendor_bank_changes SET verified_by = requested_by, verified_at = now(), callback_note = 'x' WHERE id = $1", [changeId])).rejects.toThrow(
        /check constraint/,
      );
    });

    it('a bank change on an unknown vendor is 404', async () => {
      expect((await bankChange(randomUUID(), '4444')).statusCode).toBe(404);
    });
  });

  describe('payment runs', () => {
    it('a clerk cannot assemble a run', async () => {
      expect((await createRun({ currency: 'USD' }, 'demo-clerk')).json().code).toBe('ROLE_INSUFFICIENT');
    });

    it('assembles approved invoices into a run and freezes the accounts', async () => {
      const a = await approved('Run Vendor A', '10000');
      const b = await approved('Run Vendor A', '20050');
      await clearedChange(a.vendorId as string, 'AB12');
      const res = await createRun({ currency: 'USD', invoiceIds: [a.id, b.id], comment: 'weekly run' });
      expect(res.statusCode).toBe(201);
      const out = contract.PaymentRunResult.parse(res.json());
      const run = out.run;
      expect(run).toMatchObject({ currency: 'USD', status: 'queued', invoiceCount: 2, total: { amountMinor: '30050', currency: 'USD' }, createdBy: 'demo-manager', version: 1 });
      expect(run?.items?.map((i: { accountLast4: string | null }) => i.accountLast4)).toEqual(['AB12', 'AB12']);
      expect(out.held).toEqual([]);
      for (const id of [a.id, b.id]) expect(await get(`/v1/invoices/${id as string}`)).toMatchObject({ state: 'PAYMENT_QUEUED', paymentRunId: run?.id });
    });

    it('returns run null when nothing is payable', async () => {
      const res = await createRun({ currency: 'JPY' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ run: null, held: [], skipped: [] });
    });

    it('refuses named invoices that are not approved in that currency', async () => {
      const pending = await invoice({ vendorName: 'Not Yet Approved' });
      const res = await createRun({ currency: 'USD', invoiceIds: [pending.id] });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('INVOICE_NOT_PAYABLE');
      expect(res.json().detail).toContain(pending.id);
    });

    it('holds approved invoices of a vendor that became blocked, and pays the rest', async () => {
      const good = await approved('Clean Vendor');
      const risky = await approved('Risky Vendor');
      await bankChange(risky.vendorId as string, 'ZZ99');
      const res = await createRun({ currency: 'USD', invoiceIds: [good.id, risky.id] });
      expect(res.statusCode).toBe(201);
      expect(res.json().held).toEqual([{ invoiceId: risky.id, reason: 'VENDOR_BANK_CHANGE_QUARANTINE' }]);
      expect(res.json().run.invoiceCount).toBe(1);
      expect(await get(`/v1/invoices/${risky.id as string}`)).toMatchObject({ state: 'HOLD', reasons: ['VENDOR_BANK_CHANGE_QUARANTINE'] });
    });

    it('never mixes currencies', async () => {
      const eur = await invoice({ vendorName: 'Euro GmbH', currency: 'EUR', totalMinor: '5000' });
      await approve(eur.id as string, 'demo-cfo');
      expect((await approve(eur.id as string, 'demo-deputy-cfo')).json().state).toBe('APPROVED');
      const usd = await approved('Dollar Inc');
      const res = await createRun({ currency: 'EUR' });
      expect(res.json().run.items.map((i: { invoiceId: string }) => i.invoiceId)).toEqual([eur.id]);
      expect((await get(`/v1/invoices/${usd.id as string}`)).state).toBe('APPROVED');
    });

    it('links invoices approved before the vendor master existed', async () => {
      const legacy = await approved('Legacy Supplier');
      await owner.query('UPDATE invoices SET vendor_id = NULL WHERE id = $1', [legacy.id]);
      const res = await createRun({ currency: 'USD', invoiceIds: [legacy.id] });
      expect(res.statusCode).toBe(201);
      expect(res.json().run.items[0]).toMatchObject({ invoiceId: legacy.id, vendorName: 'Legacy Supplier' });
    });

    describe('confirming and cancelling', () => {
      let runId: string;
      let invoiceIds: string[];
      let vendorId: string;

      const confirm = (persona: Persona, expectedVersion = 1) => inject('POST', `/v1/payment-runs/${runId}/confirm`, persona, { expectedVersion });

      it('sets up a run', async () => {
        const a = await approved('Confirm Vendor', '7000');
        const b = await approved('Confirm Vendor', '3000');
        vendorId = a.vendorId as string;
        await clearedChange(vendorId, 'CF01');
        const res = await createRun({ currency: 'USD', invoiceIds: [a.id, b.id] });
        runId = res.json().run.id as string;
        invoiceIds = [a.id as string, b.id as string];
      });

      it('the payment file is the frozen snapshot', async () => {
        const res = await h.app.inject({ method: 'GET', url: `/v1/payment-runs/${runId}/file`, headers: as('demo-manager') });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(res.headers['content-disposition']).toMatch(/^attachment; filename="payment-run-[0-9a-f]{8}-USD\.csv"$/);
        const lines = res.body.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
        expect(lines[0]).toBe(PAYMENT_FILE_COLUMNS.join(','));
        expect(lines).toHaveLength(3);
        expect(lines.slice(1).every((l) => l.includes(',CF01,') && l.startsWith(runId))).toBe(true);
        expect((await h.app.inject({ method: 'GET', url: `/v1/payment-runs/${runId}/file`, headers: as('demo-clerk') })).statusCode).toBe(403);
      });

      it('the person who assembled it cannot confirm it, even with the role', async () => {
        await owner.query("UPDATE payment_runs SET created_by = 'demo-controller' WHERE id = $1", [runId]);
        const res = await confirm('demo-controller');
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe('SEPARATION_OF_DUTIES');
        await owner.query("UPDATE payment_runs SET created_by = 'demo-manager' WHERE id = $1", [runId]);
      });

      it('a manager cannot confirm; a stale version is refused', async () => {
        expect((await confirm('demo-manager')).json().code).toBe('ROLE_INSUFFICIENT');
        expect((await confirm('demo-controller', 7)).json().code).toBe('VERSION_CONFLICT');
      });

      it('is refused while the vendor is quarantined again', async () => {
        const c = (await bankChange(vendorId, 'CF02')).json().changeId as string;
        const res = await confirm('demo-controller');
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('VENDOR_BLOCKED');
        await verifyChange(vendorId, c, 'demo-manager');
        await age(c, 200);
      });

      it('is refused when the account changed since assembly, even once cleared', async () => {
        const res = await confirm('demo-controller');
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe('BANK_DETAILS_CHANGED');
      });

      it('a cancel needs a comment', async () => {
        const res = await inject('POST', `/v1/payment-runs/${runId}/cancel`, 'demo-manager', { expectedVersion: 1 });
        expect(res.statusCode).toBe(400);
      });

      it('cancelling holds its invoices and frees them for a fresh approval', async () => {
        const res = await inject('POST', `/v1/payment-runs/${runId}/cancel`, 'demo-manager', { expectedVersion: 1, comment: 'account changed; re-run next week' });
        expect(res.statusCode).toBe(200);
        const run = contract.PaymentRun.parse(res.json());
        expect(run).toMatchObject({ status: 'cancelled', closedBy: 'demo-manager', closeComment: 'account changed; re-run next week', version: 2 });
        for (const id of invoiceIds) {
          const inv = await get(`/v1/invoices/${id}`);
          expect(inv).toMatchObject({ state: 'HOLD', reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
          expect(inv.paymentRunId).toBeUndefined();
        }
        expect((await h.app.inject({ method: 'GET', url: `/v1/payment-runs/${runId}/file`, headers: as('demo-manager') })).json().code).toBe('RUN_CLOSED');
        expect((await confirm('demo-controller', 2)).json().code).toBe('RUN_CLOSED');
      });

      it('released invoices need approving again before a new run', async () => {
        for (const id of invoiceIds) {
          expect((await transitionTo(id, 'PENDING_APPROVAL', 'demo-manager')).json().state).toBe('PENDING_APPROVAL');
          expect((await approve(id, 'demo-controller')).json().state).toBe('APPROVED');
        }
        const res = await createRun({ currency: 'USD', invoiceIds });
        expect(res.statusCode).toBe(201);
        runId = res.json().run.id as string;
        expect(res.json().run.items.every((i: { accountLast4: string }) => i.accountLast4 === 'CF02')).toBe(true);
      });

      it('is refused when an invoice left the run', async () => {
        const [first] = invoiceIds;
        await transitionTo(first as string, 'HOLD', 'demo-manager', { reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
        const res = await confirm('demo-controller');
        expect(res.json().code).toBe('RUN_INCOMPLETE');
        expect(res.json().detail).toContain(first);
        await inject('POST', `/v1/payment-runs/${runId}/cancel`, 'demo-manager', { expectedVersion: 1, comment: 'one invoice pulled' });
        const second = invoiceIds[1] as string;
        await transitionTo(second, 'PENDING_APPROVAL', 'demo-manager');
        await approve(second, 'demo-controller');
        await transitionTo(first as string, 'PENDING_APPROVAL', 'demo-manager');
        await approve(first as string, 'demo-controller');
        runId = (await createRun({ currency: 'USD', invoiceIds })).json().run.id as string;
      });

      it('a controller confirms: every invoice is PAID and the run is closed', async () => {
        const res = await confirm('demo-controller');
        expect(res.statusCode).toBe(200);
        expect(contract.PaymentRun.parse(res.json())).toMatchObject({ status: 'paid', closedBy: 'demo-controller', version: 2 });
        for (const id of invoiceIds) {
          const inv = await get(`/v1/invoices/${id}`);
          expect(inv.state).toBe('PAID');
          expect(inv.history.at(-1)).toMatchObject({ from: 'PAYMENT_QUEUED', to: 'PAID', actor: { kind: 'human', id: 'demo-controller' } });
        }
        expect((await confirm('demo-controller', 2)).json().code).toBe('RUN_CLOSED');
      });

      it('the database refuses a run confirmed by its creator', async () => {
        await expect(owner.query("UPDATE payment_runs SET closed_by = created_by WHERE id = $1", [runId])).rejects.toThrow(/check constraint/);
      });

      it('a paid invoice is terminal', async () => {
        const res = await transitionTo(invoiceIds[0] as string, 'HOLD', 'demo-cfo', { reasons: ['POLICY_MANUAL_REVIEW_REQUIRED'] });
        expect(res.statusCode).toBe(409);
      });
    });

    it('lists runs newest first and filters by status', async () => {
      const all = contract.PaymentRunList.parse(await get('/v1/payment-runs'));
      expect(all.items.length).toBeGreaterThanOrEqual(5);
      const times = all.items.map((r) => r.createdAt);
      expect(times).toEqual([...times].sort().reverse());
      const paid = await get('/v1/payment-runs?status=paid');
      expect(paid.items.length).toBeGreaterThanOrEqual(1);
      expect(paid.items.every((r: { status: string }) => r.status === 'paid')).toBe(true);
    });

    it('an unknown run is 404', async () => {
      expect((await inject('GET', `/v1/payment-runs/${randomUUID()}`)).statusCode).toBe(404);
    });
  });

  describe('audit checkpoints', () => {
    let cp: Record<string, unknown>;

    it('a clerk cannot sign', async () => {
      expect((await inject('POST', '/v1/audit/checkpoints', 'demo-clerk', undefined, null)).json().code).toBe('ROLE_INSUFFICIENT');
    });

    it('signs the head once; the same head returns the same checkpoint', async () => {
      const res = await inject('POST', '/v1/audit/checkpoints', 'demo-manager', undefined, null);
      expect(res.statusCode).toBe(201);
      cp = contract.AuditCheckpoint.parse(res.json());
      const verify = await get('/v1/audit/verify');
      expect(cp['seq']).toBe(verify.entries - 1);
      const again = await inject('POST', '/v1/audit/checkpoints', 'demo-cfo', undefined, null);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(cp);
    });

    it('lists it with the current key', async () => {
      const list = await get('/v1/audit/checkpoints');
      expect(list.items[0]).toEqual(cp);
      expect(list.currentKeyId).toBe(cp['keyId']);
    });

    it('verify counts checkpoints alongside the chain', async () => {
      expect(contract.AuditVerification.parse(await get('/v1/audit/verify'))).toMatchObject({ ok: true, checkpointsChecked: 1 });
    });

    it('a kept copy verifies, and a new entry does not disturb it', async () => {
      await invoice({ vendorName: 'After Checkpoint' });
      const res = await inject('POST', '/v1/audit/checkpoints/verify', 'demo-user', cp, null);
      expect(contract.AuditCheckpointVerification.parse(res.json())).toEqual({ ok: true, trustedKey: true, seq: cp['seq'] });
    });

    it('an edited copy fails', async () => {
      const res = await inject('POST', '/v1/audit/checkpoints/verify', 'demo-user', { ...cp, seq: 0 }, null);
      expect(res.json()).toMatchObject({ ok: false, reason: 'statement does not match the checkpoint fields' });
    });

    it('a malformed copy is a 400', async () => {
      expect((await inject('POST', '/v1/audit/checkpoints/verify', 'demo-user', { hash: 'x' }, null)).statusCode).toBe(400);
    });

    it('the stored checkpoints cannot be edited or deleted', async () => {
      await expect(owner.query('DELETE FROM audit_checkpoints')).rejects.toThrow(/append-only/);
      await expect(owner.query("UPDATE audit_checkpoints SET hash = repeat('0', 64)")).rejects.toThrow(/append-only/);
    });

    it('a wholesale rewrite of the chain passes the chain check but not the checkpoint', async () => {
      // An attacker with the owner role edits an early entry and re-hashes everything after it.
      await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
      try {
        const { rows } = await owner.query<{
          tenant_id: string;
          seq: string;
          invoice_id: string;
          type: string;
          actor: { kind: string; id: string };
          occurred_at: Date;
          payload: Record<string, unknown>;
        }>('SELECT * FROM audit_log ORDER BY seq');
        const rebuilt: AuditEntry[] = [];
        for (const r of rows) {
          const payload = Number(r.seq) === 1 ? { ...r.payload, forged: true } : r.payload;
          rebuilt.push(
            appendEntry(rebuilt, { tenantId: r.tenant_id, invoiceId: r.invoice_id, type: r.type, actor: r.actor, occurredAt: r.occurred_at.toISOString(), payload }),
          );
        }
        for (const e of rebuilt) {
          await owner.query('UPDATE audit_log SET payload = $3, prev_hash = $4, hash = $5 WHERE tenant_id = $1 AND seq = $2', [
            e.tenantId,
            e.seq,
            JSON.stringify(e.payload),
            e.prevHash,
            e.hash,
          ]);
        }
      } finally {
        await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
      }

      const verify = await get('/v1/audit/verify');
      expect(verify).toMatchObject({ ok: false, checkpointsChecked: 1, brokenAt: cp['seq'] });
      expect(verify.reason).toMatch(/^checkpoint mismatch: .*rewritten/);

      const external = await inject('POST', '/v1/audit/checkpoints/verify', 'demo-user', cp, null);
      expect(external.json()).toMatchObject({ ok: false, trustedKey: true });

      const sign = await inject('POST', '/v1/audit/checkpoints', 'demo-manager', undefined, null);
      // The rewritten chain is internally consistent, so signing it succeeds; the
      // stored checkpoint is what exposes the rewrite.
      expect([200, 201]).toContain(sign.statusCode);
    });
  });
});
