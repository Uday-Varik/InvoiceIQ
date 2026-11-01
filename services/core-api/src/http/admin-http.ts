import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.js';
import { recordAuthEvent, listAuthEvents } from '../auth/audit.js';
import { requirePermission } from '../auth/require.js';
import { hashClientIp } from '../auth/session.js';
import { revokeSessionsForTenant } from '../auth/session.js';
import { createTenantRecord, listTenants, getTenant, type TenantCreateInput } from './admin-routes.js';
import {
  checkMemberChange,
  findMembership,
  listTenantUsers,
  removeTenantUser,
  updateTenantUser,
  upsertTenantUser,
  type TenantUser,
} from '../tenants/store.js';
import type { Pool } from 'pg';
import type { ApproverRole } from '../domain/index.js';
import { HttpProblem } from './problem.js';

export interface AdminContext {
  readonly ownerConnectionString: string;
  readonly ownerPool: Pool;
  readonly principalOf: (req: FastifyRequest) => Principal;
  readonly requireAdmin: (req: FastifyRequest) => void;
}

const UUID_PARAM = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;

export function registerAdminRoutes(app: FastifyInstance, ctx: AdminContext): void {
  /**
   * Tenant-scoped admin gate. requireAdmin (cfo/controller) alone used to
   * be enough, which let a CFO of tenant A manage tenant B. In session
   * mode the caller must also be a member of the target tenant, and hold
   * members:manage there (owners hold every permission). In demo/OIDC
   * modes there are no memberships, so the role gate is the only check
   * and the membership is undefined.
   */
  async function requireTenantMembership(
    req: FastifyRequest,
    tenantId: string,
    manage: boolean,
  ): Promise<TenantUser | undefined> {
    ctx.requireAdmin(req);
    const p = ctx.principalOf(req);
    if (!p.provider || !p.externalId) return undefined;
    const membership = await findMembership(ctx.ownerPool, p.provider, p.externalId, tenantId);
    if (!membership) {
      throw new HttpProblem(403, 'Forbidden', 'you are not a member of this tenant', 'TENANT_FORBIDDEN');
    }
    if (manage) requirePermission(p, 'members:manage', 'managing tenant members', membership.isOwner);
    return membership;
  }

  function identityOf(p: { userId: string; provider?: string | undefined; externalId?: string | undefined }): {
    provider: string;
    externalId: string;
    login: string;
  } {
    return { provider: p.provider ?? 'github', externalId: p.externalId ?? p.userId, login: p.userId };
  }

  async function audit(
    req: FastifyRequest,
    tenantId: string | undefined,
    provider: string,
    externalId: string,
    login: string,
    event: Parameters<typeof recordAuthEvent>[1]['event'],
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await recordAuthEvent(ctx.ownerPool, {
      tenantId,
      provider,
      externalId,
      login,
      event,
      detail,
      ipHash: hashClientIp(req.ip),
    });
  }
  app.get<{ Querystring: { limit?: number } }>(
    '/v1/admin/tenants',
    { schema: { querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } } } },
    async (req) => {
      ctx.requireAdmin(req);
      const tenants = await listTenants(ctx.ownerConnectionString, req.query.limit);
      return { items: tenants };
    },
  );

  app.post<{ Body: TenantCreateInput }>(
    '/v1/admin/tenants',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            baseCurrency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
        },
      },
    },
    async (req, reply) => {
      ctx.requireAdmin(req);
      const tenant = await createTenantRecord(ctx.ownerConnectionString, req.body);
      // Auto-add the creator as an owner of the new tenant
      const p = ctx.principalOf(req);
      const identity = identityOf(p);
      await upsertTenantUser(ctx.ownerPool, {
        tenantId: tenant.id,
        provider: identity.provider,
        externalId: identity.externalId,
        login: identity.login,
        roles: ['cfo' as ApproverRole],
        isOwner: true,
      });
      return reply.code(201).send(tenant);
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId',
    { schema: { params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } } } },
    async (req) => {
      await requireTenantMembership(req, req.params.tenantId, false);
      const tenant = await getTenant(ctx.ownerConnectionString, req.params.tenantId);
      if (!tenant) throw new HttpProblem(404, 'Not found', `no tenant ${req.params.tenantId}`);
      return tenant;
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId/users',
    { schema: { params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } } } },
    async (req) => {
      await requireTenantMembership(req, req.params.tenantId, true);
      const users = await listTenantUsers(ctx.ownerPool, req.params.tenantId);
      return { items: users };
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { login: string; provider?: string; externalId?: string; roles?: string[]; isOwner?: boolean } }>(
    '/v1/admin/tenants/:tenantId/users',
    {
      schema: {
        params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } },
        body: {
          type: 'object',
          required: ['login'],
          properties: {
            login: { type: 'string', minLength: 1, maxLength: 100 },
            provider: { type: 'string', enum: ['github', 'google', 'apple', 'credentials'] },
            externalId: { type: 'string', minLength: 1, maxLength: 200 },
            roles: { type: 'array', items: { type: 'string', enum: ['ap_clerk', 'ap_manager', 'controller', 'cfo'] }, maxItems: 4 },
            isOwner: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const caller = await requireTenantMembership(req, req.params.tenantId, true);
      const provider = req.body.provider ?? 'github';
      const externalId = req.body.externalId ?? req.body.login;
      const roles = (req.body.roles ?? ['ap_clerk']) as ApproverRole[];
      const before = await findMembership(ctx.ownerPool, provider, externalId, req.params.tenantId);
      let user = await upsertTenantUser(ctx.ownerPool, {
        tenantId: req.params.tenantId,
        provider,
        externalId,
        login: req.body.login,
        roles,
        ...(req.body.isOwner !== undefined ? { isOwner: req.body.isOwner } : {}),
      });
      // Re-adding an existing member updates their roles/owner flag too:
      // the upsert only refreshes login/last-used, so apply changes here.
      const changed =
        before !== undefined &&
        (JSON.stringify([...before.roles].sort()) !== JSON.stringify([...roles].sort()) ||
          (req.body.isOwner !== undefined && before.isOwner !== req.body.isOwner));
      if (changed) {
        const updated = await updateTenantUser(ctx.ownerPool, req.params.tenantId, user.id, {
          roles,
          ...(req.body.isOwner !== undefined ? { isOwner: req.body.isOwner } : {}),
        });
        if (updated) user = updated;
        await revokeSessionsForTenant(ctx.ownerPool, provider, externalId, req.params.tenantId);
      }
      const p = ctx.principalOf(req);
      await audit(req, req.params.tenantId, p.provider ?? 'github', p.externalId ?? p.userId, p.userId, before ? 'member_updated' : 'member_added', {
        targetLogin: user.login,
        roles: user.roles,
        isOwner: user.isOwner,
        by: caller?.login ?? p.userId,
      });
      return reply.code(201).send(user);
    },
  );

  app.patch<{ Params: { tenantId: string; userId: string }; Body: { roles?: string[]; isOwner?: boolean } }>(
    '/v1/admin/tenants/:tenantId/users/:userId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['tenantId', 'userId'],
          properties: { tenantId: UUID_PARAM, userId: UUID_PARAM },
        },
        body: {
          type: 'object',
          properties: {
            roles: { type: 'array', items: { type: 'string', enum: ['ap_clerk', 'ap_manager', 'controller', 'cfo'] }, maxItems: 4, minItems: 1 },
            isOwner: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const caller = await requireTenantMembership(req, req.params.tenantId, true);
      if (req.body.roles === undefined && req.body.isOwner === undefined) {
        throw new HttpProblem(400, 'Validation', 'roles or isOwner is required', 'VALIDATION');
      }
      const members = await listTenantUsers(ctx.ownerPool, req.params.tenantId);
      const p = ctx.principalOf(req);
      const guard = checkMemberChange(members, {
        targetId: req.params.userId,
        callerId: caller?.id ?? '',
        ...(req.body.roles !== undefined ? { nextRoles: req.body.roles as ApproverRole[] } : {}),
        ...(req.body.isOwner !== undefined ? { nextIsOwner: req.body.isOwner } : {}),
      });
      if (guard) throw new HttpProblem(403, 'Forbidden', guard, 'MEMBER_GUARDRAIL');
      const updated = await updateTenantUser(ctx.ownerPool, req.params.tenantId, req.params.userId, {
        ...(req.body.roles !== undefined ? { roles: req.body.roles as ApproverRole[] } : {}),
        ...(req.body.isOwner !== undefined ? { isOwner: req.body.isOwner } : {}),
      });
      if (!updated) throw new HttpProblem(404, 'Not found', 'user not found in tenant');
      await revokeSessionsForTenant(ctx.ownerPool, updated.provider, updated.externalId, req.params.tenantId);
      await audit(req, req.params.tenantId, p.provider ?? 'github', p.externalId ?? p.userId, p.userId, 'member_updated', {
        targetLogin: updated.login,
        roles: updated.roles,
        isOwner: updated.isOwner,
        by: caller?.login ?? p.userId,
      });
      return reply.code(200).send(updated);
    },
  );

  app.delete<{ Params: { tenantId: string; userId: string } }>(
    '/v1/admin/tenants/:tenantId/users/:userId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['tenantId', 'userId'],
          properties: { tenantId: UUID_PARAM, userId: UUID_PARAM },
        },
      },
    },
    async (req, reply) => {
      const caller = await requireTenantMembership(req, req.params.tenantId, true);
      const members = await listTenantUsers(ctx.ownerPool, req.params.tenantId);
      const target = members.find((m) => m.id === req.params.userId);
      if (!target) throw new HttpProblem(404, 'Not found', 'user not found in tenant');
      const p = ctx.principalOf(req);
      const guard = checkMemberChange(members, {
        targetId: req.params.userId,
        callerId: caller?.id ?? '',
        remove: true,
      });
      if (guard) throw new HttpProblem(403, 'Forbidden', guard, 'MEMBER_GUARDRAIL');
      const removed = await removeTenantUser(ctx.ownerPool, req.params.tenantId, req.params.userId);
      if (!removed) throw new HttpProblem(404, 'Not found', 'user not found in tenant');
      await revokeSessionsForTenant(ctx.ownerPool, target.provider, target.externalId, req.params.tenantId);
      await audit(req, req.params.tenantId, p.provider ?? 'github', p.externalId ?? p.userId, p.userId, 'member_removed', {
        targetLogin: target.login,
        by: caller?.login ?? p.userId,
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { tenantId: string }; Querystring: { limit?: number } }>(
    '/v1/admin/tenants/:tenantId/auth-events',
    {
      schema: {
        params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } },
        querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
      },
    },
    async (req) => {
      await requireTenantMembership(req, req.params.tenantId, true);
      const events = await listAuthEvents(ctx.ownerPool, req.params.tenantId, req.query.limit ?? 50);
      return { items: events };
    },
  );

  // Self-service: create a new tenant for the logged-in user
  app.post<{ Body: { name: string; baseCurrency?: string } }>(
    '/v1/tenants/create',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            baseCurrency: { type: 'string', pattern: '^[A-Z]{3}$' },
          },
        },
      },
    },
    async (req, reply) => {
      const p = ctx.principalOf(req);
      const tenant = await createTenantRecord(ctx.ownerConnectionString, req.body);
      const identity = identityOf(p);
      await upsertTenantUser(ctx.ownerPool, {
        tenantId: tenant.id,
        provider: identity.provider,
        externalId: identity.externalId,
        login: identity.login,
        roles: ['cfo' as ApproverRole],
        isOwner: true,
      });
      return reply.code(201).send(tenant);
    },
  );
}
