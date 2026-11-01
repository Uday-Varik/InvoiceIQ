import { describe, expect, it } from 'vitest';
import { checkMemberChange, type TenantUser } from '../src/tenants/store.js';
import {
  hasPermission,
  rolePermissions,
  rolesWithPermission,
  type Permission,
} from '../src/auth/permissions.js';
import { listAuthEvents, recordAuthEvent, type AuditDb } from '../src/auth/audit.js';

function member(overrides: Partial<TenantUser> = {}): TenantUser {
  return {
    id: 'u1',
    tenantId: 't1',
    provider: 'github',
    externalId: 'e1',
    login: 'alice',
    roles: ['cfo'],
    isOwner: true,
    lastUsedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('permission matrix', () => {
  it('is seniority-closed: every higher role keeps the lower role permissions', () => {
    const ladder = ['ap_clerk', 'ap_manager', 'controller', 'cfo'] as const;
    for (let i = 1; i < ladder.length; i += 1) {
      for (const perm of rolePermissions(ladder[i - 1]!)) {
        expect(rolePermissions(ladder[i]!).has(perm)).toBe(true);
      }
    }
  });

  it('grants approve/hold to managers and up, payment confirm to controllers and up', () => {
    expect(hasPermission(['ap_clerk'], 'invoices:approve')).toBe(false);
    expect(hasPermission(['ap_manager'], 'invoices:approve')).toBe(true);
    expect(hasPermission(['ap_manager'], 'payments:confirm')).toBe(false);
    expect(hasPermission(['controller'], 'payments:confirm')).toBe(true);
    expect(hasPermission(['ap_clerk'], 'invoices:view')).toBe(true);
  });

  it('grants members:manage to controllers and CFOs only', () => {
    expect(rolesWithPermission('members:manage')).toEqual(['controller', 'cfo']);
    expect(hasPermission(['ap_manager'], 'members:manage')).toBe(false);
  });

  it('lets a tenant owner do everything in their tenant', () => {
    const every: Permission[] = [
      'invoices:view',
      'invoices:upload',
      'invoices:hold',
      'invoices:approve',
      'payments:assemble',
      'payments:confirm',
      'vendors:manage',
      'audit:view',
      'reports:view',
      'checkpoints:sign',
      'members:manage',
      'tenants:create',
    ];
    for (const perm of every) {
      expect(hasPermission(['ap_clerk'], perm, true)).toBe(true);
    }
  });
});

describe('membership guardrails', () => {
  const members = [
    member({ id: 'owner1', login: 'owner', isOwner: true, roles: ['cfo'] }),
    member({ id: 'mgr1', login: 'manager', isOwner: false, roles: ['ap_manager'] }),
  ];

  it('forbids removing the last owner', () => {
    expect(checkMemberChange(members, { targetId: 'owner1', callerId: 'mgr1', remove: true })).toMatch(/at least one owner/);
  });

  it('allows removing a non-owner', () => {
    expect(checkMemberChange(members, { targetId: 'mgr1', callerId: 'owner1', remove: true })).toBeUndefined();
  });

  it('forbids demoting the last owner and stripping your own roles', () => {
    expect(
      checkMemberChange(members, { targetId: 'owner1', callerId: 'owner1', nextIsOwner: false }),
    ).toMatch(/at least one owner/);
    expect(
      checkMemberChange(members, { targetId: 'mgr1', callerId: 'mgr1', nextRoles: [] }),
    ).toMatch(/your own roles/);
  });

  it('allows a second owner to be demoted', () => {
    const twoOwners = [...members, member({ id: 'owner2', login: 'owner2', isOwner: true, roles: ['cfo'] })];
    expect(
      checkMemberChange(twoOwners, { targetId: 'owner2', callerId: 'owner1', nextIsOwner: false }),
    ).toBeUndefined();
  });

  it('reports an unknown member', () => {
    expect(checkMemberChange(members, { targetId: 'nobody', callerId: 'owner1', remove: true })).toMatch(/not found/);
  });
});

describe('auth audit trail', () => {
  function fakeAuditDb(): { db: AuditDb; queries: Array<{ sql: string; params: unknown[] }>; rows: Record<string, unknown>[] } {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const rows: Record<string, unknown>[] = [];
    const db = {
      query: (async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('INSERT INTO auth_events')) {
          rows.push({ params });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }) as AuditDb['query'],
    };
    return { db, queries, rows };
  }

  it('records events with tenant, identity, and detail', async () => {
    const { db, queries } = fakeAuditDb();
    await recordAuthEvent(db, {
      tenantId: 't1',
      provider: 'github',
      externalId: '42',
      login: 'alice',
      event: 'login',
      detail: { via: 'oauth' },
      ipHash: 'abc',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain('INSERT INTO auth_events');
    expect(queries[0]!.params).toEqual(['t1', 'github', '42', 'alice', 'login', '{"via":"oauth"}', 'abc']);
  });

  it('lists events newest first for one tenant', async () => {
    const db: AuditDb = {
      query: (async (sql: string) => {
        expect(sql).toContain('WHERE tenant_id = $1');
        expect(sql).toContain('ORDER BY created_at DESC');
        return {
          rows: [
            {
              id: 'e1',
              tenant_id: 't1',
              provider: 'github',
              external_id: '42',
              login: 'alice',
              event: 'login',
              detail: {},
              ip_hash: null,
              created_at: new Date('2026-11-01T00:00:00Z'),
            },
          ],
          rowCount: 1,
        };
      }) as AuditDb['query'],
    };
    const events = await listAuthEvents(db, 't1', 50);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'e1', login: 'alice', event: 'login' });
  });
});
