import { API_BASE, ApiError } from './api';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface TenantUser {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly login: string;
  readonly roles: string[];
  readonly isOwner: boolean;
  readonly lastUsedAt: string;
  readonly createdAt: string;
}

export interface AuthMeResponse {
  readonly authenticated: boolean;
  readonly login: string;
  readonly roles: string[];
  readonly tenantId: string;
  readonly tenants: Array<{ tenantId: string; login: string; roles: string[] }>;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { accept: 'application/json', ...init.headers } });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
  if (!res.ok) throw new ApiError(res.status, (body as Partial<{ title: string; detail: string }>) ?? { title: res.statusText });
  return body as T;
}

export function listTenants(): Promise<{ items: Tenant[] }> {
  return call('/v1/admin/tenants');
}

export function createTenant(name: string, baseCurrency?: string): Promise<Tenant> {
  return call('/v1/admin/tenants', {
    method: 'POST',
    body: JSON.stringify({ name, ...(baseCurrency ? { baseCurrency } : {}) }),
    headers: { 'content-type': 'application/json' },
  });
}

export function getTenant(id: string): Promise<Tenant> {
  return call(`/v1/admin/tenants/${encodeURIComponent(id)}`);
}

export function listTenantUsers(tenantId: string): Promise<{ items: TenantUser[] }> {
  return call(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/users`);
}

export function addTenantUser(tenantId: string, login: string, roles: string[], isOwner: boolean): Promise<TenantUser> {
  return call(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/users`, {
    method: 'POST',
    body: JSON.stringify({ login, roles, isOwner }),
    headers: { 'content-type': 'application/json' },
  });
}

export function removeTenantUser(tenantId: string, userId: string): Promise<void> {
  return call(`/v1/admin/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

export function selfCreateTenant(name: string, baseCurrency?: string): Promise<Tenant> {
  return call('/v1/tenants/create', {
    method: 'POST',
    body: JSON.stringify({ name, ...(baseCurrency ? { baseCurrency } : {}) }),
    headers: { 'content-type': 'application/json' },
  });
}

export function switchTenant(tenantId: string): Promise<{ ok: boolean; tenantId: string }> {
  return fetch('/auth/switch-tenant', {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
    headers: { 'content-type': 'application/json' },
  }).then(async (r) => {
    if (!r.ok) throw new Error('failed to switch tenant');
    return r.json();
  });
}

export function getAuthMe(): Promise<AuthMeResponse> {
  return fetch('/auth/me').then(async (r) => {
    if (!r.ok) throw new Error('not authenticated');
    return r.json();
  });
}
