import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,ts}'],
    globals: false,
    setupFiles: ['tests/setup/ai-gateway-defaults.js'],
  },
});
