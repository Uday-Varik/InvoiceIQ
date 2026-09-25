import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signRequest, type ExtractionResult } from '../../src/clients/ai-service.js';

export const STUB_SECRET = 'stub-signing-secret-0123456789abcdef';

type Field = { value: string | null; confidence: number };
export type StubFields = ExtractionResult['fields'];

export const GOOD_FIELDS: StubFields = {
  vendorName: { value: 'ACME Industrial Supply', confidence: 0.95 },
  invoiceNumber: { value: 'INV-2026-0042', confidence: 0.95 },
  invoiceDate: { value: '2026-03-14', confidence: 0.95 },
  currency: { value: 'USD', confidence: 0.95 },
  totalMinor: { value: '123450', confidence: 0.95 },
  subtotalMinor: { value: null, confidence: 0 },
  taxMinor: { value: null, confidence: 0 },
  dueDate: { value: null, confidence: 0 },
};

/** The two body lines of the sample invoice; they add up to GOOD_FIELDS.totalMinor. */
export const GOOD_LINES: ExtractionResult['lineItems'] = [
  { description: 'Hex bolts M8 x 200', quantity: null, unitPriceMinor: null, amountMinor: '41200', confidence: 0.6 },
  { description: 'Safety gloves x 40', quantity: null, unitPriceMinor: null, amountMinor: '82250', confidence: 0.6 },
];

export type StubMode =
  | { kind: 'fields'; fields: StubFields; lineItems?: ExtractionResult['lineItems'] }
  | { kind: 'status'; status: number };

/**
 * A stand-in ai-service that speaks the contract over real HTTP and checks the
 * HMAC signature exactly like the Python service does. Signals mirror
 * ai_service/signals.py: any money field below the threshold holds.
 */
export class AiStub {
  mode: StubMode = { kind: 'fields', fields: GOOD_FIELDS };
  readonly calls: Array<{ path: string; signed: boolean }> = [];
  private server: Server | undefined;
  url = '';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const path = req.url ?? '/';
        const ts = Number(req.headers['x-iiq-timestamp']);
        const signed = req.headers['x-iiq-signature'] === signRequest(STUB_SECRET, ts, req.method ?? 'GET', path, body);
        this.calls.push({ path, signed });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (path === '/healthz') return send(200, { status: 'ok', service: 'ai-service' });
        if (!signed) return send(401, { type: 'about:blank', title: 'Unauthorized', status: 401 });
        const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        if (path === '/v1/extract/document') {
          if (this.mode.kind === 'status') return send(this.mode.status, { type: 'about:blank', title: 'stub', status: this.mode.status });
          return send(200, { documentSha256: json['documentSha256'], provider: 'stub', fields: this.mode.fields, lineItems: this.mode.lineItems ?? [] });
        }
        if (path === '/v1/signals') {
          const extraction = json['extraction'] as ExtractionResult;
          const threshold = json['extractionConfidenceHoldBelow'] as number;
          const low = (['vendorName', 'invoiceNumber', 'currency', 'totalMinor'] as const).filter((k) => {
            const f: Field = extraction.fields[k];
            return f.value === null || f.confidence < threshold;
          });
          return send(200, {
            signals: low.length
              ? [{ reasonCode: 'AI_EXTRACTION_LOW_CONFIDENCE', outcome: 'HOLD', score: 0.9, evidence: low.join(', ') }]
              : [],
          });
        }
        return send(404, { type: 'about:blank', title: 'Not found', status: 404 });
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
