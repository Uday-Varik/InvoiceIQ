import { describe, expect, it } from 'vitest';
import { AiRejectedError, AiUnavailableError, httpAiClient, signRequest } from '../src/clients/ai-service.js';

// Same vector as services/ai-service/tests/test_signing.py, so both sides agree byte for byte.
const KNOWN_VECTOR = 'v1=9c05c47e58b0806a6223c14a1003cfecb004622005d6474e7df5c9d1ed26ed04';

const GOOD = {
  documentSha256: 'a'.repeat(64),
  provider: 'heuristic',
  fields: Object.fromEntries(['vendorName', 'invoiceNumber', 'invoiceDate', 'currency', 'totalMinor'].map((k) => [k, { value: 'x', confidence: 0.9 }])),
};

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit | undefined }> = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const req = { tenantId: '5f0c7d9e-2b1a-4c3d-8e9f-0a1b2c3d4e5f', documentSha256: 'a'.repeat(64), contentType: 'application/pdf' as const, content: Buffer.from('%PDF-') };

describe('ai-service client', () => {
  it('signs exactly like ai-service verifies', () => {
    expect(signRequest('k'.repeat(32), 1_700_000_000, 'post', '/v1/extract', '{}')).toBe(KNOWN_VECTOR);
  });

  it('sends a signed request over the exact body it sends', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = httpAiClient({ baseUrl: 'http://ai/', signingSecret: 's'.repeat(32), fetch: fakeFetch(200, GOOD, seen), now: () => 42 });
    await client.extractDocument(req);
    const { url, init } = seen[0]!;
    expect(url).toBe('http://ai/v1/extract/document');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-iiq-timestamp']).toBe('42');
    expect(headers['x-iiq-signature']).toBe(signRequest('s'.repeat(32), 42, 'POST', '/v1/extract/document', init?.body as string));
    expect(JSON.parse(init?.body as string).contentBase64).toBe(Buffer.from('%PDF-').toString('base64'));
  });

  it.each([500, 502, 503, 429])('treats %i as unavailable (retry later)', async (status) => {
    const client = httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: fakeFetch(status, {}) });
    await expect(client.extractDocument(req)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('treats a network error as unavailable', async () => {
    const client = httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
    await expect(client.signals({ extraction: GOOD as never, extractionConfidenceHoldBelow: 0.8 })).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it.each([400, 401, 422])('treats %i as a rejection (do not retry)', async (status) => {
    const client = httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: fakeFetch(status, {}) });
    await expect(client.extractDocument(req)).rejects.toBeInstanceOf(AiRejectedError);
  });

  it('refuses an off-contract body, including a signal that is not HOLD', async () => {
    const extra = httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: fakeFetch(200, { ...GOOD, approve: true }) });
    await expect(extra.extractDocument(req)).rejects.toThrow(/off-contract/);
    const approve = httpAiClient({
      baseUrl: 'http://ai',
      signingSecret: 's'.repeat(32),
      fetch: fakeFetch(200, { signals: [{ reasonCode: 'AI_ANOMALY_SUSPECTED', outcome: 'APPROVED', score: 1, evidence: '' }] }),
    });
    await expect(approve.signals({ extraction: GOOD as never, extractionConfidenceHoldBelow: 0.8 })).rejects.toThrow(/off-contract/);
    const text = httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: fakeFetch(200, '<html>') });
    await expect(text.extractDocument(req)).rejects.toThrow(/non-JSON/);
  });

  it('wake never throws', async () => {
    const client = httpAiClient({ baseUrl: 'http://ai', signingSecret: 's'.repeat(32), fetch: (() => Promise.reject(new Error('down'))) as typeof fetch });
    await expect(client.wake()).resolves.toBeUndefined();
  });
});
