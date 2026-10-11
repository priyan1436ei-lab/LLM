import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Real Postgres (PGlite) tests each own a data directory; running files in parallel
    // would mean two PGlite instances writing the same directory, which silently loses
    // writes on this engine. Single-threaded is a correctness requirement, not a
    // performance preference.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
