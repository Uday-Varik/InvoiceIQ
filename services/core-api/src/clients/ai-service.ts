import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { outgoingTraceparent } from '../observability/trace.js';

/**
 * Signed HTTP client for ai-service. ai-service is advisory: nothing it returns
 * can change an invoice by itself; core-api feeds its output through the
 * lifecycle gate, where AI reasons can only produce HOLD (ADR-0007).
 */

const Field = z.object({ value: z.string().nullable(), confidence: z.number().min(0).max(1) }).strict();
/** Fields added in Phase 2. An older ai-service omits them; they then read as unknown, never as guessed. */
const LaterField = Field.default({ value: null, confidence: 0 });

const LineItem = z
  .object({
    description: z.string().min(1).max(500),
    quantity: z.string().regex(/^[0-9]{1,12}(\.[0-9]{1,4})?$/).nullable(),
    unitPriceMinor: z.string().regex(/^-?[0-9]{1,19}$/).nullable(),
    amountMinor: z.string().regex(/^-?[0-9]{1,19}$/).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const ExtractionResultSchema = z
  .object({
    documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
    provider: z.string(),
    fields: z
      .object({
        vendorName: Field,
        invoiceNumber: Field,
        invoiceDate: Field,
        currency: Field,
        totalMinor: Field,
        subtotalMinor: LaterField,
        taxMinor: LaterField,
        dueDate: LaterField,
      })
      .strict(),
    lineItems: z.array(LineItem).max(200).default([]),
  })
  .strict();

export const SignalResponseSchema = z
  .object({
    signals: z.array(
      z
        .object({
          reasonCode: z.enum(['AI_EXTRACTION_LOW_CONFIDENCE', 'AI_ANOMALY_SUSPECTED', 'AI_DOCUMENT_TAMPERING_SUSPECTED', 'AI_SEMANTIC_DUPLICATE_SUSPECTED']),
          outcome: z.literal('HOLD'),
          score: z.number().min(0).max(1),
          evidence: z.string().max(2000),
        })
        .strict(),
    ),
  })
  .strict();

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ExtractedLineItem = ExtractionResult['lineItems'][number];
export type SignalResponse = z.infer<typeof SignalResponseSchema>;
export type ExtractableContentType = 'application/pdf' | 'image/png' | 'image/jpeg';

export interface AiClient {
  extractDocument(req: {
    tenantId: string;
    documentSha256: string;
    contentType: ExtractableContentType;
    content: Buffer;
  }): Promise<ExtractionResult>;
  signals(req: { extraction: ExtractionResult; extractionConfidenceHoldBelow: number }): Promise<SignalResponse>;
  /** Fire a health check so a scaled-to-zero ai-service starts booting early. Never throws. */
  wake(): Promise<void>;
  /** Whether ai-service answers its health check right now. Never throws. */
  ping?(): Promise<boolean>;
}

export type AiOperation = 'extract_document' | 'signals';
export type AiOutcome = 'ok' | 'unavailable' | 'rejected';

/** Network failure, timeout or 5xx: worth retrying later (a cold start looks like this). */
export class AiUnavailableError extends Error {
  override name = 'AiUnavailableError';
}

/** 4xx: the request itself is unusable. Retrying will not help. */
export class AiRejectedError extends Error {
  override name = 'AiRejectedError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function signRequest(secret: string, timestamp: number, method: string, path: string, body: string | Buffer): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const message = `${timestamp}.${method.toUpperCase()}.${path}.${bodyHash}`;
  return `v1=${createHmac('sha256', secret).update(message).digest('hex')}`;
}

export interface HttpAiClientOptions {
  readonly baseUrl: string;
  readonly signingSecret: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Told about every call once its outcome is known (metrics). */
  readonly observe?: (operation: AiOperation, outcome: AiOutcome, seconds: number) => void;
}

export function httpAiClient(opts: HttpAiClientOptions): AiClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  async function post<T>(operation: AiOperation, path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await call(path, payload, schema);
      opts.observe?.(operation, 'ok', (performance.now() - started) / 1000);
      return result;
    } catch (err) {
      opts.observe?.(operation, err instanceof AiRejectedError ? 'rejected' : 'unavailable', (performance.now() - started) / 1000);
      throw err;
    }
  }

  async function call<T>(path: string, payload: unknown, schema: z.ZodType<T>): Promise<T> {
    const body = JSON.stringify(payload);
    const traceparent = outgoingTraceparent();
    const ts = now();
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-iiq-timestamp': String(ts),
          'x-iiq-signature': signRequest(opts.signingSecret, ts, 'POST', path, body),
          ...(traceparent ? { traceparent } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AiUnavailableError(`ai-service ${path} unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (res.status >= 500 || res.status === 429) throw new AiUnavailableError(`ai-service ${path} returned ${res.status}`);
    if (!res.ok) throw new AiRejectedError(res.status, `ai-service ${path} refused the request (${res.status}): ${text.slice(0, 300)}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiRejectedError(res.status, `ai-service ${path} returned non-JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new AiRejectedError(res.status, `ai-service ${path} returned an off-contract body`);
    return parsed.data;
  }

  return {
    extractDocument: (req) =>
      post(
        'extract_document',
        '/v1/extract/document',
        {
          tenantId: req.tenantId,
          documentSha256: req.documentSha256,
          contentType: req.contentType,
          contentBase64: req.content.toString('base64'),
        },
        ExtractionResultSchema,
      ),
    signals: (req) => post('signals', '/v1/signals', req, SignalResponseSchema),
    async wake() {
      try {
        await doFetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        // Waking is best-effort; the outbox retries real calls.
      }
    },
    async ping() {
      try {
        const res = await doFetch(`${base}/healthz`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 2_000)) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
