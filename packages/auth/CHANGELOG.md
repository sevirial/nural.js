# @nuraljs/auth

## 0.6.2

### Patch Changes

- Updated dependencies
  - @nuraljs/core@1.1.0

## 0.6.1

### Patch Changes

- Updated dependencies [669dd05]
  - @nuraljs/core@1.0.1

## 0.6.0

### Minor Changes

- **Aligned with `@nuraljs/core@^1.0.0`.** Version bumped to 0.6.0; the package stays pre-1.0 while its public API settles ahead of a final security review.

## 0.5.0

### Minor Changes

- **Deprecate KMS secrets shorter than 32 characters (security — audit finding L5).**

  Every KMS provider seeds a 256-bit ChaCha20-Poly1305 key from your secret via HKDF-SHA256. HKDF spreads whatever entropy the secret has across the full key, but it cannot create entropy that was never there — so a 16-character secret is a weak floor for a 256-bit key.

  **Warn-then-enforce, so nothing breaks on this upgrade.** The hard reject stays at **16** characters for this release; a secret of **16–31** characters still works but now emits a one-time deprecation warning; **32+** is silent and recommended. The hard floor rises to 32 in the **next major** — treat this release as the window to rotate. Applies consistently to `createStaticKeyProvider`, every `secret` in `createLocalKeyProvider`, and every vault `value` in `createCloudKeyProvider`.

  The warning fires **once per provider** — including the cloud provider, which re-validates its vault response on every poll — and reaches you as a Node `DeprecationWarning` (code `NURALJS_AUTH_SHORT_SECRET`) for static/local, or through your configured `logger` for cloud. It names only the length category and the affected key ids, never any secret bytes, so it is safe to leave on in production.

  Rotating a secret changes the derived key and invalidates tokens signed with the old one, so roll it as a real key rotation (`createLocalKeyProvider` with the new key primary and the old one verifying, or a new vault version covered by `overlapWindowMs`) rather than swapping the secret in place. New exports: `MIN_SECRET_LENGTH_HARD` (16), `SECRET_LENGTH_RECOMMENDED` (32), `SHORT_SECRET_WARNING_CODE`. See MIGRATION.md.

### Patch Changes

- Updated dependencies
  - @nuraljs/core@0.5.1

## 0.4.0

### Minor Changes

- **Bound token length before decoding (defense-in-depth — audit finding L4).** `createBinaryTokenEngine` now accepts `maxTokenBytes` (default **8192**, 8 KiB, exported as `DEFAULT_MAX_TOKEN_BYTES`). `verify()` checks the token's byte length before `Buffer.from(token, "base64url")` and `unpack`, rejecting an over-length string with `TokenInvalidError` ("Token too long").

  `unpack` only ever runs on AEAD-authenticated plaintext, so this was never an unsafe-deserialization path — the bound simply stops an unauthenticated caller from making the engine decode a multi-megabyte string to discover it's garbage. A real claims token is a few hundred bytes, so the default rejects only absurd input. Set `maxTokenBytes: 0` to disable.

  Additive and non-breaking.

## 0.3.0

### Minor Changes

- **Rebrand to the `@nuraljs/core` dependency + rename auth's own symbols (breaking).** The core dependency moves `nural` → `@nuraljs/core` and all `from "nural"` imports become `from "@nuraljs/core"`. Auth's own exported symbols are rebranded: `NuralAuth` → `NuraljsAuth`, `NuralAuthKey` → `NuraljsAuthKey`, `NuralBinaryToken` → `NuraljsBinaryToken`.

  **What to do.** Install `@nuraljs/core@^0.5.0` in place of `nural`, update imports `from "nural"` → `from "@nuraljs/core"`, and rename any use of `NuralAuth` / `NuralAuthKey` / `NuralBinaryToken` to the `Nuraljs*` forms. No behavior changes — this is a pure rename/port; see MIGRATION.md.

### Patch Changes

- Updated dependencies
  - @nuraljs/core@0.5.0

## 0.2.0

### Minor Changes

- Depend on the core by its real name **`nural`** (`^0.4.0`) instead of `@nuraljs/core`, and migrate the peer dependency to **Zod 4** (`^4`). The Nural guard is rebuilt on core's `defineMiddleware` (the previously-imported `defineGuard`/`GuardHandler` never existed in core); the authenticated payload is exposed at `ctx.user`. **Breaking:** update imports from `@nuraljs/core` → `nural`, upgrade to Zod 4, and use `auth.guard`. See MIGRATION.md.
- HKDF derivation moved to the KMS provider boundary: `NuraljsAuthKey.secret` now holds the **final 32-byte AEAD key**, not `SHA-256(secret)`. The built-in static/local/cloud providers handle this; the cloud provider also gains backoff/retry, single-flight refresh, atomic cache swap, `dispose()`, and a rotation overlap window. **Breaking for custom `KeyProvider`s:** return 32 bytes of real key material (`deriveKeyMaterial`) — the engine no longer KDFs it. See MIGRATION.md.
- OAuth/OIDC hardening. `AuthProvider` methods take object params and enforce anti-CSRF **`state`** + **PKCE (S256)**: `getAuthUrl({ state, codeChallenge, nonce? })` and `exchangeCode({ code, state, expectedState, codeVerifier, expectedNonce? })`. OIDC validates the `id_token` (JWKS signature, `iss`/`aud`/`exp`/`nonce`); all `fetch`es are hardened (timeout, retry, `.ok`, Zod-validated bodies). **Breaking:** migrate call sites to the object-param + state/PKCE flow. See MIGRATION.md.
- Refresh-token session hardening. `SessionStore` and `MinimalRedisClient` interfaces changed; refresh tokens are **hashed at rest**, rotation is **atomic** (Lua/MULTI), set members expire with the token TTL, and replay of a rotated token triggers **token-family revocation** + a `RefreshTokenReuseError`/`onReuse` audit event. **Breaking:** `0.1.0` session records are incompatible (flush the store; users re-login); custom `SessionStore`s must implement the new interface. See MIGRATION.md.
- Token engine crypto hardening. The AEAD key is now **HKDF-SHA256-derived** (not a bare `SHA-256(secret)`), and **`exp` is mandatory** (no never-expiring tokens); added `iat`/`nbf`/`iss`/`aud`/`jti` claims and a pluggable `isRevoked(jti)` hook. The packet layout and version byte (`0x02`) are unchanged, but tokens are **cryptographically incompatible** with `0.1.0` (old tokens fail AEAD). **Breaking:** set `expiresInSeconds`; treat `0.1.0` tokens as invalid (force re-auth). See MIGRATION.md.

### Patch Changes

- Additive (non-breaking): typed error taxonomy extending core `HttpException` (+ `isAuthError`); observability (`createAuditor` secret-free audit lines, `AuthMetrics` counters, `enforceRateLimit` hooks — no-op by default); RBAC/ABAC policy engine + `requirePolicy` guard with explicit `PolicyDenied`; per-factory config validation with a typed `AuthConfigError`.
