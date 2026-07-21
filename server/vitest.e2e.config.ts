import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e.*.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
