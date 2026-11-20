import { defineConfig } from "vitest/config";

// Vitest suites are `*.spec.ts`. The kernel's `*.test.ts` files are standalone proofs run by `pnpm proof`.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.spec.ts", "apps/*/src/**/*.spec.ts"],
    testTimeout: 30_000,
  },
});
