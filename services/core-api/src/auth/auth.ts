import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { ApprovalTier } from '../domain/index.js';

export type ApproverRole = ApprovalTier['approverRole'];
export const APPROVER_ROLES: readonly ApproverRole[] = ['ap_clerk', 'ap_manager', 'controller', 'cfo'];

/** Who is calling. tenantId always comes from a verified token, never from request input. */
export interface Principal {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly ApproverRole[];
}

export class AuthError extends Error {
  override name = 'AuthError';
}

export interface Authenticator {
  readonly mode: 'demo' | 'oidc';
  authenticate(authorization: string | undefined): Promise<Principal>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public-demo mode: every caller is the same demo user in the demo tenant.
 * There is no login to bypass because there is nothing private in the demo
 * tenant. Config refuses this mode unless AUTH_MODE=demo is set explicitly.
 */
export function demoAuthenticator(principal: Principal): Authenticator {
  return { mode: 'demo', authenticate: () => Promise.resolve(principal) };
}

export interface OidcOptions {
  readonly issuer: string;
  readonly audience: string;
  /** Remote JWKS in production; a local key set in tests. */
  readonly keys: JWTVerifyGetKey;
  readonly tenantClaim?: string;
  readonly rolesClaim?: string;
}

export function remoteKeys(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
}

export function oidcAuthenticator(opts: OidcOptions): Authenticator {
  const tenantClaim = opts.tenantClaim ?? 'tenant_id';
  const rolesClaim = opts.rolesClaim ?? 'roles';
  return {
    mode: 'oidc',
    async authenticate(authorization) {
      const m = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(authorization ?? '');
      if (!m?.[1]) throw new AuthError('missing bearer token');
      let payload;
      try {
        ({ payload } = await jwtVerify(m[1], opts.keys, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ['RS256', 'ES256', 'EdDSA'],
          clockTolerance: 30,
          requiredClaims: ['sub', 'exp'],
        }));
      } catch (err) {
        if (err instanceof errors.JOSEError) throw new AuthError(`invalid token: ${err.code}`);
        throw err;
      }
      const tenantId = payload[tenantClaim];
      if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) throw new AuthError(`token has no valid ${tenantClaim} claim`);
      const rawRoles = payload[rolesClaim];
      const roles = (Array.isArray(rawRoles) ? rawRoles : []).filter((r): r is ApproverRole =>
        (APPROVER_ROLES as readonly unknown[]).includes(r),
      );
      return { tenantId: tenantId.toLowerCase(), userId: payload.sub as string, roles };
    },
  };
}

/** True when any of the caller's roles is at least as senior as `required`. */
export function roleCovers(roles: readonly ApproverRole[], required: ApproverRole): boolean {
  const need = APPROVER_ROLES.indexOf(required);
  return roles.some((r) => APPROVER_ROLES.indexOf(r) >= need);
}
