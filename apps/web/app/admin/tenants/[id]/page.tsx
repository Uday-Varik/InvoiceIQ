'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { getTenant, listTenantUsers, addTenantUser, removeTenantUser, type Tenant, type TenantUser } from '../../../../lib/admin-api';
import { PageHeader } from '../../../../components/page-header';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { Table, TableCell, TableHead, TableRow } from '../../../../components/ui/table';
import { inputClass } from '../../../../components/ui/field';

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
      .then(([t, u]) => {
        setTenant(t);
        setUsers(u.items);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleAdd(e: FormEvent) {
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

  if (loading) return <div className="h-40 animate-pulse rounded-xl bg-muted" />;

  if (!tenant) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-rose-700 dark:text-rose-300">Tenant not found.</p>
        <Link href="/admin" className="text-sm text-primary hover:underline">
          ← Back
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link href="/admin" className="text-sm text-primary hover:underline">
        ← All tenants
      </Link>
      <PageHeader
        title={tenant.name}
        description={`Created ${new Date(tenant.createdAt).toLocaleDateString()} · ID ${tenant.id}`}
      />

      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Members</h2>
          <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? 'Cancel' : 'Add member'}
          </Button>
        </div>

        {showAdd && (
          <Card className="p-5">
            <form onSubmit={handleAdd} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">GitHub username</span>
                <input className={inputClass} type="text" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="octocat" required autoFocus />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Role</span>
                <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
                  {Object.entries(ROLE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" disabled={adding || !login.trim()}>
                {adding ? 'Adding…' : 'Add member'}
              </Button>
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <input type="checkbox" checked={isOwner} onChange={(e) => setIsOwner(e.target.checked)} />
                Owner (admin access)
              </label>
            </form>
          </Card>
        )}

        {users.length === 0 ? (
          <Card className="p-6 text-sm text-muted-foreground">No members yet.</Card>
        ) : (
          <Card className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <TableHead>User</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <div className="font-medium">{u.login}</div>
                      <div className="text-xs text-muted-foreground">
                        {u.provider}:{u.externalId}
                      </div>
                    </TableCell>
                    <TableCell>{u.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}</TableCell>
                    <TableCell>{u.isOwner ? <Badge tone="success">Owner</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">{new Date(u.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="text-rose-700 dark:text-rose-300" onClick={() => handleRemove(u.id)}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
