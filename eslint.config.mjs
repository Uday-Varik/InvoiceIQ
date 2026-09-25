// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architecture rules live here as `no-restricted-imports`. They are proven to
 * fire by tests/guardrails/architecture-lint.test.ts, so a rule that silently
 * stops matching (a renamed path, a bad glob) fails CI instead of rotting.
 */
export const DOMAIN_PURITY = {
  patterns: [
    { group: ['fastify', 'fastify/*', '@fastify/*'], message: 'core-api domain must not depend on the HTTP framework (ADR-0005).' },
    { group: ['pg', 'pg/*', 'postgres', 'kysely', 'drizzle-orm', 'drizzle-orm/*'], message: 'core-api domain must not touch the database directly.' },
    { group: ['**/http/**', '**/http'], message: 'domain must not import the HTTP layer.' },
    { group: ['node:http', 'node:https', 'node:net', 'axios', 'undici'], message: 'domain code does no I/O.' },
  ],
};

export const WEB_BOUNDARY = {
  patterns: [
    { group: ['**/services/**', '@invoiceiq/core-api', '@invoiceiq/core-api/*'], message: 'apps/web talks to services only through @invoiceiq/contracts (ADR-0002).' },
  ],
};

export const NO_AI_SDK_IN_CORE = {
  patterns: [
    { group: ['openai', 'openai/*', '@anthropic-ai/*', 'ai', '@ai-sdk/*', 'langchain', '@langchain/*'], message: 'core-api never calls a model; AI lives in ai-service (ADR-0007).' },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.venv/**',
      'packages/contracts/generated/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['log', 'error', 'warn'] }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['services/core-api/src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', NO_AI_SDK_IN_CORE] },
  },
  {
    files: ['services/core-api/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...DOMAIN_PURITY.patterns, ...NO_AI_SDK_IN_CORE.patterns] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'no-restricted-imports': ['error', WEB_BOUNDARY] },
  },
  {
    files: ['**/test/**/*.ts', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
