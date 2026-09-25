import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cancelPaymentRun,
  confirmPaymentRun,
  createCheckpoint,
  createPaymentRun,
  getMe,
  listVendors,
  paymentFileUrl,
  requestBankChange,
  setVendorStatus,
  verifyBankChange,
  type AuditCheckpoint,
  type Invoice,
  type Me,
  type PaymentRun,
  type Vendor,
} from '../lib/api';
import {
  approvalProgress,
  approveBlocker,
  canAssemble,
  checkpointText,
  confirmBlocker,
  covers,
  dutiesFromHistory,
  parseCheckpoint,
  paymentStatusText,
  runResultText,
  runTotal,
  sha256Hex,
  validateCallbackNote,
  validateLast4,
} from '../lib/controls';
import { personaCookie, personaFromCookie, personaLabel, personaOptions, roleLabel } from '../lib/personas';

const me = (userId: string, roles: Me['roles']): Me => ({ userId, roles, tenantId: '00000000-0000-4000-8000-00000000d3e0', authMode: 'demo' });

function invoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '00000000-0000-4000-8000-00000000d3e0',
    state: 'PENDING_APPROVAL',
    reasons: [],
    version: 7,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    approvalTier: { name: 'manager', role: 'ap_manager', required: 1 },
    approvals: [],
    history: [
      { seq: 1, type: 'invoice.received', actor: { kind: 'human', id: 'demo-clerk' }, occurredAt: '2026-05-01T00:00:00Z' },
      { seq: 2, type: 'invoice.transitioned', actor: { kind: 'system', id: 'core-api:pipeline' }, occurredAt: '2026-05-01T00:00:01Z' },
    ],
    ...over,
  };
}

function run(over: Partial<PaymentRun> = {}): PaymentRun {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    currency: 'USD',
    status: 'queued',
    invoiceCount: 2,
    total: { amountMinor: '123450', currency: 'USD' },
    version: 1,
    createdBy: 'demo-manager',
    createdAt: '2026-05-01T00:00:00Z',
    ...over,
  };
}

describe('personas', () => {
  it('labels known personas and falls back to the id', () => {
    expect(personaLabel('demo-manager')).toBe('Maria, AP manager');
    expect(personaLabel('auth0|123')).toBe('auth0|123');
  });

  it('builds the cookie that selects a persona', () => {
    expect(personaCookie('demo-clerk')).toBe('iq_demo_persona=demo-clerk; Path=/; Max-Age=2592000; SameSite=Lax');
    expect(personaCookie('demo-cfo', 1)).toContain('Max-Age=86400');
  });

  it('builds the cookie that clears it', () => {
    expect(personaCookie(null)).toBe('iq_demo_persona=; Path=/; Max-Age=0; SameSite=Lax');
  });

  it.each(['Demo; x=1', 'a b', '', 'x'.repeat(41), '<script>'])('refuses a cookie-breaking persona id %j', (id) => {
    expect(() => personaCookie(id)).toThrow(RangeError);
  });

  it('reads the persona back from document.cookie', () => {
    expect(personaFromCookie('a=1; iq_demo_persona=demo-controller; b=2')).toBe('demo-controller');
    expect(personaFromCookie('iq_demo_persona=')).toBeUndefined();
    expect(personaFromCookie('')).toBeUndefined();
  });

  it('labels roles', () => {
    expect(['ap_clerk', 'ap_manager', 'controller', 'cfo', 'other'].map(roleLabel)).toEqual(['AP clerk', 'AP manager', 'Controller', 'CFO', 'other']);
  });

  it('offers the default user first, then each persona once', () => {
    const m = { ...me('demo-manager', ['ap_manager']), personas: [{ id: 'demo-clerk', roles: ['ap_clerk'] as Me['roles'] }, { id: 'demo-manager', roles: ['ap_manager'] as Me['roles'] }] };
    expect(personaOptions(m).map((p) => p.id)).toEqual(['demo-user', 'demo-clerk', 'demo-manager']);
  });
});

describe('covers', () => {
  it.each([
    [['cfo'], 'controller', true],
    [['controller'], 'controller', true],
    [['ap_manager'], 'controller', false],
    [[], 'ap_clerk', false],
    [['unknown'], 'ap_clerk', false],
  ] as Array<[string[], 'ap_clerk' | 'controller', boolean]>)('%j covers %s: %s', (roles, need, expected) => {
    expect(covers(roles, need)).toBe(expected);
  });
});

describe('approvals on the review screen', () => {
  it('shows progress only while pending with a tier', () => {
    expect(approvalProgress(invoice())).toEqual({ have: 0, need: 1, text: '0 of 1 approval' });
    expect(approvalProgress(invoice({ state: 'APPROVED' }))).toBeUndefined();
    const noTier = Object.fromEntries(Object.entries(invoice()).filter(([k]) => k !== 'approvalTier')) as Invoice;
    expect(approvalProgress(noTier)).toBeUndefined();
  });

  it('counts only approvals at the current version', () => {
    const inv = invoice({
      approvalTier: { name: 'cfo', role: 'cfo', required: 2 },
      approvals: [
        { approverId: 'demo-cfo', role: 'cfo', approvedAt: '2026-05-01T00:00:00Z', current: false },
        { approverId: 'demo-deputy-cfo', role: 'cfo', approvedAt: '2026-05-02T00:00:00Z', current: true },
      ],
    });
    expect(approvalProgress(inv)).toEqual({ have: 1, need: 2, text: '1 of 2 approvals' });
  });

  it('reads the uploader and correctors from history', () => {
    const inv = invoice({
      history: [
        ...(invoice().history ?? []),
        { seq: 3, type: 'invoice.corrected', actor: { kind: 'human', id: 'demo-manager' }, occurredAt: '2026-05-01T00:00:02Z' },
      ],
    });
    const d = dutiesFromHistory(inv);
    expect(d.uploader).toBe('demo-clerk');
    expect([...d.correctors]).toEqual(['demo-manager']);
  });

  it('no history means no known duties', () => {
    const bare = Object.fromEntries(Object.entries(invoice()).filter(([k]) => k !== 'history')) as Invoice;
    expect(dutiesFromHistory(bare)).toEqual({ correctors: new Set() });
  });

  it('explains a missing role first', () => {
    expect(approveBlocker(me('demo-clerk', ['ap_clerk']), invoice())).toMatch(/needs the manager tier/);
  });

  it('blocks the uploader', () => {
    expect(approveBlocker(me('demo-clerk', ['cfo']), invoice())).toBe('You uploaded this invoice, so someone else must approve it.');
  });

  it('blocks a corrector', () => {
    const inv = invoice({
      history: [...(invoice().history ?? []), { seq: 3, type: 'invoice.corrected', actor: { kind: 'human', id: 'demo-manager' }, occurredAt: 'x' }],
    });
    expect(approveBlocker(me('demo-manager', ['ap_manager']), inv)).toMatch(/You corrected/);
  });

  it('blocks a second approval by the same person, but not an old one', () => {
    const cur = invoice({ approvals: [{ approverId: 'demo-cfo', role: 'cfo', approvedAt: 'x', current: true }] });
    expect(approveBlocker(me('demo-cfo', ['cfo']), cur)).toMatch(/already approved/);
    const old = invoice({ approvals: [{ approverId: 'demo-cfo', role: 'cfo', approvedAt: 'x', current: false }] });
    expect(approveBlocker(me('demo-cfo', ['cfo']), old)).toBeUndefined();
  });

  it('lets an eligible person try, and says nothing before /v1/me answers or outside PENDING_APPROVAL', () => {
    expect(approveBlocker(me('demo-manager', ['ap_manager']), invoice())).toBeUndefined();
    expect(approveBlocker(undefined, invoice())).toBeUndefined();
    expect(approveBlocker(me('demo-clerk', ['ap_clerk']), invoice({ state: 'HOLD' }))).toBeUndefined();
  });
});

describe('vendor payment status', () => {
  const v = (payment: Vendor['payment'], status: Vendor['status'] = 'active') => ({ payment, status });
  const now = new Date('2026-05-10T00:00:00Z');

  it.each([
    [{ blocked: false }, 'Can be paid'],
    [{ blocked: true, reason: 'VENDOR_INACTIVE' }, 'Inactive: payments blocked'],
    [{ blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', why: 'UNVERIFIED', releasesAt: null }, 'Bank change awaiting callback verification'],
    [{ blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', why: 'SELF_VERIFIED', releasesAt: null }, 'Bank change verified by its requester: blocked'],
    [{ blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', why: 'WINDOW_OPEN', releasesAt: '2026-05-11T01:30:00Z' }, 'Bank change in quarantine: releases in 26 h'],
    [{ blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', why: 'WINDOW_OPEN', releasesAt: '2026-05-01T00:00:00Z' }, 'Bank change in quarantine: releases in 0 h'],
    [{ blocked: true, reason: 'VENDOR_BANK_CHANGE_QUARANTINE', why: 'WINDOW_OPEN' }, 'Bank change in quarantine'],
  ] as Array<[Vendor['payment'], string]>)('%j reads %j', (payment, text) => {
    expect(paymentStatusText(v(payment), now)).toBe(text);
  });
});

describe('bank change inputs', () => {
  it.each([
    ['1234', '1234'],
    [' ab12 ', 'AB12'],
    ['ZZ99', 'ZZ99'],
  ])('accepts %j as %j', (raw, value) => {
    expect(validateLast4(raw)).toEqual({ ok: true, value });
  });

  it.each(['123', '12345', '12-4', '', 'äbcd'])('refuses %j', (raw) => {
    expect(validateLast4(raw).ok).toBe(false);
  });

  it('asks for a callback note that says something', () => {
    expect(validateCallbackNote('ok')).toMatch(/who you called/);
    expect(validateCallbackNote('          ')).toMatch(/who you called/);
    expect(validateCallbackNote('Called Jane on the number on file')).toBeUndefined();
    expect(validateCallbackNote('x'.repeat(2001))).toBe('At most 2000 characters');
  });

  it('hashes evidence with SHA-256, matching node', async () => {
    const bytes = new TextEncoder().encode('vendor letter');
    expect(await sha256Hex(bytes.buffer as ArrayBuffer)).toBe(createHash('sha256').update('vendor letter').digest('hex'));
  });

  it('hashes an empty file too', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('payment runs', () => {
  it('formats the total', () => {
    expect(runTotal(run())).toBe('1,234.50 USD');
  });

  it('only a manager or above may assemble', () => {
    expect(canAssemble(me('a', ['ap_clerk']))).toBe(false);
    expect(canAssemble(me('a', ['ap_manager']))).toBe(true);
    expect(canAssemble(undefined)).toBe(false);
  });

  it('confirming needs a controller who did not assemble the run', () => {
    expect(confirmBlocker(me('demo-manager', ['ap_manager']), run())).toMatch(/controller or CFO/);
    expect(confirmBlocker(me('demo-manager', ['cfo']), run())).toBe('Maria, AP manager assembled this run, so someone else must confirm it.');
    expect(confirmBlocker(me('demo-controller', ['controller']), run())).toBeUndefined();
  });

  it('a closed run cannot be confirmed by anyone', () => {
    expect(confirmBlocker(me('demo-controller', ['controller']), run({ status: 'paid' }))).toBe('The run is paid.');
    expect(confirmBlocker(undefined, run({ status: 'cancelled' }))).toBe('The run is cancelled.');
  });

  it('says what assembling did', () => {
    expect(runResultText({ run: run(), held: [], skipped: [] })).toBe('Queued 2 invoices for 1,234.50 USD.');
    expect(runResultText({ run: run({ invoiceCount: 1 }), held: [{ invoiceId: 'x', reason: 'VENDOR_INACTIVE' }], skipped: [] })).toBe(
      'Queued 1 invoice for 1,234.50 USD. 1 held because the vendor cannot be paid now.',
    );
    expect(runResultText({ run: null, held: [], skipped: [] })).toBe('Nothing to pay.');
  });
});

describe('checkpoints', () => {
  const cp: AuditCheckpoint = {
    v: 1,
    tenantId: '00000000-0000-4000-8000-00000000d3e0',
    seq: 12,
    hash: 'a'.repeat(64),
    createdAt: '2026-05-10T00:00:00.000Z',
    keyId: '0123456789abcdef',
    statement: '{"createdAt":"2026-05-10T00:00:00.000Z"}',
    signature: 'c2ln',
    publicKey: 'cHVi',
    createdBy: 'demo-manager',
  };

  it('saves exactly the fields needed to verify, without who signed it', () => {
    const text = checkpointText(cp);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['v', 'tenantId', 'seq', 'hash', 'createdAt', 'keyId', 'statement', 'signature', 'publicKey']);
    expect(text).not.toContain('demo-manager');
  });

  it('parses a saved copy back', () => {
    expect(parseCheckpoint(checkpointText(cp))).toEqual({ ok: true, checkpoint: JSON.parse(checkpointText(cp)) as AuditCheckpoint });
  });

  it('drops extra fields from a pasted copy', () => {
    const r = parseCheckpoint(JSON.stringify({ ...cp, note: 'mine' }));
    expect(r.ok && 'note' in r.checkpoint).toBe(false);
  });

  it.each([
    ['not json', /exactly as it was saved/],
    ['[1,2]', /JSON object/],
    ['null', /JSON object/],
    ['{"v":1}', /Missing tenantId/],
  ])('explains a bad paste %j', (text, error) => {
    const r = parseCheckpoint(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(error);
  });

  it('refuses other versions and non-integer entries', () => {
    expect(parseCheckpoint(JSON.stringify({ ...cp, v: 2 })).ok).toBe(false);
    expect(parseCheckpoint(JSON.stringify({ ...cp, seq: '12' })).ok).toBe(false);
    expect(parseCheckpoint(JSON.stringify({ ...cp, seq: 1.5 })).ok).toBe(false);
  });
});

describe('Phase 3 API client', () => {
  function recorder(body: unknown = {}, status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = ((url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    }) as typeof fetch;
    return { calls, fn };
  }
  const headers = (init: RequestInit) => init.headers as Record<string, string>;

  it('reads who I am', async () => {
    const r = recorder(me('demo-user', ['cfo']));
    expect((await getMe(r.fn)).userId).toBe('demo-user');
    expect(r.calls[0]?.url).toBe('/api/core/v1/me');
  });

  it('searches vendors, trimming the query', async () => {
    const r = recorder({ items: [] });
    await listVendors('  acme ', r.fn);
    await listVendors('', r.fn);
    expect(r.calls.map((c) => c.url)).toEqual(['/api/core/v1/vendors?limit=200&q=acme', '/api/core/v1/vendors?limit=200']);
  });

  it('records a bank change with the evidence hash and a key', async () => {
    const r = recorder({}, 202);
    await requestBankChange('v1', '1234', 'f'.repeat(64), 'key-0123456789abcdef', r.fn);
    const c = r.calls[0];
    expect(c?.url).toBe('/api/core/v1/vendors/v1/bank-changes');
    expect(c?.init.method).toBe('POST');
    expect(JSON.parse(c?.init.body as string)).toEqual({ ibanOrAccountLast4: '1234', evidenceDocumentSha256: 'f'.repeat(64) });
    expect(headers(c!.init)['idempotency-key']).toBe('key-0123456789abcdef');
  });

  it('verifies a bank change', async () => {
    const r = recorder();
    await verifyBankChange('v 1', 'c/2', 'Called Jane on file', 'k'.repeat(16), r.fn);
    expect(r.calls[0]?.url).toBe('/api/core/v1/vendors/v%201/bank-changes/c%2F2/verify');
    expect(JSON.parse(r.calls[0]?.init.body as string)).toEqual({ callbackNote: 'Called Jane on file' });
  });

  it('changes vendor status with the version it saw', async () => {
    const r = recorder();
    await setVendorStatus('v1', 3, 'inactive', undefined, 'k'.repeat(16), r.fn);
    expect(r.calls[0]?.init.method).toBe('PATCH');
    expect(JSON.parse(r.calls[0]?.init.body as string)).toEqual({ expectedVersion: 3, status: 'inactive' });
  });

  it('assembles, confirms and cancels runs', async () => {
    const r = recorder();
    await createPaymentRun('EUR', 'weekly', 'k'.repeat(16), r.fn);
    await confirmPaymentRun('r1', 1, undefined, 'k'.repeat(16), r.fn);
    await cancelPaymentRun('r1', 2, 'wrong account', 'k'.repeat(16), r.fn);
    expect(r.calls.map((c) => [c.url, JSON.parse(c.init.body as string) as unknown])).toEqual([
      ['/api/core/v1/payment-runs', { currency: 'EUR', comment: 'weekly' }],
      ['/api/core/v1/payment-runs/r1/confirm', { expectedVersion: 1 }],
      ['/api/core/v1/payment-runs/r1/cancel', { expectedVersion: 2, comment: 'wrong account' }],
    ]);
  });

  it('links the payment file through the proxy', () => {
    expect(paymentFileUrl('r 1')).toBe('/api/core/v1/payment-runs/r%201/file');
  });

  it('signs a checkpoint without an idempotency key (it is idempotent per head)', async () => {
    const r = recorder({}, 201);
    await createCheckpoint(r.fn);
    expect(r.calls[0]?.url).toBe('/api/core/v1/audit/checkpoints');
    expect(headers(r.calls[0]!.init)['idempotency-key']).toBeUndefined();
  });

  it('surfaces a separation-of-duties refusal as its detail', async () => {
    const r = recorder({ title: 'Separation of duties', status: 403, detail: 'the person who assembled a payment run cannot confirm it', code: 'SEPARATION_OF_DUTIES' }, 403);
    await expect(confirmPaymentRun('r1', 1, undefined, 'k'.repeat(16), r.fn)).rejects.toMatchObject({
      status: 403,
      message: 'the person who assembled a payment run cannot confirm it',
      problem: { code: 'SEPARATION_OF_DUTIES' },
    });
  });
});
