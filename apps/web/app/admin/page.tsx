'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listTenants, createTenant, type Tenant } from '../../lib/admin-api';

export default function AdminPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listTenants()
      .then((r) => setTenants(r.items))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    try {
      const t = await createTenant(name.trim(), currency || undefined);
      setTenants((prev) => [t, ...prev]);
      setName('');
      setShowCreate(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <section className="admin-header">
        <div className="admin-header-row">
          <div>
            <h1>Tenant Management</h1>
            <p className="muted">Provision and manage organization tenants.</p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? 'Cancel' : '+ New Tenant'}
          </button>
        </div>
      </section>

      {showCreate && (
        <section className="admin-create-form">
          <form onSubmit={handleCreate}>
            <h2>Create New Tenant</h2>
            <div className="form-grid">
              <label className="form-field">
                <span className="form-label">Organization Name</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Corp"
                  required
                  maxLength={200}
                  autoFocus
                />
              </label>
              <label className="form-field">
                <span className="form-label">Base Currency</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="CAD">CAD</option>
                  <option value="AUD">AUD</option>
                  <option value="INR">INR</option>
                  <option value="JPY">JPY</option>
                </select>
              </label>
            </div>
            <div className="buttons" style={{ marginTop: 16 }}>
              <button className="btn btn-primary" type="submit" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create Tenant'}
              </button>
            </div>
          </form>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <section>
        {loading ? (
          <div className="admin-loading">
            <span className="skeleton" style={{ width: '100%', height: 48 }} />
            <span className="skeleton" style={{ width: '100%', height: 48 }} />
            <span className="skeleton" style={{ width: '100%', height: 48 }} />
          </div>
        ) : tenants.length === 0 ? (
          <div className="admin-empty">
            <p className="muted">No tenants yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="tenant-grid">
            {tenants.map((t) => (
              <Link key={t.id} href={`/admin/tenants/${t.id}`} className="tenant-card">
                <div className="tenant-card-icon">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                  </svg>
                </div>
                <div className="tenant-card-body">
                  <span className="tenant-card-name">{t.name}</span>
                  <span className="tenant-card-meta">{new Date(t.createdAt).toLocaleDateString()}</span>
                </div>
                <svg className="tenant-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </Link>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
