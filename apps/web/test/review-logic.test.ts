import { describe, expect, it } from 'vitest';
import { ApiError, approveInvoice, rejectInvoice, uploadInvoice } from '../lib/api';
import { actionsFor, confidenceLevel, formatMoney, IN_FLIGHT } from '../lib/format';
import { waitForBackend, type BackendStatus } from '../lib/wake';

describe('formatMoney', () => {
  it.each([
    ['123450', 'USD', '1,234.50 USD'],
    ['5', 'EUR', '0.05 EUR'],
    ['-100', 'GBP', '-1.00 GBP'],
    ['9223372036854775807', 'USD', '92,233,720,368,547,758.07 USD'],
  ])('%s %s -> %s', (minor, cur, out) => {
    expect(formatMoney(minor, cur)).toBe(out);
  });
});

describe('review rules', () => {
  it('offers approve only from PENDING_APPROVAL, and release only from HOLD', () => {
    expect(actionsFor('PENDING_APPROVAL')).toEqual(['approve', 'reject']);
    expect(actionsFor('HOLD')).toEqual(['sendToApproval', 'reject']);
    expect(actionsFor('EXCEPTION')).toEqual(['reject']);
    for (const s of ['APPROVED', 'REJECTED', 'EXTRACTING', 'PAID'] as const) expect(actionsFor(s)).toEqual([]);
  });

  it('keeps polling only while the pipeline owns the invoice', () => {
    expect(IN_FLIGHT.has('EXTRACTING')).toBe(true);
    expect(IN_FLIGHT.has('PENDING_APPROVAL')).toBe(false);
    expect(IN_FLIGHT.has('HOLD')).toBe(false);
  });

  it('bands confidence the way the hold threshold does', () => {
    expect([0.95, 0.8, 0.4].map(confidenceLevel)).toEqual(['high', 'medium', 'low']);
  });
});

describe('api client', () => {
  const recorder = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fn };
  };

  it('uploads as multipart with a fresh Idempotency-Key through the same-origin proxy', async () => {
    const { calls, fn } = recorder(201, { id: 'x' });
    await uploadInvoice(new File(['%PDF-'], 'a.pdf'), fn);
    expect(calls[0]?.url).toBe('/api/core/v1/invoices');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toMatch(/^web-[0-9a-f-]{36}$/);
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
  });

  it('reuses the caller-provided key so a retry cannot act twice', async () => {
    const { calls, fn } = recorder(200, { id: 'x' });
    await approveInvoice('id-1', undefined, 'web-fixed-key-000000', fn);
    await approveInvoice('id-1', undefined, 'web-fixed-key-000000', fn);
    expect(calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key'])).toEqual(['web-fixed-key-000000', 'web-fixed-key-000000']);
  });

  it('surfaces problem details as ApiError', async () => {
    const { fn } = recorder(422, { title: 'Transition refused', status: 422, detail: 'DUPLICATE_NEAR does not allow outcome REJECTED' });
    await expect(rejectInvoice('id', ['DUPLICATE_NEAR'], undefined, 'k'.repeat(20), fn)).rejects.toThrow(ApiError);
  });
});

describe('waking the demo', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it('reports waking, then ready, when the backend answers after a few tries', async () => {
    let n = 0;
    const fetchFn = (async () => (++n < 4 ? new Response('bad gateway', { status: 502 }) : Response.json({ status: 'ok' }))) as unknown as typeof fetch;
    const seen: BackendStatus[] = [];
    const c = clock();
    const result = await waitForBackend({ url: '/h', fetchFn, onStatus: (s) => seen.push(s), ...c });
    expect(result).toBe('ready');
    expect(seen).toEqual(['checking', 'waking', 'ready']);
    expect(n).toBe(4);
  });

  it('skips the waking state when the backend is already up', async () => {
    const seen: BackendStatus[] = [];
    await waitForBackend({ url: '/h', fetchFn: (async () => Response.json({ status: 'ok' })) as unknown as typeof fetch, onStatus: (s) => seen.push(s) });
    expect(seen).toEqual(['checking', 'ready']);
  });

  it('gives up and says so', async () => {
    const seen: BackendStatus[] = [];
    const c = clock();
    const result = await waitForBackend({
      url: '/h',
      fetchFn: (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch,
      onStatus: (s) => seen.push(s),
      giveUpAfterMs: 10_000,
      ...c,
    });
    expect(result).toBe('down');
    expect(seen.at(-1)).toBe('down');
  });
});
