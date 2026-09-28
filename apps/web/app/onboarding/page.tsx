'use client';

import { useEffect, useState } from 'react';
import { selfCreateTenant, getAuthMe, switchTenant, type AuthMeResponse } from '../../lib/admin-api';

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
        if (data.tenants.length > 1) {
          setStep('pick');
        } else {
          setStep('welcome');
        }
      })
      .catch(() => {
        window.location.href = '/login';
      });
  }, []);

  async function handleCreate(e: React.FormEvent) {
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
      <div className="onboarding">
        <div className="onboarding-card">
          <div className="onboarding-spinner"><span className="spinner" /></div>
          <p className="muted">Loading…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="onboarding-logo">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="var(--accent)" />
            <path d="M14 16h20v2H14zm0 6h20v2H14zm0 6h14v2H14zm18 0h2v2h-2z" fill="var(--accent-text)" />
          </svg>
        </div>
        <h1 className="onboarding-title">Welcome to InvoiceIQ</h1>
        {me && <p className="muted">Signed in as <strong>{me.login}</strong></p>}

        {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

        {step === 'pick' && me && (
          <>
            <p style={{ marginTop: 16 }}>You belong to multiple organizations. Pick one to continue:</p>
            <div className="onboarding-tenants">
              {me.tenants.map((t) => (
                <button key={t.tenantId} className="onboarding-tenant-btn" onClick={() => handleSelectTenant(t.tenantId)}>
                  <span className="onboarding-tenant-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                    </svg>
                  </span>
                  <span>{t.tenantId.slice(0, 8)}…</span>
                  <span className="muted small">{t.roles.join(', ')}</span>
                </button>
              ))}
            </div>
            <div className="onboarding-divider">
              <span>or</span>
            </div>
            <button className="btn" onClick={() => setStep('create')}>Create a new organization</button>
          </>
        )}

        {(step === 'welcome' || step === 'create') && (
          <>
            {step === 'welcome' && (
              <p className="onboarding-subtitle">
                Create your organization to start managing invoices with AI-powered extraction and multi-tier approvals.
              </p>
            )}
            <form onSubmit={handleCreate} className="onboarding-form">
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
                  className="onboarding-input"
                />
              </label>
              <label className="form-field">
                <span className="form-label">Base Currency</span>
                <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="onboarding-input">
                  <option value="USD">USD — US Dollar</option>
                  <option value="EUR">EUR — Euro</option>
                  <option value="GBP">GBP — British Pound</option>
                  <option value="CAD">CAD — Canadian Dollar</option>
                  <option value="AUD">AUD — Australian Dollar</option>
                  <option value="INR">INR — Indian Rupee</option>
                  <option value="JPY">JPY — Japanese Yen</option>
                </select>
              </label>
              <button className="btn btn-primary onboarding-submit" type="submit" disabled={creating || !name.trim()}>
                {creating ? (
                  <span className="onboarding-btn-loading"><span className="spinner" /> Creating…</span>
                ) : (
                  'Create Organization & Get Started'
                )}
              </button>
            </form>
            {step === 'create' && (
              <button className="btn-link small" style={{ marginTop: 12 }} onClick={() => setStep('pick')}>
                ← Back to organization list
              </button>
            )}
          </>
        )}

        <div className="onboarding-features">
          <div className="onboarding-feature">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            <span>AI-powered invoice extraction</span>
          </div>
          <div className="onboarding-feature">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            <span>Multi-tier approval workflows</span>
          </div>
          <div className="onboarding-feature">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            <span>Tamper-evident audit trail</span>
          </div>
        </div>
      </div>
    </div>
  );
}
