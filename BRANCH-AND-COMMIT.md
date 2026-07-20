# Branch & Commit Plan

Comparison target: `nural_ecosystem/nuraljs-main` (a snapshot of `sevirial/nural.js` @ `main`, files dated 2026-02-23).
Prepared: 2026-07-15.

---

## ⚠️ Read this before you commit anything

**This working tree is not "main plus new work." It is a divergent fork of an older base, and it is missing four releases' worth of features that exist on `main`.**

`main` is at **core 0.7.0**. This tree is at **core 0.5.1** — a *lower* number, on a *different* architecture. Merging this as-is would delete working, documented, shipped features and move the version backwards.

| | `nuraljs-main` | this tree |
|---|---|---|
| core version | **0.7.0** | 0.5.1 |
| Zod | 3.25 | **4** |
| OpenAPI | `@asteasolutions/zod-to-openapi` | native `z.toJSONSchema` |
| Validation path | Zod per request | **ajv + fast-json-stringify, compiled at boot** |
| `defineGuard` | ✅ | ❌ **absent** |
| `defineInterceptor` | ✅ | ❌ **absent** |
| `ConfigService` / `defineConfig` | ✅ | ❌ **absent** |
| `CronService` | ✅ | ❌ **absent** |
| WebSockets (`createGateway`) | ✅ | ❌ **absent** |
| `InferContext` / `ExecutionContext` | ✅ | ❌ **absent** |
| App class export | `Nural` | **renamed** `Nuraljs` |
| `@nuraljs/auth` | ❌ | ✅ **new** |
| `@nuraljs/microservices` | ❌ | ✅ **new** |
| core src files | 61 | 38 |

### Evidence

- `main`'s `packages/core/src/index.ts` exports `defineGuard`, `defineInterceptor`, `defineConfig`, `ConfigService`, `LoggerService`, `CronService`, `InferContext`, and re-exports `common/websocket.types`, `common/cron.types`, `router/route-storage.types`. Grepping this tree's `packages/core/src` for `defineGuard|defineInterceptor|createGateway` returns **zero hits**.
- `main`'s `CHANGELOG.md` documents releases this tree never received:
  - **0.4.1** (Feb 17) — CLI `routes`, `console`/`tinker`
  - **0.5.0** (Feb 18) — lifecycle providers, guard system w/ `ExecutionContext`, interceptors, exception filters, route `meta`, CLI `doctor`/`update`/`completion`, granular generators
  - **0.6.0** (Feb 18) — WebSocket architecture, `createGateway` fluent builder
  - **0.7.0** (Feb 23) — DI, guards, interceptors, `@nuraljs/testing`, CLI `.command.ts` convention, **and the `nural` → `@nuraljs/*` mass rename**
- **The rename was already done on `main` at 0.7.0.** This tree re-did it at its own 0.5.0 and wrote a fresh "Rebrand `nural` → `@nuraljs/core` (breaking)" changelog entry. Committing that entry would duplicate history that already exists upstream.
- **The fork point differs per package.** This tree's CLI *has* main's 0.5.0-era commands (`doctor`, `update`, `completion`, `console`, `routes`) but *not* main's 0.7.0 `.command.ts` renaming — so the CLI forked around 0.5.0/0.6.0, while core forked earlier.

### The consequence worth pausing on

`@nuraljs/auth`'s guard was deliberately rebuilt on `defineMiddleware` because this tree's `CLAUDE.md` states *"core has **no** `defineGuard`… Do not invent one."* That premise is **true of this fork and false of `main`** — `main` has shipped `defineGuard` with a typed `ExecutionContext` and route `meta` since 0.5.0, which is exactly what an auth guard wants. The auth package may be built against the wrong core.

### So decide first

1. **Is `main` still the live line?** If yes, this is a *merge/rebase problem*, not a commit-message problem — the guard/interceptor/config/cron/WebSocket surface has to be ported forward onto this tree (or this tree's fast path ported back), and the app class rename reconciled.
2. **If this tree deliberately supersedes `main`** (a v2 that intentionally drops interceptors/cron/gateways), then the dropped features must be named in the commit as breaking removals, and the version must go **up**, not down: **0.8.0**, never 0.5.1.
3. Nothing is published to npm (all `@nuraljs/*` names return 404), so no external consumer breaks either way. This is an internal-history decision.

The branch and message below assume **option 2** — that this tree intentionally supersedes `main`. **If option 1 is the truth, do not use them.**

---

## Branch name

```
rewrite/v0.8.0-zod4-fastify-core-auth-microservices
```

Alternatives, same intent:

- `rewrite/core-zod4-fastify-plus-enterprise-packages`
- `feat/v0.8.0-performance-rewrite`

Rationale: `rewrite/` (not `feat/`) signals this replaces an architecture rather than adding to one; the version communicates that it lands **above** main's 0.7.0.

---

## Commit message

```
rewrite!: Zod-4/Fastify-native core, plus @nuraljs/auth and @nuraljs/microservices

Rewrite the core hot path so Zod executes zero times per request, and add two
enterprise packages to the workspace. Supersedes the 0.7.0 architecture.

Core (0.7.0 -> 0.8.0)
- Compile Zod schemas to JSON Schema once at boot; ajv validates and
  fast-json-stringify serializes per request. Zod becomes the authoring API,
  not a per-request cost. Routes using .refine/.transform/.superRefine fall
  back to sync Zod parse() for the affected slot only.
- Upgrade Zod 3.25 -> 4; drop @asteasolutions/zod-to-openapi in favour of
  native z.toJSONSchema. An .openapi() -> .meta() shim keeps the old surface.
- Make Fastify the optimized engine; Express keeps compiling but is legacy.
- Lazy-load the selected engine so an app installs only the engine it uses.
- Run middleware as per-route preValidation hooks, so auth rejects with 401
  before validation rejects with 400.

New: @nuraljs/auth 0.5.0
- ChaCha20-Poly1305 binary token engine; HKDF-SHA256 key derivation;
  mandatory exp with clock-skew tolerance; iat/nbf/iss/aud/jti claims and a
  pluggable revocation hook.
- 3-tier KMS (static/local/cloud) with single-flight refresh, exponential
  backoff, rotation overlap window, and disposable lifecycles.
- Refresh-token sessions: atomic Lua ops, tokens hashed at rest, token-family
  reuse detection, sliding expiry, per-user session caps.
- OAuth/OIDC (GitHub/Google/OIDC) with enforced state/PKCE/nonce, and a pure
  RBAC/ABAC policy engine.

New: @nuraljs/microservices 0.5.1
- Contract-first RPC over Redis/Kafka/RabbitMQ with Zod contracts on the wire.
- Reconnect w/ backoff, graceful drain, bounded concurrency, UUID correlation
  IDs, timeouts, a typed error envelope, and DLQ/max-retry instead of silent
  drops or infinite requeue. Brokers are optional peer dependencies.

Security
- Close 10 audit findings (5 medium, 5 low): CORS origin reflection, OIDC
  unverified-email acceptance, id_token replay via optional nonce, idempotency
  key namespacing, verbatim handler-error leakage, JWKS use/alg confusion,
  unbounded pre-parse message size, emit() payload misrouting, and the signer
  replay window. See SECURITY-AUDIT.md.

Release hygiene
- Unify all five packages under one pnpm workspace with changesets; replace
  file: core links with workspace:*.
- engines: node >=24 across every package (was >=16, or absent).
- Add publishConfig.access=public, repository/bugs/homepage where missing;
  sync README version badges.

Verification: 590 tests pass (core 76, cli 165, auth 207, microservices 124
+7 broker-integration skips, testing 18); tsc --noEmit, eslint, and tsup are
clean; all five tarballs install from a clean directory and import under both
ESM and CJS.

BREAKING CHANGE: The app class is renamed Nural -> Nuraljs (and NuralConfig ->
NuraljsConfig).

BREAKING CHANGE: defineGuard, defineInterceptor, defineConfig, ConfigService,
CronService, LoggerService, InferContext/ExecutionContext, and the WebSocket
gateway API (createGateway) are REMOVED. They exist in 0.5.0-0.7.0 and have no
replacement in this tree. Guards are expressed as middleware via
defineMiddleware; there is no interceptor, cron, config-service, or gateway
equivalent. Do not merge until this removal is intended and accepted.

BREAKING CHANGE: Tokens minted before this change fail AEAD verification (keys
are now HKDF-derived), and tokens without an exp claim are rejected.
```

### Notes on the message

- `rewrite!:` + `BREAKING CHANGE:` trailers follow Conventional Commits; the `!` and the trailers are what drive a major/minor bump if you ever automate it.
- **The second `BREAKING CHANGE` is the important one.** It is written as a blocker on purpose: if you don't intend to remove guards/interceptors/cron/config/gateways, that paragraph is your signal to stop and reconcile with `main` instead of committing.
- Body wraps at 72 chars.

---

## Before you run `git init`

- **There is no git repository** anywhere in `nural_ecosystem` — no history to diff against, and this whole comparison had to be done by reading trees side by side. If `sevirial/nural.js` is real and live, **clone it and branch from it** rather than `git init`-ing this folder; otherwise you lose main's history and the 0.5.0–0.7.0 work with it.
- **Metadata is inconsistent right now**: `repository` points at `sevirial/nural.js`, while `bugs` and `homepage` still point at `ErrorX407/nural` (and `auth`/`microservices` name separate `nural-auth`/`nural-microservices` repos). Pick one and make all five packages agree before the first publish.
- **`@nuraljs/core` ships an unused `socket.io` dependency** (no `socket` reference anywhere in `packages/core/src`) — a leftover from the WebSocket code this fork dropped. Remove it, or restore the gateway feature it belongs to.
