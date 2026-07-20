---
"@nuraljs/core": patch
---

**Lazy-load the server engine so consumers install only the one they use.** Previously, importing `@nuraljs/core` eagerly loaded *both* the `fastify` and `express` adapters (and thus both engine packages) at module-load time — so an Express-only app was forced to install `fastify`, and vice-versa. The engine is now resolved lazily inside the adapter constructor (via `createRequire`), so only the engine selected by `framework` is `require`d. An app that never selects an engine never touches its package. Selecting an engine whose package isn't installed now throws a clear, actionable error (e.g. "the Fastify engine was selected … run `npm install fastify`") instead of a raw `MODULE_NOT_FOUND`. Both engines remain optional peer dependencies.

Also removed the unused `swagger-ui-express` dependency: the docs UI (Swagger + Scalar) is served from CDN-hosted assets and never imported the package. Because `swagger-ui-express` peer-required `express`, its removal means a Fastify-only app no longer pulls `express` in transitively. Net result: an app installs only the one engine it actually uses. No API changes.
