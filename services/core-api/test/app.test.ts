import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { INVOICE_STATES, REASON_CODES } from '../src/domain/index.js';

const app = buildApp();
afterAll(async () => {
  await app.close();
});

describe('core-api http', () => {
  it('GET /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'core-api' });
  });

  it('GET /v1/lifecycle/states lists all 14 states', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/lifecycle/states' });
    expect(res.json().states.map((s: { state: string }) => s.state)).toEqual(INVOICE_STATES);
  });

  it('GET /v1/reason-codes lists all 18 codes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/reason-codes' });
    expect(res.json().reasonCodes.map((r: { code: string }) => r.code)).toEqual(REASON_CODES);
  });

  it('POST /v1/lifecycle/evaluate allows a valid human approval', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle/evaluate',
      payload: { from: 'PENDING_APPROVAL', to: 'APPROVED', actor: { kind: 'human', id: 'u1' } },
    });
    expect(res.json()).toEqual({ allowed: true, from: 'PENDING_APPROVAL', to: 'APPROVED' });
  });

  it('POST /v1/lifecycle/evaluate refuses an AI approval', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/lifecycle/evaluate',
      payload: { from: 'PENDING_APPROVAL', to: 'APPROVED', actor: { kind: 'ai', id: 'ai-service' } },
    });
    expect(res.json()).toMatchObject({ allowed: false, error: 'AI_MAY_ONLY_HOLD' });
  });

  it.each([
    [{ from: 'NOPE', to: 'HOLD', actor: { kind: 'human', id: 'u' } }, 'Unknown state'],
    [{ from: 'RECEIVED', to: 'HOLD', actor: { kind: 'robot', id: 'u' } }, 'Unknown actor kind'],
    [{ from: 'RECEIVED', to: 'HOLD', actor: { kind: 'human', id: 'u' }, reasons: ['NOPE'] }, 'Unknown reason code'],
  ])('POST /v1/lifecycle/evaluate returns 422 for %j', async (payload, title) => {
    const res = await app.inject({ method: 'POST', url: '/v1/lifecycle/evaluate', payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().title).toBe(title);
  });

  it('POST /v1/lifecycle/evaluate returns 400 for a malformed body', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/lifecycle/evaluate', payload: { from: 'RECEIVED' } });
    expect(res.statusCode).toBe(400);
  });
});
