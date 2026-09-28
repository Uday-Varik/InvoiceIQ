import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Principal } from '../auth/auth.js';
import { createTenantRecord, listTenants, getTenant, type TenantCreateInput } from './admin-routes.js';
import { listTenantUsers, upsertTenantUser, removeTenantUser } from '../tenants/store.js';
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
      await upsertTenantUser(ctx.ownerPool, {
        tenantId: tenant.id,
        provider: 'github',
        externalId: p.userId,
        login: p.userId,
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
      ctx.requireAdmin(req);
      const tenant = await getTenant(ctx.ownerConnectionString, req.params.tenantId);
      if (!tenant) throw new HttpProblem(404, 'Not found', `no tenant ${req.params.tenantId}`);
      return tenant;
    },
  );

  app.get<{ Params: { tenantId: string } }>(
    '/v1/admin/tenants/:tenantId/users',
    { schema: { params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } } } },
    async (req) => {
      ctx.requireAdmin(req);
      const users = await listTenantUsers(ctx.ownerPool, req.params.tenantId);
      return { items: users };
    },
  );

  app.post<{ Params: { tenantId: string }; Body: { login: string; roles?: string[]; isOwner?: boolean } }>(
    '/v1/admin/tenants/:tenantId/users',
    {
      schema: {
        params: { type: 'object', required: ['tenantId'], properties: { tenantId: UUID_PARAM } },
        body: {
          type: 'object',
          required: ['login'],
          properties: {
            login: { type: 'string', minLength: 1, maxLength: 100 },
            roles: { type: 'array', items: { type: 'string', enum: ['ap_clerk', 'ap_manager', 'controller', 'cfo'] }, maxItems: 4 },
            isOwner: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      ctx.requireAdmin(req);
      const user = await upsertTenantUser(ctx.ownerPool, {
        tenantId: req.params.tenantId,
        provider: 'github',
        externalId: req.body.login,
        login: req.body.login,
        roles: (req.body.roles ?? ['ap_clerk']) as ApproverRole[],
        ...(req.body.isOwner !== undefined ? { isOwner: req.body.isOwner } : {}),
      });
      return reply.code(201).send(user);
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
      ctx.requireAdmin(req);
      const removed = await removeTenantUser(ctx.ownerPool, req.params.tenantId, req.params.userId);
      if (!removed) throw new HttpProblem(404, 'Not found', 'user not found in tenant');
      return reply.code(204).send();
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
      await upsertTenantUser(ctx.ownerPool, {
        tenantId: tenant.id,
        provider: 'github',
        externalId: p.userId,
        login: p.userId,
        roles: ['cfo' as ApproverRole],
        isOwner: true,
      });
      return reply.code(201).send(tenant);
    },
  );
}
