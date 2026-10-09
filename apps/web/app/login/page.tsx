'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

function LoginForm() {
  const params = useSearchParams();
  const initialTab = params.get('tab') === 'signup' ? 'signup' : 'signin';
  const [tab, setTab] = useState<'signin' | 'signup'>(initialTab);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  return (
    <div className="auth-page">
      <div className="auth-card">
        <Link href="/" className="auth-logo">
          <svg width="40" height="40" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="var(--accent)" />
            <path d="M14 16h20v2H14zm0 6h20v2H14zm0 6h14v2H14zm18 0h2v2h-2z" fill="var(--accent-text)" />
          </svg>
        </Link>
        <h1 className="auth-title">{tab === 'signin' ? 'Sign in to InvoiceIQ' : 'Create your account'}</h1>
        <p className="auth-subtitle muted">
          {tab === 'signin'
            ? 'Choose your preferred sign-in method'
            : 'Get started with AI-powered invoice processing'}
        </p>

        <div className="auth-providers">
          <a href="/auth/github" className="auth-provider-btn">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Continue with GitHub
          </a>
          <a href="/auth/google" className="auth-provider-btn">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Continue with Google
          </a>
          <a href="/auth/microsoft" className="auth-provider-btn">
            <svg width="20" height="20" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#F25022" />
              <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
              <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
              <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
            </svg>
            Continue with Microsoft
          </a>
        </div>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            const endpoint = tab === 'signin' ? '/auth/login' : '/auth/register';
            const body: Record<string, string> = { email, password };
            if (tab === 'signup') body.name = name;
            fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            })
              .then((res) => {
                if (res.ok) window.location.href = '/onboarding';
                else res.json().then((d) => alert(d.error || 'Something went wrong'));
              })
              .catch(() => alert('Network error. Please try again.'));
          }}
        >
          {tab === 'signup' && (
            <label className="auth-field">
              <span className="auth-label">Full name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                className="auth-input"
                autoComplete="name"
              />
            </label>
          )}
          <label className="auth-field">
            <span className="auth-label">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="auth-input"
              autoComplete="email"
            />
          </label>
          <label className="auth-field">
            <span className="auth-label">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={tab === 'signup' ? 'Create a password' : 'Enter your password'}
              required
              minLength={8}
              className="auth-input"
              autoComplete={tab === 'signin' ? 'current-password' : 'new-password'}
            />
          </label>
          <button type="submit" className="btn btn-primary auth-submit">
            {tab === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="auth-switch muted small">
          {tab === 'signin' ? (
            <>
              {"Don't have an account? "}
              <button className="btn-link" onClick={() => setTab('signup')}>Sign up</button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button className="btn-link" onClick={() => setTab('signin')}>Sign in</button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
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
      <LoginForm />
    </Suspense>
  );
}
