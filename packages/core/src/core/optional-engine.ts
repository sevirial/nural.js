/**
 * Lazily resolve an optional server engine (`fastify` / `express`) at the moment
 * an adapter is constructed — never at module load. This is what lets a consumer
 * install only the engine they use: importing `@nuraljs/core` no longer pulls in
 * both engines eagerly.
 *
 * We build a real CommonJS `require` via `createRequire(import.meta.url)` rather
 * than calling a bare `require`. In the ESM bundle a bare `require` is rewritten
 * by esbuild to a stub that throws "Dynamic require not supported"; `createRequire`
 * gives a genuine resolver that walks the consumer's `node_modules`. tsup's
 * `shims` provides `import.meta.url` in the CJS bundle, so this works in both.
 */
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/**
 * Require an optional engine by name, returning its callable factory. Throws a
 * friendly, actionable error (not a raw `MODULE_NOT_FOUND`) when the engine the
 * app selected isn't installed.
 */
export function requireEngine<T>(name: string, friendlyMessage: string): T {
  let mod: unknown;
  try {
    mod = nodeRequire(name);
  } catch {
    throw new Error(friendlyMessage);
  }
  const m = mod as { default?: T };
  return (m && m.default) || (mod as T);
}
