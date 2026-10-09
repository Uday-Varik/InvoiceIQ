'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { listTenants, createTenant, type Tenant } from '../../lib/admin-api';
import { PageHeader } from '../../components/page-header';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { inputClass } from '../../components/ui/field';

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

  async function handleCreate(e: FormEvent) {
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
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        description="Provision and manage organization tenants."
        actions={
          <Button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : 'New tenant'}</Button>
        }
      />

      {showCreate && (
        <Card className="p-5">
          <form onSubmit={handleCreate} className="space-y-4">
            <h2 className="font-semibold">Create a tenant</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Organization name</span>
                <input
                  className={inputClass}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme Corp"
                  required
                  maxLength={200}
                  autoFocus
                />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Base currency</span>
                <select className={inputClass} value={currency} onChange={(e) => setCurrency(e.target.value)}>
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
            <div>
              <Button type="submit" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create tenant'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="grid gap-3">
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : tenants.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">No tenants yet. Create one to get started.</Card>
      ) : (
        <div className="grid gap-3">
          {tenants.map((t) => (
            <Link key={t.id} href={`/admin/tenants/${t.id}`} className="no-underline">
              <Card className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/50">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                  {t.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{t.name}</div>
                  <div className="text-sm text-muted-foreground tabular-nums">Created {new Date(t.createdAt).toLocaleDateString()}</div>
                </div>
                <span aria-hidden="true" className="text-muted-foreground">
                  ›
                </span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
