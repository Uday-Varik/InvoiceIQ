import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SignedCheckpoint } from '../domain/index.js';
import { DEMO_PERSONAS, type Authenticator, type Principal } from '../auth/auth.js';
import { createCheckpoint, listCheckpoints, verifyExternalCheckpoint, type CheckpointSigner } from '../audit/checkpoints.js';
import { cancelPaymentRun, confirmPaymentRun, createPaymentRun, paymentFile, readPaymentRun, readPaymentRuns } from '../payments/service.js';
import type { PaymentRunStatus } from '../payments/store.js';
import { createVendor, readVendor, readVendors, requestBankChange, updateVendor, verifyBankChange } from '../vendors/service.js';
import type { VendorStatus } from '../domain/index.js';
import type { Db } from '../db/pool.js';
import { idempotencyKeyOf, type StoredResponse } from './idempotency.js';

/**
 * Phase 3 routes: vendors and bank changes, payment runs, signed audit
 * checkpoints, and who-am-I. Listed in IMPLEMENTED_ROUTES in app.ts.
 */

const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const COMMENT = { type: 'string', maxLength: 2000 } as const;
const CURRENCY = { type: 'string', pattern: '^[A-Z]{3}$' } as const;
const VERSION = { type: 'integer', minimum: 1 } as const;
const LIMIT = { type: 'integer', minimum: 1, maximum: 200, default: 50 } as const;

export interface ControlsContext {
  readonly db: () => { db: Db; worker?: { kick(): void } };
  readonly principalOf: (req: FastifyRequest) => Principal;
  readonly signer: CheckpointSigner;
  readonly auth: Authenticator;
}

function send(reply: FastifyReply, out: StoredResponse & { replayed: boolean }) {
  return reply.code(out.status).header('idempotent-replayed', String(out.replayed)).send(out.body);
}

export function registerControlsRoutes(app: FastifyInstance, ctx: ControlsContext): void {
  const keyOf = (req: FastifyRequest) => idempotencyKeyOf(req.headers['idempotency-key']);
  const kicked = (out: StoredResponse & { replayed: boolean }) => {
    if (!out.replayed) ctx.db().worker?.kick();
    return out;
  };

  app.get('/v1/me', async (req) => {
    const p = ctx.principalOf(req);
    return {
      userId: p.userId,
      tenantId: p.tenantId,
      roles: p.roles,
      authMode: ctx.auth.mode,
      ...(ctx.auth.mode === 'demo' ? { personas: Object.entries(DEMO_PERSONAS).map(([id, roles]) => ({ id, roles })) } : {}),
    };
  });

  // Vendors -----------------------------------------------------------------

  app.get<{ Querystring: { q?: string; limit?: number } }>(
    '/v1/vendors',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', minLength: 1, maxLength: 100 }, limit: LIMIT },
        },
      },
    },
    async (req) => readVendors(ctx.db().db, ctx.principalOf(req), { limit: req.query.limit ?? 50, ...(req.query.q ? { q: req.query.q } : {}) }),
  );

  app.post<{ Body: { name: string } }>(
    '/v1/vendors',
    {
      schema: {
        body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 256 } } },
      },
    },
    async (req, reply) => send(reply, await createVendor(ctx.db().db, ctx.principalOf(req), req.body.name, keyOf(req))),
  );

  const vendorParams = { type: 'object', required: ['vendorId'], properties: { vendorId: UUID } } as const;

  app.get<{ Params: { vendorId: string } }>('/v1/vendors/:vendorId', { schema: { params: vendorParams } }, async (req) =>
    readVendor(ctx.db().db, ctx.principalOf(req), req.params.vendorId),
  );

  app.patch<{ Params: { vendorId: string }; Body: { expectedVersion: number; status: VendorStatus; comment?: string } }>(
    '/v1/vendors/:vendorId',
    {
      schema: {
        params: vendorParams,
        body: {
          type: 'object',
          required: ['expectedVersion', 'status'],
          additionalProperties: false,
          properties: { expectedVersion: VERSION, status: { type: 'string', enum: ['active', 'inactive'] }, comment: COMMENT },
        },
      },
    },
    async (req, reply) => send(reply, await updateVendor(ctx.db().db, ctx.principalOf(req), req.params.vendorId, req.body, keyOf(req))),
  );

  app.post<{ Params: { vendorId: string }; Body: { ibanOrAccountLast4: string; evidenceDocumentSha256: string } }>(
    '/v1/vendors/:vendorId/bank-changes',
    {
      schema: {
        params: vendorParams,
        body: {
          type: 'object',
          required: ['ibanOrAccountLast4', 'evidenceDocumentSha256'],
          additionalProperties: false,
          properties: {
            ibanOrAccountLast4: { type: 'string', pattern: '^[0-9A-Z]{4}$' },
            evidenceDocumentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      },
    },
    async (req, reply) => send(reply, kicked(await requestBankChange(ctx.db().db, ctx.principalOf(req), req.params.vendorId, req.body, keyOf(req)))),
  );

  app.post<{ Params: { vendorId: string; changeId: string }; Body: { callbackNote: string } }>(
    '/v1/vendors/:vendorId/bank-changes/:changeId/verify',
    {
      schema: {
        params: { type: 'object', required: ['vendorId', 'changeId'], properties: { vendorId: UUID, changeId: UUID } },
        body: {
          type: 'object',
          required: ['callbackNote'],
          additionalProperties: false,
          properties: { callbackNote: { type: 'string', minLength: 10, maxLength: 2000, pattern: '\\S' } },
        },
      },
    },
    async (req, reply) =>
      send(reply, await verifyBankChange(ctx.db().db, ctx.principalOf(req), req.params.vendorId, req.params.changeId, req.body, keyOf(req))),
  );

  // Payment runs --------------------------------------------------------------

  app.get<{ Querystring: { status?: PaymentRunStatus; limit?: number } }>(
    '/v1/payment-runs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', enum: ['queued', 'paid', 'cancelled'] }, limit: LIMIT },
        },
      },
    },
    async (req) =>
      readPaymentRuns(ctx.db().db, ctx.principalOf(req), { limit: req.query.limit ?? 50, ...(req.query.status ? { status: req.query.status } : {}) }),
  );

  app.post<{ Body: { currency: string; invoiceIds?: string[]; comment?: string } }>(
    '/v1/payment-runs',
    {
      schema: {
        body: {
          type: 'object',
          required: ['currency'],
          additionalProperties: false,
          properties: {
            currency: CURRENCY,
            invoiceIds: { type: 'array', minItems: 1, maxItems: 500, items: UUID },
            comment: COMMENT,
          },
        },
      },
    },
    async (req, reply) => send(reply, kicked(await createPaymentRun(ctx.db().db, ctx.principalOf(req), req.body, keyOf(req)))),
  );

  const runParams = { type: 'object', required: ['runId'], properties: { runId: UUID } } as const;

  app.get<{ Params: { runId: string } }>('/v1/payment-runs/:runId', { schema: { params: runParams } }, async (req) =>
    readPaymentRun(ctx.db().db, ctx.principalOf(req), req.params.runId),
  );

  app.get<{ Params: { runId: string } }>('/v1/payment-runs/:runId/file', { schema: { params: runParams } }, async (req, reply) => {
    const file = await paymentFile(ctx.db().db, ctx.principalOf(req), req.params.runId);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(file.csv);
  });

  const closeBody = (commentRequired: boolean) =>
    ({
      type: 'object',
      required: commentRequired ? ['expectedVersion', 'comment'] : ['expectedVersion'],
      additionalProperties: false,
      properties: { expectedVersion: VERSION, comment: commentRequired ? { ...COMMENT, minLength: 1 } : COMMENT },
    }) as const;

  app.post<{ Params: { runId: string }; Body: { expectedVersion: number; comment?: string } }>(
    '/v1/payment-runs/:runId/confirm',
    { schema: { params: runParams, body: closeBody(false) } },
    async (req, reply) => send(reply, kicked(await confirmPaymentRun(ctx.db().db, ctx.principalOf(req), req.params.runId, req.body, keyOf(req)))),
  );

  app.post<{ Params: { runId: string }; Body: { expectedVersion: number; comment: string } }>(
    '/v1/payment-runs/:runId/cancel',
    { schema: { params: runParams, body: closeBody(true) } },
    async (req, reply) => send(reply, kicked(await cancelPaymentRun(ctx.db().db, ctx.principalOf(req), req.params.runId, req.body, keyOf(req)))),
  );

  // Audit checkpoints ---------------------------------------------------------

  app.get<{ Querystring: { limit?: number } }>(
    '/v1/audit/checkpoints',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { limit: LIMIT } } } },
    async (req) => listCheckpoints(ctx.db().db, ctx.principalOf(req), ctx.signer, req.query.limit ?? 50),
  );

  app.post('/v1/audit/checkpoints', async (req, reply) => {
    const out = await createCheckpoint(ctx.db().db, ctx.principalOf(req), ctx.signer);
    return reply.code(out.status).send(out.body);
  });

  app.post<{ Body: SignedCheckpoint }>(
    '/v1/audit/checkpoints/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['v', 'tenantId', 'seq', 'hash', 'createdAt', 'keyId', 'statement', 'signature', 'publicKey'],
          // Extra fields a stored copy may carry (createdBy) are ignored, not refused.
          properties: {
            v: { type: 'integer', const: 1 },
            tenantId: UUID,
            seq: { type: 'integer', minimum: 0 },
            hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            createdAt: { type: 'string', maxLength: 40 },
            keyId: { type: 'string', pattern: '^[0-9a-f]{16}$' },
            statement: { type: 'string', maxLength: 1000 },
            signature: { type: 'string', maxLength: 200 },
            publicKey: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    async (req) => verifyExternalCheckpoint(ctx.db().db, ctx.principalOf(req), ctx.signer, req.body),
  );
}
