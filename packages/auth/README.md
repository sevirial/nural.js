# @nuraljs/auth

> Functional, zero-class authentication for NuralJS — binary tokens, KMS, OAuth/OIDC, and a pure RBAC/ABAC policy engine.

![version](https://img.shields.io/badge/version-0.6.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

`@nuraljs/auth` is the authentication toolkit for the [NuralJS](https://nuraljs.org) ecosystem. Everything is a `createX` factory that returns a plain object of closures — no decorators, no classes, no reflection. It ships a ChaCha20-Poly1305 binary token engine, a 3-tier key-management system, hardened OAuth/OIDC providers, reuse-resistant refresh-token sessions, and a purely functional policy engine, all wired into `@nuraljs/core` through its `defineMiddleware` contract so authentication runs **before** body validation.

## Features

- **ChaCha20-Poly1305 binary tokens** — compact, encrypted, versioned AEAD packets (`[1B version][4B keyId][12B nonce][16B tag][ciphertext]`). Payloads are MessagePack-packed inside the seal, so unlisted fields never leak. `exp` is mandatory; `iat`/`jti` plus optional `nbf`/`iss`/`aud` and a pluggable revocation hook are supported.
- **3-tier KMS with HKDF-SHA256** — `static` (one env secret), `local` (multiple keys with a primary + rotation overlap), and `cloud` (polls your vault with exponential-backoff retry, single-flight refresh, and a `dispose()`). Every provider derives a real 32-byte AEAD key via HKDF-SHA256 — never a bare `SHA-256(secret)`, and every provider holds the same [secret-length floor](#secret-requirements) (≥ 32 characters recommended).
- **OAuth / OIDC providers** — GitHub, Google, and generic OIDC. `state` (anti-CSRF) and **PKCE (S256)** are required, not optional; OIDC additionally verifies the `id_token` signature and claims against the issuer's JWKS.
- **Refresh-token sessions** — short-lived access tokens paired with opaque refresh tokens. Refresh tokens are **hashed at rest** (only `sha256(token)` is stored), rotation is atomic, and replay of a rotated token trips **reuse detection**, revoking the whole token family. Ships an optional Redis store.
- **Pure RBAC/ABAC policy engine** — composable `definePolicy` combinators (`requireAll`/`requireAny`/`requireNone`) and role/permission helpers. Denials are explicit and observable (`PolicyDenied`), never a silent `[]`.
- **Nural guard integration** — `auth.guard` and `requirePolicy` run on core's `preValidation` hook, so an invalid token yields **401 before validation** and a failed policy yields **403**.

## Installation

```bash
pnpm add @nuraljs/auth zod
```

```bash
npm install @nuraljs/auth zod
```

`@nuraljs/core` is the host framework — install it too if you haven't already (`pnpm add @nuraljs/core`). `zod` is a peer dependency (Zod 4).

## Quick start

```ts
import { createAuth, createStaticKeyProvider } from "@nuraljs/auth";
import { z } from "zod";

const UserSchema = z.object({
  id: z.string(),
  role: z.enum(["admin", "user"]),
});

const auth = createAuth({
  strategy: {
    schema: UserSchema,
    keyProvider: createStaticKeyProvider(process.env.AUTH_SECRET!),
    expiresInSeconds: 900,      // drives the mandatory `exp`
    clockToleranceSeconds: 30,  // optional skew tolerance
    issuer: "api.example.com",  // optional — verified on `verify` when set
    audience: "web",
  },
});

// Sign → encrypted binary token (the Bearer value)
const token = await auth.sign({ id: "user_123", role: "admin" });

// Verify → typed payload (throws a typed AuthError on failure)
const user = await auth.verify(token);

// Use as NuralJS middleware. It runs on preValidation, so a bad token is a 401
// BEFORE body validation. The payload lands on the route context at `ctx.user`.
app.get("/me", { middleware: [auth.guard] }, (ctx) => {
  return ctx.user; // fully typed as z.infer<typeof UserSchema>
});
```

`createAuth` validates its own configuration at construction time — a misconfigured factory fails loudly at boot with a typed `AuthConfigError`, never on the first request.

## Tokens

The binary token engine is the spine of the package; `createAuth` builds one internally, but you can use it directly via `createBinaryTokenEngine` (also exposed as `auth.engine`).

```ts
import { createBinaryTokenEngine, createStaticKeyProvider } from "@nuraljs/auth";
import { z } from "zod";

const schema = z.object({ id: z.string(), role: z.string() });

const engine = createBinaryTokenEngine({
  schema,
  keyProvider: createStaticKeyProvider(process.env.AUTH_SECRET!),
  expiresInSeconds: 900,        // default 300
  clockToleranceSeconds: 0,     // skew tolerance for exp/nbf checks
  notBeforeSeconds: 0,          // when > 0, stamps + enforces `nbf`
  issuer: "api.example.com",    // optional iss binding
  audience: "web",              // optional aud binding
  isRevoked: (jti) => store.has(jti), // pluggable revocation; fails closed
  maxTokenBytes: 8192,          // default; input bound, 0 disables
});

const token = await engine.sign({ id: "user_123", role: "admin" });
const payload = await engine.verify(token);
```

The wire key is the HKDF-SHA256-derived key supplied by the KMS provider — the engine uses it verbatim and does not derive keys itself. When `isRevoked` is configured, a token carrying no `jti` is rejected (fail-closed).

`verify()` bounds the token's length (`maxTokenBytes`, default 8 KiB) before decoding or unpacking it, rejecting anything longer with `TokenInvalidError`. A real claims token is a few hundred bytes, so the default only rejects absurd input; it is defense-in-depth, since `unpack` already runs solely on AEAD-authenticated plaintext.

## Key management (KMS)

Three providers implement the same `KeyProvider` contract (`getPrimaryKey`, `getKey`, optional `dispose`). Each derives a 32-byte AEAD key from your secret via HKDF-SHA256.

```ts
import {
  createStaticKeyProvider,
  createLocalKeyProvider,
  createCloudKeyProvider,
} from "@nuraljs/auth";

// static — a single secret (>= 32 chars recommended), fixed key id, no rotation
const staticKey = createStaticKeyProvider(process.env.AUTH_SECRET!);

// local — multiple keys; the FIRST entry is the primary (signing) key,
// the rest are accepted for verification during a rotation window
const localKey = createLocalKeyProvider([
  { id: 2, secret: process.env.AUTH_KEY_CURRENT! },
  { id: 1, secret: process.env.AUTH_KEY_PREVIOUS! },
]);

// cloud — polls your vault with backoff retry + single-flight refresh
const cloudKey = createCloudKeyProvider({
  fetchSecrets: async () => [{ versionId: 3, value: await vault.current() }],
  pollIntervalMs: 60_000,     // steady-state poll interval
  overlapWindowMs: 300_000,   // grace window for rotated-out keys
});
// cloudKey.refreshNow() forces an immediate refresh; cloudKey.dispose() stops the timer
```

A custom `KeyProvider` must return **32 bytes of real key material** (derived via `deriveKeyMaterial`); the engine does not KDF it for you.

### Secret requirements

Your secret seeds a 256-bit ChaCha20-Poly1305 key. HKDF-SHA256 spreads whatever entropy it has across the full key, but it cannot manufacture entropy that was never there — so the secret's own length is the real floor.

| Secret length | Behavior |
|---|---|
| **≥ 32 characters** | ✅ Recommended. Accepted silently. |
| **16–31 characters** | ⚠️ **Deprecated.** Works, but warns once per provider — **rejected in the next major.** Rotate. |
| **< 16 characters** | ❌ Rejected at construction (`AuthConfigError`). |

This applies to all three providers: `createStaticKeyProvider(secret)`, each `secret` in `createLocalKeyProvider`, and each `value` your `fetchSecrets()` returns to `createCloudKeyProvider`. Generate one with real entropy rather than typing a passphrase:

```bash
openssl rand -base64 32   # or: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

The deprecation warning names only the length *category* and the affected key ids — never any secret bytes, so it is safe in a log. It reaches you as a Node `DeprecationWarning` (code `NURALJS_AUTH_SHORT_SECRET`) for the static/local providers, and through your configured `logger` for the cloud provider, which warns once rather than on every vault poll. The thresholds are exported as `MIN_SECRET_LENGTH_HARD` (16) and `SECRET_LENGTH_RECOMMENDED` (32).

**Rotating a short secret is a key change, not just a config edit** — tokens signed with the old secret stop verifying. Use `createLocalKeyProvider` (or your vault's versioning) to serve the new key as primary while the old one still verifies, then drop the old key once outstanding tokens have expired. See [MIGRATION.md](./MIGRATION.md).

## Sessions

Pair short-lived access tokens with long-lived, opaque refresh tokens. Only the SHA-256 hash of each refresh token is persisted, rotation is atomic, and replaying a rotated token revokes the entire token family.

```ts
import { createSessionManager, createRedisSessionStore } from "@nuraljs/auth";

const sessions = createSessionManager(auth, createRedisSessionStore(redis), {
  refreshTtlSeconds: 604_800, // 7 days (default); slides forward on rotation
  onReuse: (e) => logger.warn("refresh reuse detected", e),
});

const { accessToken, refreshToken } = await sessions.issue("user_123", user);

// Rotate → new access + refresh pair; throws RefreshTokenReuseError on replay
const rotated = await sessions.rotate(refreshToken, user);

const userId = await sessions.verify(refreshToken); // string | null, no rotation
await sessions.revoke(refreshToken);                // single session (family)
await sessions.revokeAll("user_123");               // log out everywhere
```

```ts
import { RefreshTokenReuseError } from "@nuraljs/auth";

try {
  await sessions.rotate(incoming, user);
} catch (err) {
  if (err instanceof RefreshTokenReuseError) {
    // token leaked — the family is already revoked; force re-authentication
  }
}
```

`createRedisSessionStore(client, options?)` takes any `MinimalRedisClient`; rotation and family revocation run atomically inside the store.

## OAuth / OIDC

Every provider requires `state` and PKCE. Generate them with the built-in helpers, stash `{ state, codeVerifier, nonce }` in the user's session, and hand them back on the callback.

```ts
import {
  createGoogleProvider,
  createGithubProvider,
  createOIDCProvider,
  createState,
  createPkcePair,
} from "@nuraljs/auth";

const google = createGoogleProvider({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: "http://localhost:3000/auth/google/callback",
});

// 1. Redirect the user to the provider
const state = createState();
const { codeVerifier, codeChallenge } = createPkcePair();
// persist { state, codeVerifier } in the session, then:
const url = await google.getAuthUrl({ state, codeChallenge });

// 2. On the callback, exchange the code for a normalized profile
const profile = await google.exchangeCode({
  code,                   // authorization code from the redirect query
  state,                  // `state` returned on the callback
  expectedState: state,   // `state` originally issued (from the session)
  codeVerifier,           // PKCE verifier matching the challenge
});
// profile: { providerId, email, name, picture?, raw }
```

`createOIDCProvider({ issuerUrl, clientId, clientSecret, redirectUri, ... })` performs discovery and additionally validates the `id_token` (JWKS signature, `iss`/`aud`/`exp`/`nonce`) — pass `expectedNonce` (from `createNonce`) through `exchangeCode`. All network calls go through a hardened `httpJson()` with timeouts, bounded retry, and Zod-validated response bodies.

## Authorization (RBAC / ABAC)

Policies are plain functions `(user, ctx) => boolean | Promise<boolean>`. Compose them with the combinators and role/permission helpers, then enforce them on a route with `requirePolicy`, which runs after `auth.guard` and throws core's `ForbiddenException` (403) on deny.

```ts
import {
  definePolicy,
  requireAll,
  requireAny,
  hasRole,
  hasAnyRole,
  hasPermission,
  requirePolicy,
} from "@nuraljs/auth";

const isAdmin = hasRole("admin");
const isStaff = hasAnyRole(["admin", "moderator", "support"]);
const canWrite = hasPermission("posts:write");

// ABAC — read the (unvalidated) route context for resource-owner checks
const isOwner = definePolicy((user, ctx) => user.id === ctx.params.userId);

const canEdit = definePolicy(requireAll(hasRole("admin"), canWrite));
const canView = requireAny(isAdmin, isOwner);

app.patch("/posts/:id", { middleware: [auth.guard, requirePolicy(canEdit)] }, handler);
```

By default the helpers read roles from `user.role` (string) or `user.roles` (string[]) and permissions from `user.permissions` (string[]). For a custom user shape, pass an optional `accessor` as the last argument:

```ts
// roles nested under a different field
const isManager = hasRole("manager", (u) => u.department.level);

// permissions on a `grants` array instead of `permissions`
const canDelete = hasPermission("users:delete", (u) => u.grants);
```

A missing or malformed claim surfaces a typed `PolicyDenied` and is treated as a deny (fail-closed) — distinct from a user who legitimately has zero roles.

## Requirements

- **Node.js ≥ 24**
- **Zod 4** (`zod@^4`, peer dependency)
- **`@nuraljs/core`** — the host framework `auth.guard` and `requirePolicy` plug into

## Ecosystem

Part of the [NuralJS](https://nuraljs.org) ecosystem:

| Package | Description |
| --- | --- |
| [`@nuraljs/core`](https://github.com/ErrorX407/nural) | Schema-first, Fastify-native REST framework |
| [`@nuraljs/cli`](https://github.com/ErrorX407/nural) | Project scaffolding & dev tooling (`nuraljs`) |
| [`@nuraljs/testing`](https://github.com/ErrorX407/nural) | Test harness — drive routes through the real adapter |
| **[`@nuraljs/auth`](https://github.com/ErrorX407/nural-auth)** | Functional auth: binary tokens, KMS, OAuth, RBAC/ABAC |
| [`@nuraljs/microservices`](https://github.com/ErrorX407/nural-microservices) | Contract-first RPC & message brokers |

## Documentation

Full documentation at **[nuraljs.org/docs](https://nuraljs.org/docs)**.

## License

[MIT](./LICENSE) © Chetan Joshi
