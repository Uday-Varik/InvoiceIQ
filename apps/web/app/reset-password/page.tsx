'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function ResetForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/auth/credentials/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail || 'This reset link is invalid or has expired.');
      }
      setDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link href="/" className="auth-logo">
          <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="var(--accent)" />
            <path d="M14 16h20v2H14zm0 6h20v2H14zm0 6h14v2H14zm18 0h2v2h-2z" fill="var(--accent-text)" />
          </svg>
        </Link>
        <h1 className="auth-title">Choose a new password</h1>
        {!token ? (
          <p className="login-error" role="alert">
            This page needs a reset link. Request a new one from the{' '}
            <Link href="/login">sign-in page</Link>.
          </p>
        ) : done ? (
          <>
            <p className="auth-subtitle">
              Your password is changed, and every other sign-in for this account has been ended.
            </p>
            <p className="auth-switch muted small">
              <Link href="/login">Sign in with your new password</Link>
            </p>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="auth-form">
            <label className="auth-field">
              <span className="auth-label">New password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 12 characters"
                required
                minLength={12}
                autoComplete="new-password"
                className="auth-input"
              />
            </label>
            <label className="auth-field">
              <span className="auth-label">Confirm new password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={12}
                autoComplete="new-password"
                className="auth-input"
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save new password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="auth-page">
        <div className="auth-card">
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <span className="spinner" />
          </div>
        </div>
      </div>
    }>
      <ResetForm />
    </Suspense>
  );
}
