import { defineConfig } from "vitest/config";

// This example ships no unit tests; keep the workspace-level
// `pnpm -r exec vitest run` (bare `vitest run`) green.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
