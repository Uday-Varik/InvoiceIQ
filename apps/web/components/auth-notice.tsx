'use client';

import { useMe } from './me';

export function AuthNotice() {
  const me = useMe();
  if (!me) return null;

  if (me.authMode === 'github') {
    return (
      <span className="auth-notice">
        <span className="small">{me.userId}</span>
        <button
          className="btn-link small"
          onClick={async () => {
            await fetch('/auth/logout', { method: 'POST' });
            window.location.href = '/login';
          }}
        >
          Sign out
        </button>
      </span>
    );
  }

  if (me.authMode === 'demo') {
    return <span className="muted small demo-notice">Public demo: shared tenant</span>;
  }

  return null;
}
