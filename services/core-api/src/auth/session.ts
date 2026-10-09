import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Authenticator } from './auth.js';
import { AuthError, type ApproverRole } from './auth.js';

export const SESSION_COOKIE = 'iq_session';

export interface SessionPayload {
  readonly uid: string;
  readonly login: string;
  readonly tid: string;
  readonly roles: readonly ApproverRole[];
  readonly provider: string;
  readonly exp: number;
}

export interface SessionOptions {
  readonly sessionSecret: string;
}

export function signSession(payload: SessionPayload, secret: string): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

export function verifySession(token: string, secret: string): SessionPayload | undefined {
  const dot = token.indexOf('.');
  if (dot < 1) return undefined;
  const data = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expected);
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

export function sessionAuthenticator(sessionSecret: string): Authenticator {
  return {
    mode: 'github' as Authenticator['mode'],
    async authenticate(_authorization, cookie) {
      const token = parseCookie(cookie, SESSION_COOKIE);
      if (!token) throw new AuthError('not authenticated: no session');
      const payload = verifySession(token, sessionSecret);
      if (!payload) throw new AuthError('invalid or expired session');
      return {
        tenantId: payload.tid,
        userId: payload.login,
        roles: [...payload.roles],
      };
    },
  };
}
