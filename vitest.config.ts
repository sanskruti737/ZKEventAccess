import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30000,
    // The compact-runtime WASM instance is heavy; run test files sequentially
    // to avoid memory/CPU contention (especially under WSL).opwswsws
    fileParallelism: false,
  },
});
