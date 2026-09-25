import Fastify, { type FastifyInstance } from 'fastify';
import {
  INVOICE_STATES,
  REASON_CATALOG,
  REASON_CODES,
  TRANSITIONS,
  evaluateTransition,
  isInvoiceState,
  isReasonCode,
  type ActorKind,
  type ReasonCode,
} from '../domain/index.js';

/**
 * Phase 0 HTTP surface: health plus read-only views of the domain model and a
 * dry-run transition evaluator. Every route here must exist in
 * packages/contracts/openapi/core-api.yaml (enforced by tests/guardrails).
 */
export const IMPLEMENTED_ROUTES = [
  'GET /healthz',
  'GET /v1/lifecycle/states',
  'GET /v1/reason-codes',
  'POST /v1/lifecycle/evaluate',
] as const;

const ACTOR_KINDS: readonly ActorKind[] = ['system', 'human', 'ai'];

interface EvaluateBody {
  from: string;
  to: string;
  actor: { kind: string; id: string };
  reasons?: string[];
}

function problem(status: number, title: string, detail: string) {
  return { type: 'about:blank', title, status, detail };
}

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

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

  return app;
}
