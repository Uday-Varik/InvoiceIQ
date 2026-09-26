import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { httpAiClient } from '../../src/clients/ai-service.js';
import type { Authenticator } from '../../src/auth/auth.js';
import { createPool, type Db } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import type { OutboxWorker } from '../../src/outbox/worker.js';
import type { CoreMetrics } from '../../src/observability/catalog.js';
import { createWorker, outboxCollector } from '../../src/runtime.js';
import { STUB_SECRET, type AiStub } from './ai-stub.js';

export interface Harness {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly worker: OutboxWorker;
  close(): Promise<void>;
}

/** The real app and worker on a real database; only ai-service is a (signed-HTTP) stub. */
export function harness(appUrl: string, ai: AiStub, opts: { auth?: Authenticator; maxAttempts?: number; metrics?: CoreMetrics } = {}): Harness {
  const db = createPool(appUrl);
  const m = opts.metrics;
  const client = httpAiClient({
    baseUrl: ai.url,
    signingSecret: STUB_SECRET,
    timeoutMs: 5_000,
    ...(m
      ? {
          observe: (operation, outcome, seconds) => {
            m.aiRequests.inc({ operation, outcome });
            m.aiDuration.observe(seconds, { operation });
          },
        }
      : {}),
  });
  const worker = createWorker(db, client, { maxAttempts: opts.maxAttempts ?? 3, ...(m ? { metrics: m } : {}) });
  if (m) m.registry.addCollector(outboxCollector(db, m));
  // No kick: tests drain explicitly so each assertion sees a settled state.
  const app = buildApp({
    ...(opts.auth ? { auth: opts.auth } : {}),
    deps: { db },
    maxUploadBytes: 64 * 1024,
    ...(m ? { metrics: m } : {}),
    aiPing: () => client.ping?.() ?? Promise.resolve(false),
  });
  return {
    app,
    db,
    worker,
    async close() {
      await app.close();
      await worker.stop();
      await db.end();
    },
  };
}

export function multipart(file: Buffer, filename = 'invoice.pdf', fields: Record<string, string> = {}) {
  const boundary = `----iq${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export const key = () => `test-${randomUUID()}`;
