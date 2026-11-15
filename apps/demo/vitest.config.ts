import { defineConfig } from 'vitest/config';

// Each test file boots workerd through Wrangler's test harness: give startup room.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 90_000 },
});
