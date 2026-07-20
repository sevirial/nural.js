/** @type {import("eslint").Linter.Config} */
module.exports = {
    root: true,
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint"],
    extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/recommended"
    ],
    env: {
        node: true,
        es2022: true
    },
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
    },
    rules: {
        // Sprint 6 (T6.7): raised from "warn" to "error". The auth package is
        // fully `any`-free — every boundary uses `unknown` + narrowing — so this
        // is enforced package-wide (covering every file touched this sprint).
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
};
