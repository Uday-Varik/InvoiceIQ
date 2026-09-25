import { z } from 'zod';

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
    MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(10 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'oidc') {
      for (const key of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when AUTH_MODE=oidc` });
      }
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
