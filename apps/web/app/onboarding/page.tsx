'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { selfCreateTenant, getAuthMe, switchTenant, type AuthMeResponse } from '../../lib/admin-api';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import { inputClass } from '../../components/ui/field';

const FEATURES = ['AI-powered invoice extraction', 'Multi-tier approval workflows', 'Tamper-evident audit trail'];

export default function OnboardingPage() {
  const [step, setStep] = useState<'loading' | 'welcome' | 'create' | 'pick'>('loading');
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getAuthMe()
      .then((data) => {
        setMe(data);
        setStep(data.tenants.length > 1 ? 'pick' : 'welcome');
      })
      .catch(() => {
        window.location.href = '/login';
      });
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError('');
    try {
      const t = await selfCreateTenant(name.trim(), currency || undefined);
      await switchTenant(t.id);
      window.location.href = '/';
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setCreating(false);
    }
  }

  async function handleSelectTenant(tenantId: string) {
    try {
      await switchTenant(tenantId);
      window.location.href = '/';
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (step === 'loading') {
    return (
      <div className="grid min-h-[70vh] place-items-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="grid min-h-[70vh] place-items-center">
      <Card className="w-full max-w-md space-y-6 p-8">
        <div className="space-y-2 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-xl bg-primary text-sm font-semibold text-primary-foreground" aria-hidden="true">
            IQ
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Welcome to InvoiceIQ</h1>
          {me && (
            <p className="text-sm text-muted-foreground">
              Signed in as <strong className="text-foreground">{me.login}</strong>
            </p>
          )}
        </div>

        {error && (
          <p className="text-sm text-rose-700 dark:text-rose-300" role="alert">
            {error}
          </p>
        )}

        {step === 'pick' && me && (
          <div className="space-y-4">
            <p className="text-sm">You belong to more than one organization. Pick one to continue:</p>
            <div className="grid gap-2">
              {me.tenants.map((t) => (
                <button
                  key={t.tenantId}
                  type="button"
                  onClick={() => handleSelectTenant(t.tenantId)}
                  className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span className="font-medium tabular-nums">{t.tenantId.slice(0, 8)}…</span>
                  <span className="text-xs text-muted-foreground">{t.roles.join(', ')}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button variant="outline" className="w-full" onClick={() => setStep('create')}>
              Create a new organization
            </Button>
          </div>
        )}

        {(step === 'welcome' || step === 'create') && (
          <div className="space-y-4">
            {step === 'welcome' && (
              <p className="text-center text-sm text-muted-foreground">
                Create your organization to start managing invoices with AI-powered extraction and multi-tier approvals.
              </p>
            )}
            <form onSubmit={handleCreate} className="space-y-4">
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Organization name</span>
                <input className={cn(inputClass, 'h-10')} type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" required maxLength={200} autoFocus />
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Base currency</span>
                <select className={cn(inputClass, 'h-10')} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  <option value="USD">USD: US Dollar</option>
                  <option value="EUR">EUR: Euro</option>
                  <option value="GBP">GBP: British Pound</option>
                  <option value="CAD">CAD: Canadian Dollar</option>
                  <option value="AUD">AUD: Australian Dollar</option>
                  <option value="INR">INR: Indian Rupee</option>
                  <option value="JPY">JPY: Japanese Yen</option>
                </select>
              </label>
              <Button type="submit" className="w-full" disabled={creating || !name.trim()}>
                {creating ? 'Creating…' : 'Create organization and continue'}
              </Button>
            </form>
            {step === 'create' && (
              <button type="button" className="text-sm text-primary hover:underline" onClick={() => setStep('pick')}>
                ← Back to organization list
              </button>
            )}
          </div>
        )}

        <ul className="space-y-2 border-t border-border pt-5 text-sm">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-center gap-2 text-muted-foreground">
              <span className="text-emerald-600 dark:text-emerald-400" aria-hidden="true">
                ✓
              </span>
              {f}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
