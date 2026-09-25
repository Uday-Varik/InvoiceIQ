import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';

export const ISSUER = 'https://issuer.test/';
export const AUDIENCE = 'invoiceiq-api';

export interface TestIssuer {
  readonly keys: JWTVerifyGetKey;
  token(claims: { sub: string; tenant_id?: string; roles?: string[] }, opts?: { expiresIn?: string; issuer?: string; audience?: string }): Promise<string>;
}

/** A local OIDC issuer: real RS256 keys and a JWKS, no network. */
export async function testIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256' };
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    token: (claims, opts = {}) =>
      new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(opts.issuer ?? ISSUER)
        .setAudience(opts.audience ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? '5m')
        .sign(privateKey),
  };
}
