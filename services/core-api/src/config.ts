import { createPrivateKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/** An Ed25519 private key from PEM or base64 DER, or undefined if it is neither. */
export function parseCheckpointKey(raw: string): KeyObject | undefined {
  try {
    const text = raw.trim();
    const key = text.startsWith('-----BEGIN')
      ? createPrivateKey(text)
      : createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' });
    return key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Environment for the core-api process. Parsed once at boot; a bad value fails fast. */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /** App role (invoiceiq_app). RLS applies to it. */
    DATABASE_URL: z.string().min(1),
    /** Owner role. When set, migrations run on boot (free tiers have no pre-deploy hook). */
    MIGRATION_DATABASE_URL: z.string().min(1).optional(),

    AUTH_MODE: z.enum(['oidc', 'demo']).default('oidc'),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_AUDIENCE: z.string().min(1).optional(),
    OIDC_JWKS_URL: z.string().url().optional(),
    OIDC_TENANT_CLAIM: z.string().min(1).default('tenant_id'),
    OIDC_ROLES_CLAIM: z.string().min(1).default('roles'),
    DEMO_TENANT_NAME: z.string().min(1).max(200).default('InvoiceIQ demo'),

    AI_SERVICE_URL: z.string().url(),
    AI_SIGNING_SECRET: z.string().min(32, 'AI_SIGNING_SECRET must be at least 32 characters'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(60_000),

    OUTBOX_POLL_MS: z.coerce.number().int().min(250).max(600_000).default(5_000),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
    /**
     * Ed25519 private key that signs audit checkpoints: PKCS#8 PEM, or its DER
     * as base64. Unset means a fresh key per boot (checkpoints still verify
     * with the public key they carry, but the key id changes on restart).
     */
    AUDIT_CHECKPOINT_KEY: z
      .string()
      .min(1)
      .optional()
      .refine((v) => v === undefined || parseCheckpointKey(v) !== undefined, 'AUDIT_CHECKPOINT_KEY must be an Ed25519 PKCS#8 key (PEM or base64 DER)'),
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(10 * 1024 * 1024),

    /**
     * Password for invoiceiq_app. When set with MIGRATION_DATABASE_URL, boot
     * gives the role LOGIN with this password after migrating, so a fresh
     * database needs no hand-run SQL (infra/terraform generates it).
     */
    APP_DB_PASSWORD: z.string().min(24, 'APP_DB_PASSWORD must be at least 24 characters').optional(),

    /** Bearer token Prometheus sends to scrape /metrics. Unset in production hides /metrics. */
    METRICS_TOKEN: z.string().min(32, 'METRICS_TOKEN must be at least 32 characters').optional(),
    /** Per client address. 0 turns a limit off. Reads are never limited. */
    RATE_LIMIT_WRITES_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).default(120),
    RATE_LIMIT_UPLOADS_PER_MINUTE: z.coerce.number().int().min(0).max(100_000).default(20),
    /** Reverse proxies in front of core-api; the client address is read that many hops back. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
    /** Labels invoiceiq_build_info. Render sets RENDER_GIT_COMMIT on its own. */
    BUILD_VERSION: z.string().min(1).max(64).default('0.0.0'),
    BUILD_COMMIT: z.string().min(1).max(64).optional(),
    RENDER_GIT_COMMIT: z.string().min(1).max(64).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'oidc') {
      for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when AUTH_MODE=oidc` });
      }
    }
    if (env.APP_DB_PASSWORD && !env.MIGRATION_DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['APP_DB_PASSWORD'], message: 'APP_DB_PASSWORD is applied by the migrator and needs MIGRATION_DATABASE_URL' });
    }
    if (env.AUTH_MODE === 'demo' && !env.MIGRATION_DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['MIGRATION_DATABASE_URL'], message: 'demo mode bootstraps its tenant and needs MIGRATION_DATABASE_URL' });
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid core-api configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
