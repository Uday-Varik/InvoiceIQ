import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  INVOICE_STATES,
  REASON_CATALOG,
  REASON_CODES,
  TRANSITIONS,
  evaluateTransition,
  isInvoiceState,
  isReasonCode,
  type ActorKind,
  type InvoiceState,
  type ReasonCode,
} from '../domain/index.js';
import { AuthError, demoAuthenticator, type Authenticator, type Principal } from '../auth/auth.js';
import { withTenant, type Db } from '../db/pool.js';
import { DEMO_TENANT_ID } from '../db/bootstrap.js';
import { verifyTenantChain } from '../invoices/audit.js';
import { MAX_UPLOAD_BYTES, humanTransition, readInvoice, uploadInvoice } from '../invoices/service.js';
import { getDocument, getInvoice, listInvoices, type SourceChannel } from '../invoices/store.js';
import { decodeCursor, encodeCursor, toInvoice } from '../invoices/view.js';
import { idempotencyKeyOf } from './idempotency.js';
import { HttpProblem, problemBody } from './problem.js';

/**
 * HTTP surface. Every route here must exist in
 * packages/contracts/openapi/core-api.yaml, and every x-phase 0 and 1 operation
 * there must be listed here (enforced by tests/guardrails).
 */
export const IMPLEMENTED_ROUTES = [
  'GET /healthz',
  'GET /v1/lifecycle/states',
  'GET /v1/reason-codes',
  'POST /v1/lifecycle/evaluate',
  'GET /v1/invoices',
  'POST /v1/invoices',
  'GET /v1/invoices/{invoiceId}',
  'GET /v1/invoices/{invoiceId}/document',
  'POST /v1/invoices/{invoiceId}/approve',
  'POST /v1/invoices/{invoiceId}/reject',
  'POST /v1/invoices/{invoiceId}/transitions',
  'GET /v1/audit/verify',
] as const;

export interface AppDeps {
  readonly db: Db;
  /** Nudged after a write that enqueues work (wake-and-drain). */
  readonly worker?: { kick(): void };
}

export interface AppOptions {
  readonly logger?: boolean;
  /** Defaults to the demo principal, which is what tests and local runs want. */
  readonly auth?: Authenticator;
  readonly deps?: AppDeps;
  readonly maxUploadBytes?: number;
}

export const DEMO_PRINCIPAL: Principal = { tenantId: DEMO_TENANT_ID, userId: 'demo-user', roles: ['cfo'] };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new HttpProblem(401, 'Unauthorized', 'no authenticated principal');
  return req.principal;
}

const UUID_PARAM = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const REASONS_SCHEMA = { type: 'array', items: { type: 'string' }, maxItems: 18 } as const;
const COMMENT_SCHEMA = { type: 'string', maxLength: 2000 } as const;

const ACTOR_KINDS: readonly ActorKind[] = ['system', 'human', 'ai'];

interface EvaluateBody {
  from: string;
  to: string;
  actor: { kind: string; id: string };
  reasons?: string[];
}

function problem(status: number, title: string, detail: string) {
  return problemBody(status, title, detail);
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true });
  const auth = opts.auth ?? demoAuthenticator(DEMO_PRINCIPAL);
  const deps = opts.deps;
  const maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;

  app.decorateRequest('principal', null);
  void app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 4, fieldSize: 1024, parts: 5 } });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/')) return;
    try {
      req.principal = await auth.authenticate(req.headers.authorization);
    } catch (err) {
      if (err instanceof AuthError) throw new HttpProblem(401, 'Unauthorized', err.message);
      throw err;
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof HttpProblem) {
      if (err.status === 401) void reply.header('www-authenticate', 'Bearer');
      return reply.code(err.status).type('application/problem+json').send(problemBody(err.status, err.title, err.detail, err.code));
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).type('application/problem+json').send(problemBody(413, 'Document too large', `the limit is ${maxUploadBytes} bytes`));
    }
    if (err.validation || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      return reply.code(400).type('application/problem+json').send(problemBody(400, 'Invalid request', err.message));
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).type('application/problem+json').send(problemBody(err.statusCode, 'Invalid request', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).type('application/problem+json').send(problemBody(500, 'Internal error', 'something went wrong'));
  });

  const needDeps = (): AppDeps => {
    if (!deps) throw new HttpProblem(503, 'Unavailable', 'this instance has no database configured');
    return deps;
  };

  app.get('/healthz', () => ({ status: 'ok', service: 'core-api' }));

  app.get('/v1/lifecycle/states', () => ({
    states: INVOICE_STATES.map((s) => ({ state: s, next: TRANSITIONS[s] })),
  }));

  app.get('/v1/reason-codes', () => ({
    reasonCodes: REASON_CODES.map((code) => {
      const r = REASON_CATALOG[code];
      return { code, source: r.source, severity: r.severity, allowedOutcomes: r.allowedOutcomes, description: r.description };
    }),
  }));

  app.post<{ Body: EvaluateBody }>(
    '/v1/lifecycle/evaluate',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to', 'actor'],
          additionalProperties: false,
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            actor: {
              type: 'object',
              required: ['kind', 'id'],
              additionalProperties: false,
              properties: { kind: { type: 'string' }, id: { type: 'string', minLength: 1 } },
            },
            reasons: { type: 'array', items: { type: 'string' }, maxItems: 18 },
          },
        },
      },
    },
    async (req, reply) => {
      const { from, to, actor } = req.body;
      const reasons = req.body.reasons ?? [];
      if (!isInvoiceState(from) || !isInvoiceState(to)) {
        return reply.code(422).send(problem(422, 'Unknown state', 'from and to must be invoice lifecycle states'));
      }
      if (!(ACTOR_KINDS as readonly string[]).includes(actor.kind)) {
        return reply.code(422).send(problem(422, 'Unknown actor kind', 'actor.kind must be system, human or ai'));
      }
      const unknown = reasons.find((r) => !isReasonCode(r));
      if (unknown !== undefined) {
        return reply.code(422).send(problem(422, 'Unknown reason code', `${unknown} is not in the reason catalog`));
      }
      const result = evaluateTransition({
        from,
        to,
        actor: { kind: actor.kind as ActorKind, id: actor.id },
        reasons: reasons as ReasonCode[],
      });
      return result.ok
        ? { allowed: true, from, to }
        : { allowed: false, from, to, error: result.error, message: result.message };
    },
  );

  registerInvoiceRoutes(app, needDeps);
  return app;
}

function registerInvoiceRoutes(app: FastifyInstance, needDeps: () => AppDeps): void {
  app.get<{ Querystring: { state?: string; cursor?: string; limit?: number } }>(
    '/v1/invoices',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: [...INVOICE_STATES] },
            cursor: { type: 'string', maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      const { db } = needDeps();
      const p = principalOf(req);
      const cursor = req.query.cursor === undefined ? undefined : decodeCursor(req.query.cursor);
      if (req.query.cursor !== undefined && !cursor) throw new HttpProblem(400, 'Invalid cursor', 'cursor is not one this API issued');
      const limit = req.query.limit ?? 50;
      const rows = await withTenant(db, p.tenantId, (tx) =>
        listInvoices(tx, { limit: limit + 1, ...(req.query.state ? { state: req.query.state as InvoiceState } : {}), ...(cursor ? { cursor } : {}) }),
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map((r) => toInvoice(r)), ...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}) };
    },
  );

  app.post('/v1/invoices', async (req, reply) => {
    const deps = needDeps();
    const p = principalOf(req);
    const key = idempotencyKeyOf(req.headers['idempotency-key']);
    if (!req.isMultipart()) throw new HttpProblem(415, 'Unsupported media type', 'send multipart/form-data with a file part');
    let content: Buffer | undefined;
    let filename: string | undefined;
    let sourceChannel: SourceChannel = 'upload';
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') throw new HttpProblem(400, 'Invalid request', 'the file part must be named "file"');
        content = await part.toBuffer();
        filename = part.filename;
      } else if (part.fieldname === 'sourceChannel') {
        const v = String(part.value);
        if (v !== 'upload' && v !== 'email' && v !== 'api') throw new HttpProblem(400, 'Invalid request', 'sourceChannel must be upload, email or api');
        sourceChannel = v;
      } else {
        throw new HttpProblem(400, 'Invalid request', `unexpected field ${part.fieldname}`);
      }
    }
    if (!content) throw new HttpProblem(400, 'Invalid request', 'missing file part');
    const out = await uploadInvoice(deps.db, p, { content, filename, sourceChannel, idempotencyKey: key });
    if (!out.replayed) deps.worker?.kick();
    return reply.code(out.status).header('idempotent-replayed', String(out.replayed)).send(out.body);
  });

  app.get<{ Params: { invoiceId: string } }>(
    '/v1/invoices/:invoiceId',
    { schema: { params: { type: 'object', required: ['invoiceId'], properties: { invoiceId: UUID_PARAM } } } },
    async (req) => readInvoice(needDeps().db, principalOf(req), req.params.invoiceId),
  );

  app.get<{ Params: { invoiceId: string } }>(
    '/v1/invoices/:invoiceId/document',
    { schema: { params: { type: 'object', required: ['invoiceId'], properties: { invoiceId: UUID_PARAM } } } },
    async (req, reply) => {
      const p = principalOf(req);
      const found = await withTenant(needDeps().db, p.tenantId, async (tx) => {
        const inv = await getInvoice(tx, req.params.invoiceId);
        if (!inv) return undefined;
        const doc = await getDocument(tx, inv.document_sha256);
        return doc ? { inv, doc } : undefined;
      });
      if (!found) throw new HttpProblem(404, 'Not found', `no invoice ${req.params.invoiceId}`);
      return reply
        .type(found.doc.contentType)
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(found.inv.document_filename)}`)
        .header('cache-control', 'private, max-age=300')
        .header('x-content-type-options', 'nosniff')
        .send(found.doc.content);
    },
  );

  const idParams = { type: 'object', required: ['invoiceId'], properties: { invoiceId: UUID_PARAM } } as const;

  app.post<{ Params: { invoiceId: string }; Body: { comment?: string } | undefined }>(
    '/v1/invoices/:invoiceId/approve',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { comment: COMMENT_SCHEMA } } } },
    async (req, reply) => {
      const deps = needDeps();
      const out = await humanTransition(deps.db, principalOf(req), {
        operation: 'approveInvoice',
        invoiceId: req.params.invoiceId,
        to: 'APPROVED',
        idempotencyKey: idempotencyKeyOf(req.headers['idempotency-key']),
        ...(req.body?.comment ? { comment: req.body.comment } : {}),
      });
      if (!out.replayed) deps.worker?.kick();
      return reply.code(out.status).header('idempotent-replayed', String(out.replayed)).send(out.body);
    },
  );

  app.post<{ Params: { invoiceId: string }; Body: { reasons: string[]; comment?: string } }>(
    '/v1/invoices/:invoiceId/reject',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['reasons'],
          additionalProperties: false,
          properties: { reasons: { ...REASONS_SCHEMA, minItems: 1 }, comment: COMMENT_SCHEMA },
        },
      },
    },
    async (req, reply) => {
      const deps = needDeps();
      const out = await humanTransition(deps.db, principalOf(req), {
        operation: 'rejectInvoice',
        invoiceId: req.params.invoiceId,
        to: 'REJECTED',
        reasons: req.body.reasons,
        idempotencyKey: idempotencyKeyOf(req.headers['idempotency-key']),
        ...(req.body.comment ? { comment: req.body.comment } : {}),
      });
      if (!out.replayed) deps.worker?.kick();
      return reply.code(out.status).header('idempotent-replayed', String(out.replayed)).send(out.body);
    },
  );

  app.post<{ Params: { invoiceId: string }; Body: { to: string; reasons?: string[]; comment?: string } }>(
    '/v1/invoices/:invoiceId/transitions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['to'],
          additionalProperties: false,
          properties: { to: { type: 'string', enum: [...INVOICE_STATES] }, reasons: REASONS_SCHEMA, comment: COMMENT_SCHEMA },
        },
      },
    },
    async (req, reply) => {
      const deps = needDeps();
      const out = await humanTransition(deps.db, principalOf(req), {
        operation: 'transitionInvoice',
        invoiceId: req.params.invoiceId,
        to: req.body.to as InvoiceState,
        idempotencyKey: idempotencyKeyOf(req.headers['idempotency-key']),
        ...(req.body.reasons ? { reasons: req.body.reasons } : {}),
        ...(req.body.comment ? { comment: req.body.comment } : {}),
      });
      if (!out.replayed) deps.worker?.kick();
      return reply.code(out.status).header('idempotent-replayed', String(out.replayed)).send(out.body);
    },
  );

  app.get('/v1/audit/verify', async (req) => {
    const p = principalOf(req);
    const { entries, result } = await withTenant(needDeps().db, p.tenantId, (tx) => verifyTenantChain(tx, p.tenantId));
    return result.ok ? { ok: true, entries } : { ok: false, entries, brokenAt: result.brokenAt, reason: result.reason };
  });
}
