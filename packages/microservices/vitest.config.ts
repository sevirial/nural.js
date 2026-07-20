import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.spec.ts"],
        // Sprint 11 (T11.5): real coverage now exists, so an empty/vacuous run
        // must FAIL rather than silently pass green.
        passWithNoTests: false,
    }
});
