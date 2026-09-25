import type { FastifyInstance } from 'fastify';
import { httpAiClient, type AiClient } from './clients/ai-service.js';
import { demoAuthenticator, oidcAuthenticator, remoteKeys, type Authenticator } from './auth/auth.js';
import type { Config } from './config.js';
import { bootstrapTenant, DEMO_TENANT_ID } from './db/bootstrap.js';
import { migrate } from './db/migrate.js';
import { createPool, type Db } from './db/pool.js';
import { buildApp, DEMO_PRINCIPAL } from './http/app.js';
import { holdForManualReview, processReceived } from './invoices/pipeline.js';
import { OutboxWorker, type WorkerLogger } from './outbox/worker.js';

export function authenticatorFor(config: Config): Authenticator {
  if (config.AUTH_MODE === 'demo') return demoAuthenticator(DEMO_PRINCIPAL);
  return oidcAuthenticator({
    issuer: config.OIDC_ISSUER as string,
    audience: config.OIDC_AUDIENCE as string,
    keys: remoteKeys(config.OIDC_JWKS_URL as string),
    tenantClaim: config.OIDC_TENANT_CLAIM,
    rolesClaim: config.OIDC_ROLES_CLAIM,
  });
}

export function createWorker(db: Db, ai: AiClient, opts: { pollMs?: number; maxAttempts?: number; log?: WorkerLogger } = {}): OutboxWorker {
  return new OutboxWorker(db, {
    handlers: {
      'invoice.received': (e) => processReceived({ db, ai }, e.tenantId, String(e.payload['invoiceId'])),
      // No external subscriber yet; consuming marks the event delivered.
      'invoice.state_changed': () => Promise.resolve(),
    },
    onDead: async (e) => {
      if (e.topic === 'invoice.received') {
        await holdForManualReview(db, e.tenantId, String(e.payload['invoiceId']), 'extraction_unavailable', 'ai-service did not answer within the retry budget');
      }
    },
    ...opts,
  });
}

export interface Runtime {
  readonly app: FastifyInstance;
  readonly db: Db;
  readonly worker: OutboxWorker;
  close(): Promise<void>;
}

/** Wire the process: migrate, bootstrap the demo tenant if asked, build the app, start the drain. */
export async function startRuntime(config: Config): Promise<Runtime> {
  const ai = httpAiClient({ baseUrl: config.AI_SERVICE_URL, signingSecret: config.AI_SIGNING_SECRET, timeoutMs: config.AI_TIMEOUT_MS });
  // ai-service scales to zero too. Start waking it now, in parallel with our own boot.
  void ai.wake();

  if (config.MIGRATION_DATABASE_URL) {
    await migrate(config.MIGRATION_DATABASE_URL);
    if (config.AUTH_MODE === 'demo') {
      await bootstrapTenant(config.MIGRATION_DATABASE_URL, { id: DEMO_TENANT_ID, name: config.DEMO_TENANT_NAME });
    }
  }

  const db = createPool(config.DATABASE_URL);
  const app = buildApp({ logger: true, auth: authenticatorFor(config), maxUploadBytes: config.MAX_UPLOAD_BYTES, deps: { db, worker: { kick: () => worker.kick() } } });
  const worker = createWorker(db, ai, { pollMs: config.OUTBOX_POLL_MS, maxAttempts: config.OUTBOX_MAX_ATTEMPTS, log: app.log });
  worker.start();

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
