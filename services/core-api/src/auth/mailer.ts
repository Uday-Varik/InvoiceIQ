/**
 * Outbound account email. The interface is the seam: today the only
 * provider is the log mailer, which writes the full link to the server
 * log so an operator can retrieve it (and so local development works
 * with no mail account at all). A real transactional provider (Resend,
 * SendGrid, SES) plugs in here behind MAILER_PROVIDER with no route or
 * token-flow changes; until one is configured, no email leaves the
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
