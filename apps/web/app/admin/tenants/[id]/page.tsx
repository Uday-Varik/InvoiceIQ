'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getTenant, listTenantUsers, addTenantUser, removeTenantUser, type Tenant, type TenantUser } from '../../../../lib/admin-api';

const ROLE_LABELS: Record<string, string> = {
  ap_clerk: 'AP Clerk',
  ap_manager: 'AP Manager',
  controller: 'Controller',
  cfo: 'CFO',
};

export default function TenantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('ap_clerk');
  const [isOwner, setIsOwner] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    Promise.all([getTenant(id), listTenantUsers(id)])
      .then(([t, u]) => { setTenant(t); setUsers(u.items); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!login.trim()) return;
    setAdding(true);
    setError('');
    try {
      const u = await addTenantUser(id, login.trim(), [role], isOwner);
      setUsers((prev) => [...prev, u]);
      setLogin('');
      setShowAdd(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm('Remove this user from the tenant?')) return;
    try {
      await removeTenantUser(id, userId);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loading) {
    return (
      <section>
        <span className="skeleton" style={{ width: 200, height: 28, display: 'block', marginBottom: 16 }} />
        <span className="skeleton" style={{ width: '100%', height: 200 }} />
      </section>
    );
  }

  if (!tenant) {
    return <section><p className="error">Tenant not found.</p><Link href="/admin">← Back</Link></section>;
  }

  return (
    <>
      <section>
        <Link href="/admin" className="admin-back">← All Tenants</Link>
        <div className="admin-header-row" style={{ marginTop: 12 }}>
          <div>
            <h1>{tenant.name}</h1>
            <p className="muted small">ID: {tenant.id} · Created {new Date(tenant.createdAt).toLocaleDateString()}</p>
          </div>
        </div>
      </section>

      {error && <p className="error">{error}</p>}

      <section>
        <div className="admin-header-row">
          <h2>Members</h2>
          <button className="btn btn-small" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? 'Cancel' : '+ Add Member'}
          </button>
        </div>

        {showAdd && (
          <form onSubmit={handleAdd} className="admin-add-user-form">
            <div className="form-grid">
              <label className="form-field">
                <span className="form-label">GitHub Username</span>
                <input
                  type="text"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  placeholder="octocat"
                  required
                  autoFocus
                />
              </label>
              <label className="form-field">
                <span className="form-label">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {Object.entries(ROLE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="form-field form-checkbox">
                <input type="checkbox" checked={isOwner} onChange={(e) => setIsOwner(e.target.checked)} />
                <span>Owner (admin access)</span>
              </label>
            </div>
            <div className="buttons" style={{ marginTop: 12 }}>
              <button className="btn btn-primary btn-small" type="submit" disabled={adding || !login.trim()}>
                {adding ? 'Adding…' : 'Add Member'}
              </button>
            </div>
          </form>
        )}

        {users.length === 0 ? (
          <p className="muted">No members yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Roles</th>
                  <th>Owner</th>
                  <th>Joined</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.login}</strong>
                      <br />
                      <span className="muted small">{u.provider}:{u.externalId}</span>
                    </td>
                    <td>{u.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}</td>
                    <td>{u.isOwner ? <span className="pill pill-approved">Owner</span> : '—'}</td>
                    <td className="small muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button className="btn-link small" style={{ color: 'var(--bad)' }} onClick={() => handleRemove(u.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
