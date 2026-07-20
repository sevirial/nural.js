import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // Real coverage now exists, so an empty/vacuous run must FAIL rather than
    // silently pass green (this package previously ran with `--passWithNoTests`,
    // which reported success while testing nothing).
    passWithNoTests: false,
    // The generate/scaffold specs `chdir` into a temp project directory, so they
    // must not share a process — one file's cwd would leak into another's.
    fileParallelism: false,
  },
});
