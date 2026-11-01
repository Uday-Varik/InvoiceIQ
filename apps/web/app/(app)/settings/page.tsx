'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from '../../../components/page-header';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { inputClass } from '../../../components/ui/field';

interface AuthMe {
  authenticated: boolean;
  login: string;
  provider: string;
  roles: string[];
  tenantId: string;
  sessionId: string;
  mfaVerified: boolean;
}

interface SessionItem {
  id: string;
  provider: string;
  tenantId: string;
  roles: string[];
  mfaVerified: boolean;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
}

async function postJson(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { detail?: string };
  if (!res.ok) throw new Error(data.detail || `Request failed (${res.status})`);
  return data;
}

export default function SettingsPage() {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<{ otpauthUrl: string; secret: string } | null>(null);
  const [setupCode, setSetupCode] = useState('');
  const [setupError, setSetupError] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState('');
  const [disableError, setDisableError] = useState('');
  const [notice, setNotice] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordDone, setPasswordDone] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/auth/me').then((r) => r.json() as Promise<AuthMe>),
      fetch('/auth/mfa/status').then((r) => r.json() as Promise<{ enabled: boolean }>),
      fetch('/auth/sessions').then((r) => r.json() as Promise<{ items: SessionItem[] }>),
    ])
      .then(([meData, mfaData, sessionData]) => {
        setMe(meData);
        setMfaEnabled(mfaData.enabled);
        setSessions(sessionData.items);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleSetup(e: FormEvent) {
    e.preventDefault();
    setSetupError('');
    try {
      const data = (await postJson('/auth/mfa/setup', {})) as { otpauthUrl: string; secret: string };
      setSetup(data);
    } catch (err: unknown) {
      setSetupError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleVerifySetup(e: FormEvent) {
    e.preventDefault();
    setSetupError('');
    try {
      const data = (await postJson('/auth/mfa/verify-setup', { code: setupCode })) as { recoveryCodes: string[] };
      setRecoveryCodes(data.recoveryCodes);
      setMfaEnabled(true);
      setSetup(null);
      setSetupCode('');
    } catch (err: unknown) {
      setSetupError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDisable(e: FormEvent) {
    e.preventDefault();
    setDisableError('');
    try {
      await postJson('/auth/mfa/disable', { code: disableCode });
      setMfaEnabled(false);
      setDisableCode('');
      setNotice('Two-factor authentication is off.');
    } catch (err: unknown) {
      setDisableError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordError('');
    try {
      await postJson('/auth/credentials/change-password', { currentPassword, newPassword });
      setPasswordDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setNotice('Password changed. Every other sign-in for this account has been ended.');
    } catch (err: unknown) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevoke(sessionId: string) {
    await postJson(`/auth/sessions/${sessionId}/revoke`, {});
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }

  async function handleRevokeOthers() {
    await postJson('/auth/sessions/revoke-others', {});
    setSessions((prev) => prev.filter((s) => s.current));
    setNotice('Every other sign-in for this account has been ended.');
  }

  return (
    <>
      <PageHeader
        title="Account & security"
        description="Your sign-in, two-factor authentication, password, and active sessions."
      />
      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-muted-foreground">{notice}</p>}

      {me && (
        <Card className="mb-4 p-4">
          <h2 className="text-sm font-semibold">Signed in as {me.login}</h2>
          <p className="text-sm text-muted-foreground">
            {me.provider} · roles: {me.roles.join(', ')} · this session{' '}
            {me.mfaVerified ? 'passed two-factor authentication' : 'did not pass two-factor authentication'}
          </p>
        </Card>
      )}

      <Card className="mb-4 p-4">
        <h2 className="text-sm font-semibold">Two-factor authentication</h2>
        {mfaEnabled === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : mfaEnabled ? (
          <>
            <p className="text-sm text-muted-foreground">
              On. Sign-ins ask for a code from your authenticator app. Turning it off needs a current code
              or a recovery code.
            </p>
            <form onSubmit={handleDisable} className="mt-3 flex flex-col gap-2">
              <input
                type="text"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="Current code or recovery code"
                required
                className={inputClass}
              />
              {disableError && <p className="text-sm text-destructive">{disableError}</p>}
              <div>
                <Button type="submit" variant="outline">Turn off two-factor authentication</Button>
              </div>
            </form>
          </>
        ) : setup ? (
          <form onSubmit={handleVerifySetup} className="mt-3 flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Add this account to your authenticator app, then enter the code it shows. If you cannot
              scan, enter the key by hand:
            </p>
            <p className="text-sm font-mono break-all">{setup.secret}</p>
            <input
              type="text"
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              placeholder="6-digit code"
              required
              autoComplete="one-time-code"
              className={inputClass}
            />
            {setupError && <p className="text-sm text-destructive">{setupError}</p>}
            <div>
              <Button type="submit">Verify and turn on</Button>
            </div>
          </form>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Off. Turn it on to require a code from an authenticator app at sign-in, in addition to
              your password or provider sign-in.
            </p>
            {setupError && <p className="text-sm text-destructive">{setupError}</p>}
            <form onSubmit={handleSetup} className="mt-3">
              <Button type="submit">Set up two-factor authentication</Button>
            </form>
          </>
        )}
        {recoveryCodes && (
          <div className="mt-3">
            <p className="text-sm font-semibold">Recovery codes — shown once. Save them somewhere safe.</p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-sm">
              {recoveryCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              Each code works once, if you lose access to your authenticator app. A new set is issued
              each time two-factor authentication is set up again.
            </p>
          </div>
        )}
      </Card>

      {me?.provider === 'credentials' && (
        <Card className="mb-4 p-4">
          <h2 className="text-sm font-semibold">Change password</h2>
          {passwordDone ? (
            <p className="text-sm text-muted-foreground">Password changed.</p>
          ) : (
            <form onSubmit={handleChangePassword} className="mt-3 flex flex-col gap-2">
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Current password"
                required
                autoComplete="current-password"
                className={inputClass}
              />
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password — at least 12 characters"
                required
                minLength={12}
                autoComplete="new-password"
                className={inputClass}
              />
              {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
              <div>
                <Button type="submit">Change password</Button>
              </div>
            </form>
          )}
        </Card>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Active sessions</h2>
        <p className="text-sm text-muted-foreground">
          Every device and browser signed in as you. Ending a session signs that device out; ending all
          others leaves only this one.
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3">
              <span className="text-sm">
                {s.userAgent ?? s.provider} · last seen {new Date(s.lastSeenAt).toLocaleString()}
                {s.current ? ' · this session' : ''}
                {s.mfaVerified ? '' : ' · no two-factor check'}
              </span>
              {!s.current && (
                <Button type="button" variant="outline" size="sm" onClick={() => handleRevoke(s.id)}>
                  End session
                </Button>
              )}
            </li>
          ))}
        </ul>
        {sessions.some((s) => !s.current) && (
          <div className="mt-3">
            <Button type="button" variant="outline" onClick={handleRevokeOthers}>
              End all other sessions
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
