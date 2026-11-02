import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resendMailer } from '../src/auth/mailer.js';

function fakeFetch(status: number, body: unknown = {}) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('resend mailer', () => {
  it('posts the verification email to Resend with a Bearer key and User-Agent', async () => {
    const fetchFn = fakeFetch(200, { id: 'msg-1' });
    const mailer = resendMailer({ from: 'InvoiceIQ <hello@example.com>', apiKey: 're_test', fetchFn });
    await mailer.sendVerificationEmail('alice@example.com', 'https://app.example/login?verify=tok');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test');
    expect(headers['user-agent']).toBe('InvoiceIQ/1.0');
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      from: 'InvoiceIQ <hello@example.com>',
      to: 'alice@example.com',
      subject: 'Verify your InvoiceIQ email',
    });
    expect(String(payload.html)).toContain('https://app.example/login?verify=tok');
    expect(String(payload.text)).toContain('https://app.example/login?verify=tok');
  });

  it('throws with the provider message on a failed send, without the key', async () => {
    const fetchFn = fakeFetch(403, { message: 'You can only send testing emails to your own email address' });
    const mailer = resendMailer({ from: 'onboarding@resend.dev', apiKey: 're_secret_key', fetchFn });
    await expect(mailer.sendPasswordResetEmail('bob@example.com', 'https://app.example/reset-password?token=tok')).rejects.toThrow(
      /Resend send failed \(HTTP 403\).*own email address/,
    );
    await expect(mailer.sendPasswordResetEmail('bob@example.com', 'https://app.example/reset-password?token=tok')).rejects.not.toThrow(
      /re_secret_key/,
    );
  });

  it('throws a status-only error when the failure body is not JSON', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    const mailer = resendMailer({ from: 'onboarding@resend.dev', apiKey: 're_test', fetchFn });
    await expect(mailer.sendVerificationEmail('a@example.com', 'https://app.example/login?verify=x')).rejects.toThrow(
      'Resend send failed (HTTP 500)',
    );
  });
});

describe('mailer config validation', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    MIGRATION_DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    AI_SERVICE_URL: 'https://ai.example.com',
    AI_SIGNING_SECRET: 's'.repeat(32),
    AUTH_MODE: 'github',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 's'.repeat(32),
  } as NodeJS.ProcessEnv;

  it('requires an API key and a real sender for the resend provider', () => {
    expect(() => loadConfig({ ...base, MAILER_PROVIDER: 'resend' })).toThrow(/MAILER_API_KEY/);
    expect(() =>
      loadConfig({ ...base, MAILER_PROVIDER: 'resend', MAILER_API_KEY: 're_test' }),
    ).toThrow(/MAILER_FROM/);
    expect(
      loadConfig({
        ...base,
        MAILER_PROVIDER: 'resend',
        MAILER_API_KEY: 're_test',
        MAILER_FROM: 'InvoiceIQ <hello@example.com>',
      }).MAILER_PROVIDER,
    ).toBe('resend');
  });
});
