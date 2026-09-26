import type { Me } from './api';

/**
 * Demo personas. core-api's demo mode reads the iq_demo_persona cookie, and
 * the same-origin /api/core proxy forwards it, so switching persona is just a
 * cookie: plain links (documents, exports, payment files) carry it too.
 */

export const PERSONA_COOKIE = 'iq_demo_persona';

export const PERSONA_LABEL: Record<string, string> = {
  'demo-user': 'Demo user (uploads; CFO role)',
  'demo-clerk': 'Alex, AP clerk',
  'demo-manager': 'Maria, AP manager',
  'demo-controller': 'Chen, controller',
  'demo-cfo': 'Priya, CFO',
  'demo-deputy-cfo': 'Sam, deputy CFO',
};

export function personaLabel(id: string): string {
  return PERSONA_LABEL[id] ?? id;
}

/** The Set-Cookie value for a persona, or the one that clears it (back to the default user). */
export function personaCookie(id: string | null, maxAgeDays = 30): string {
  if (id === null) return `${PERSONA_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  if (!/^[a-z0-9-]{1,40}$/.test(id)) throw new RangeError(`not a persona id: ${id}`);
  return `${PERSONA_COOKIE}=${id}; Path=/; Max-Age=${maxAgeDays * 86_400}; SameSite=Lax`;
}

/** The persona named in a document.cookie string, if any. */
export function personaFromCookie(cookie: string): string | undefined {
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === PERSONA_COOKIE && v) return decodeURIComponent(v);
  }
  return undefined;
}

export function roleLabel(role: string): string {
  return { ap_clerk: 'AP clerk', ap_manager: 'AP manager', controller: 'Controller', cfo: 'CFO' }[role] ?? role;
}

/** The personas to offer, the current caller first when demo mode lists them. */
export function personaOptions(me: Me): Array<{ id: string; label: string }> {
  const ids = ['demo-user', ...(me.personas ?? []).map((p) => p.id)];
  return [...new Set(ids)].map((id) => ({ id, label: personaLabel(id) }));
}
