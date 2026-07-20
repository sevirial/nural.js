import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["src/**/*.spec.ts"],
        // Real coverage exists, so an empty/vacuous run must FAIL rather than
        // silently pass green — matching core/microservices/cli.
        passWithNoTests: false,
    }
});
