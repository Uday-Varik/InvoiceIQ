import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { APPROVER_ROLES, roleCovers, type ApproverRole } from '../domain/index.js';

export { APPROVER_ROLES, roleCovers, type ApproverRole };

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
  /** `cookie` is only read in demo mode, to pick a persona. */
  authenticate(authorization: string | undefined, cookie?: string): Promise<Principal>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Demo personas, so separation of duties can be shown with one browser: the
 * clerk uploads, a manager approves, a controller confirms the payment run.
 */
export const DEMO_PERSONAS: Readonly<Record<string, readonly ApproverRole[]>> = {
  'demo-clerk': ['ap_clerk'],
  'demo-manager': ['ap_manager'],
  'demo-controller': ['controller'],
  'demo-cfo': ['cfo'],
  'demo-deputy-cfo': ['cfo'],
};

export const DEMO_PERSONA_COOKIE = 'iq_demo_persona';

/** The persona named by `Authorization: Demo <name>` or the persona cookie, if any. */
export function demoPersona(authorization: string | undefined, cookie: string | undefined): string | undefined {
  const auth = /^Demo\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (auth?.[1]) return auth[1];
  for (const part of (cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === DEMO_PERSONA_COOKIE && v) return decodeURIComponent(v);
  }
  return undefined;
}

/**
 * Public-demo mode: every caller is in the demo tenant. There is no login to
 * bypass because there is nothing private in the demo tenant. A caller with no
 * persona is `principal`; a persona picks one of DEMO_PERSONAS. Config refuses
 * this mode unless AUTH_MODE=demo is set explicitly.
 */
export function demoAuthenticator(principal: Principal): Authenticator {
  return {
    mode: 'demo',
    authenticate(authorization, cookie) {
      const persona = demoPersona(authorization, cookie);
      if (persona === undefined || persona === principal.userId) return Promise.resolve(principal);
      const roles = DEMO_PERSONAS[persona];
      if (!Object.hasOwn(DEMO_PERSONAS, persona) || roles === undefined) {
        return Promise.reject(new AuthError(`unknown demo persona ${persona.slice(0, 40)}`));
      }
      return Promise.resolve({ tenantId: principal.tenantId, userId: persona, roles });
    },
  };
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

