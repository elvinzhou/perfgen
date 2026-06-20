import { defineConfig } from 'vitest/config';

export default defineConfig({
  publicDir: false,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['public/js/math.js', 'public/js/buckets.js', 'public/js/aggregate.js', 'public/js/wasm-bridge.js'],
      reporter: ['text', 'lcov'],
    },
  },
});
