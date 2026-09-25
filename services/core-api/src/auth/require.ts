import { HttpProblem } from '../http/problem.js';
import { roleCovers, type ApproverRole, type Principal } from './auth.js';

/** 403 unless the caller holds `role` or a more senior one. */
export function requireRole(principal: Principal, role: ApproverRole, action: string): void {
  if (!roleCovers(principal.roles, role)) {
    throw new HttpProblem(403, 'Insufficient role', `${action} needs role ${role} or above`, 'ROLE_INSUFFICIENT');
  }
}

/** 403 when the same person would hold two duties that must be separate. */
export function requireDifferentPerson(principal: Principal, other: string, detail: string): void {
  if (principal.userId === other) throw new HttpProblem(403, 'Separation of duties', detail, 'SEPARATION_OF_DUTIES');
}
