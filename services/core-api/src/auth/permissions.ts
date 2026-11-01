import type { ApproverRole } from '../domain/index.js';
import type { Principal } from './auth.js';

/**
 * The permission matrix: what each role may do, stated once. The domain
 * services still enforce their own finer checks (approval rungs,
 * separation of duties, bank-change verification), and this matrix never
 * widens them — a permission here is necessary, never sufficient, for
 * those actions. A tenant owner holds every permission in their tenant.
 * The sets below mirror the requireRole thresholds already enforced in
 * the domain services, so adopting the matrix changes no privilege.
 */

export type Permission =
  | 'invoices:view'
  | 'invoices:upload'
  | 'invoices:hold'
  | 'invoices:approve'
  | 'payments:assemble'
  | 'payments:confirm'
  | 'vendors:manage'
  | 'audit:view'
  | 'reports:view'
  | 'checkpoints:sign'
  | 'members:manage'
  | 'tenants:create';

const ALL_ROLES: readonly ApproverRole[] = ['ap_clerk', 'ap_manager', 'controller', 'cfo'];

export const ROLE_PERMISSIONS: Readonly<Record<ApproverRole, ReadonlySet<Permission>>> = {
  ap_clerk: new Set(['invoices:view', 'invoices:upload', 'vendors:manage', 'audit:view', 'reports:view']),
  ap_manager: new Set([
    'invoices:view',
    'invoices:upload',
    'invoices:hold',
    'invoices:approve',
    'payments:assemble',
    'vendors:manage',
    'audit:view',
    'reports:view',
    'checkpoints:sign',
  ]),
  controller: new Set([
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
  ]),
  cfo: new Set([
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
  ]),
};

export function rolePermissions(role: ApproverRole): ReadonlySet<Permission> {
  return ROLE_PERMISSIONS[role];
}

export function hasPermission(
  roles: readonly ApproverRole[],
  permission: Permission,
  isOwner = false,
): boolean {
  if (isOwner) return true;
  return roles.some((role) => ROLE_PERMISSIONS[role]?.has(permission));
}

/** The roles that hold a permission. */
export function rolesWithPermission(permission: Permission): readonly ApproverRole[] {
  return ALL_ROLES.filter((r) => ROLE_PERMISSIONS[r]?.has(permission));
}

export function principalHasPermission(
  principal: Principal,
  permission: Permission,
  isOwner = false,
): boolean {
  return hasPermission(principal.roles, permission, isOwner);
}
