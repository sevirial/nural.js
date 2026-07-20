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
        // Raised to error in Sprint 11 (T11.4): the codebase is `any`-free
        // (production + tests). `unknown` + Zod validation is the boundary idiom.
        "@typescript-eslint/no-explicit-any": "error",
        "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
};
