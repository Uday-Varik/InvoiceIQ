/**
 * Outbound account email. The interface is the seam: the log mailer
 * writes the full link to the server log so local development works
 * with no mail account at all, and the Resend mailer sends through
 * the Resend API. No route or token-flow changes are needed to switch
 * providers; until a real provider is configured, no email leaves the
 * server, and the runbook says so plainly.
 *
 * Links are built from the frontend origin so they land on the web app,
 * which proxies /auth/* to this service.
 */

export interface Mailer {
  sendVerificationEmail(to: string, link: string): Promise<void>;
  sendPasswordResetEmail(to: string, link: string): Promise<void>;
}

export interface MailerOptions {
  /** Address shown as the sender once a real provider exists. */
  readonly from: string;
}

export interface ResendMailerOptions extends MailerOptions {
  readonly apiKey: string;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchFn?: typeof fetch | undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Sends account email through Resend (POST /emails, Bearer API key).
 * A non-2xx response throws with the status and Resend's message, so a
 * failed send fails the sign-up/reset request instead of pretending
 * the email went out. The API key never appears in the error.
 */
export function resendMailer(opts: ResendMailerOptions): Mailer {
  const send = async (to: string, subject: string, body: string, link: string): Promise<void> => {
    const fetchFn = opts.fetchFn ?? fetch;
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        'content-type': 'application/json',
        // Resend rejects requests without a User-Agent.
        'user-agent': 'InvoiceIQ/1.0',
      },
      body: JSON.stringify({
        from: opts.from,
        to,
        subject,
        html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
        text: `${body}\n\n${link}`,
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const payload = (await res.json()) as { message?: unknown };
        if (typeof payload.message === 'string') detail = `: ${payload.message}`;
      } catch {
        // The body was not JSON; the status alone is the report.
      }
      throw new Error(`Resend send failed (HTTP ${res.status})${detail}`);
    }
  };
  return {
    async sendVerificationEmail(to, link) {
      await send(to, 'Verify your InvoiceIQ email', 'Verify your email address to finish creating your InvoiceIQ account:', link);
    },
    async sendPasswordResetEmail(to, link) {
      await send(to, 'Reset your InvoiceIQ password', 'Use this link to reset your InvoiceIQ password. It expires in one hour:', link);
    },
  };
}

export function logMailer(opts: MailerOptions): Mailer {
  const log = (kind: string, to: string, link: string) => {
    // Deliberately includes the full link: with no mail provider, the log
    // is the delivery channel. Never log the recipient's password or token
    // hashes; the link itself is single-use and expiring.
    console.log(`[mailer:${kind}] from=${opts.from} to=${to} link=${link}`);
  };
  return {
    async sendVerificationEmail(to, link) {
      log('verify-email', to, link);
    },
    async sendPasswordResetEmail(to, link) {
      log('reset-password', to, link);
    },
  };
}

export function verificationLink(appBaseUrl: string | undefined, token: string): string {
  const base = (appBaseUrl ?? '').replace(/\/$/, '');
  return `${base}/login?verify=${encodeURIComponent(token)}`;
}

export function resetLink(appBaseUrl: string | undefined, token: string): string {
  const base = (appBaseUrl ?? '').replace(/\/$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}
