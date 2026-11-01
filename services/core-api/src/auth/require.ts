import { HttpProblem } from '../http/problem.js';
import { roleCovers, type ApproverRole, type Principal } from './auth.js';
import { hasPermission, type Permission } from './permissions.js';

/** 403 unless the caller holds `role` or a more senior one. */
export function requireRole(principal: Principal, role: ApproverRole, action: string): void {
  if (!roleCovers(principal.roles, role)) {
    throw new HttpProblem(403, 'Insufficient role', `${action} needs role ${role} or above`, 'ROLE_INSUFFICIENT');
  }
}

/** 403 unless the caller's roles (or tenant ownership) grant `permission`. */
export function requirePermission(principal: Principal, permission: Permission, action: string, isOwner = false): void {
  if (!hasPermission(principal.roles, permission, isOwner)) {
    throw new HttpProblem(403, 'Insufficient permission', `${action} needs permission ${permission}`, 'PERMISSION_DENIED');
  }
}

/** 403 when the same person would hold two duties that must be separate. */
export function requireDifferentPerson(principal: Principal, other: string, detail: string): void {
  if (principal.userId === other) throw new HttpProblem(403, 'Separation of duties', detail, 'SEPARATION_OF_DUTIES');
}
