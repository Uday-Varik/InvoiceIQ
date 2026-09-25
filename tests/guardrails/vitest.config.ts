import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/guardrails/**/*.test.ts'],
    root: new URL('../..', import.meta.url).pathname,
  },
});
