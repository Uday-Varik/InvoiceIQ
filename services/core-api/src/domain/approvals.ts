import { approvalTierFor, type ApprovalTier, type Policy } from './policy.js';

/**
 * Approval authority and separation of duties. Pure: the service loads the
 * facts (who uploaded, who corrected, who already approved) and records the
 * decision; it never re-decides it.
 *
 * Rules that no tenant policy can switch off:
 *  1. The approver's role must cover the tier for the invoice total. Tiers are
 *     in the base currency; with no FX, any other currency needs the top tier.
 *  2. Nobody approves an invoice they uploaded or corrected.
 *  3. A tier that needs N approvals needs N different people.
 */

export type ApproverRole = ApprovalTier['approverRole'];

/** Junior to senior. A role covers every role at or below it. */
export const APPROVER_ROLES: readonly ApproverRole[] = ['ap_clerk', 'ap_manager', 'controller', 'cfo'];

export function isApproverRole(value: unknown): value is ApproverRole {
  return typeof value === 'string' && (APPROVER_ROLES as readonly string[]).includes(value);
}

/** True when any of the roles is at least as senior as `required`. */
export function roleCovers(roles: readonly ApproverRole[], required: ApproverRole): boolean {
  const need = APPROVER_ROLES.indexOf(required);
  return roles.some((r) => APPROVER_ROLES.indexOf(r) >= need);
}

/** The most senior of the roles, or undefined for none. */
export function seniorRole(roles: readonly ApproverRole[]): ApproverRole | undefined {
  let best: ApproverRole | undefined;
  for (const r of roles) if (best === undefined || APPROVER_ROLES.indexOf(r) > APPROVER_ROLES.indexOf(best)) best = r;
  return best;
}

/** The tier an invoice needs, or undefined when the total is above every tier. */
export function tierForInvoice(policy: Policy, currency: string, totalMinor: bigint): ApprovalTier | undefined {
  if (currency !== policy.baseCurrency) return policy.approvalTiers.at(-1);
  return approvalTierFor(policy, totalMinor);
}

export interface PriorApproval {
  readonly approverId: string;
  readonly role: ApproverRole;
}

export interface ApprovalFacts {
  readonly policy: Policy;
  readonly currency: string | null;
  readonly totalMinor: bigint | null;
  /** Who uploaded the invoice (the `created_by` column). */
  readonly createdBy: string;
  /** Everyone who has corrected the invoice's fields. */
  readonly correctedBy: ReadonlySet<string>;
  /** Approvals already given at the invoice's current version. */
  readonly prior: readonly PriorApproval[];
  readonly approver: { readonly id: string; readonly roles: readonly ApproverRole[] };
}

export type ApprovalRefusal =
  | 'TOTAL_UNKNOWN'
  | 'APPROVAL_LIMIT_EXCEEDED'
  | 'ROLE_INSUFFICIENT'
  | 'SELF_APPROVAL'
  | 'CORRECTOR_APPROVAL'
  | 'ALREADY_APPROVED';

export type ApprovalDecision =
  | {
      readonly ok: true;
      readonly tier: ApprovalTier;
      readonly role: ApproverRole;
      /** Approvals including this one. */
      readonly count: number;
      readonly required: number;
      /** True when this approval is the last one the tier needs. */
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly code: ApprovalRefusal; readonly message: string };

function refuse(code: ApprovalRefusal, message: string): ApprovalDecision {
  return { ok: false, code, message };
}

export function evaluateApproval(f: ApprovalFacts): ApprovalDecision {
  if (f.currency === null || f.totalMinor === null) return refuse('TOTAL_UNKNOWN', 'the invoice has no extracted total and currency');
  const tier = tierForInvoice(f.policy, f.currency, f.totalMinor);
  if (tier === undefined) return refuse('APPROVAL_LIMIT_EXCEEDED', 'the total is above every approval tier');
  if (!roleCovers(f.approver.roles, tier.approverRole)) {
    return refuse('ROLE_INSUFFICIENT', `the ${tier.name} tier needs role ${tier.approverRole}`);
  }
  if (f.approver.id === f.createdBy) return refuse('SELF_APPROVAL', 'you uploaded this invoice, so someone else must approve it');
  if (f.correctedBy.has(f.approver.id)) return refuse('CORRECTOR_APPROVAL', 'you corrected this invoice, so someone else must approve it');
  if (f.prior.some((p) => p.approverId === f.approver.id)) return refuse('ALREADY_APPROVED', 'you have already approved this invoice');

  // Only approvals from people whose role still covers the tier count: a
  // correction can raise the total into a tier an earlier approver lacks.
  const counted = f.prior.filter((p) => roleCovers([p.role], tier.approverRole)).length;
  const role = seniorRole(f.approver.roles) ?? tier.approverRole;
  const count = counted + 1;
  const required = tier.approvalsRequired;
  return { ok: true, tier, role, count, required, complete: count >= required };
}
