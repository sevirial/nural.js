# Migration Guide — `@nuraljs/auth`

## 0.4.0 → 0.5.0

**No breaking change in this release — but one is scheduled.** Every KMS provider now warns when a secret is shorter than **32 characters**. Nothing is rejected that `0.4.0` accepted: the hard floor stays at 16 for this release and rises to 32 in the **next major**. This is your window to rotate.

### Why

Your secret seeds a 256-bit ChaCha20-Poly1305 key. HKDF-SHA256 spreads its entropy across the whole key but cannot create entropy that isn't there, so a 16-character secret is a weak floor for a 256-bit key (security audit finding **L5**). Raising the floor outright would have failed a running app at boot on a point upgrade — hence warn now, enforce next major.

| Secret length | `0.4.0` | `0.5.0` | Next major |
|---|---|---|---|
| ≥ 32 | ✅ | ✅ | ✅ |
| 16–31 | ✅ silent | ⚠️ **works, warns once** | ❌ rejected |
| < 16 | ❌ | ❌ | ❌ |

Applies to `createStaticKeyProvider(secret)`, every `secret` in `createLocalKeyProvider`, and every `value` returned by a `createCloudKeyProvider` `fetchSecrets()`.

### What to do

If you see `DeprecationWarning: … shorter than 32 characters` (code `NURALJS_AUTH_SHORT_SECRET`), or the equivalent `Cloud KMS` line through your logger, rotate to a secret of at least 32 characters:

```bash
openssl rand -base64 32
```

**Rotate, don't just swap.** Changing a secret changes the derived key, so tokens signed with the old one stop verifying — swapping `AUTH_SECRET` in place logs out every active session. Roll it as a real key rotation instead:

```ts
// Serve the new key as primary while the old one still verifies…
createLocalKeyProvider([
  { id: 2, secret: process.env.AUTH_KEY_CURRENT! }, // new, >= 32 chars — signs
  { id: 1, secret: process.env.AUTH_KEY_PREVIOUS! }, // old — verifies only
]);
// …then drop id 1 once outstanding tokens have expired.
```

On the cloud provider, publish the new version to your vault and let `overlapWindowMs` cover the old one. If a brief mass logout is acceptable (say, a low-traffic internal tool), swapping the static secret directly is fine.

The warning fires **once per provider** and names only the length category plus the affected key ids — never any secret bytes — so it is safe to leave on in production. `MIN_SECRET_LENGTH_HARD` (16) and `SECRET_LENGTH_RECOMMENDED` (32) are exported if you want to assert on them in your own config validation.

---

## 0.3.0 → 0.4.0

**Additive and non-breaking.** `createBinaryTokenEngine` gained `maxTokenBytes` (default `8192`, 8 KiB): `verify()` now rejects a token longer than that with `TokenInvalidError` before decoding it. No crypto, wire-format, or claim changes — tokens issued by `0.3.0` verify unchanged on `0.4.0`.

**What to do.** Nothing. A claims token is normally a few hundred bytes, so the default only rejects absurd input. If you pack unusually large claims, raise `maxTokenBytes` or set it to `0` to disable the bound.

---

## 0.2.0 → 0.3.0

A **pure rename/port** as the ecosystem unified under the `@nuraljs/*` family. No behavior, crypto, or wire changes — only identifiers moved. It is a **breaking republish** (dependency name + exported symbols changed), hence the minor bump.

### 1. Core dependency renamed: `nural` → `@nuraljs/core`

**What changed.** The core, previously published as `nural`, is now `@nuraljs/core` (`^0.5.0`), shipped from the unified monorepo. Every `from "nural"` import in this package now resolves through `@nuraljs/core`.

**What to do.**
- Replace `nural` with `@nuraljs/core@^0.5.0` in your dependencies.
- Update any `import … from "nural"` → `import … from "@nuraljs/core"`.

### 2. Auth's own symbols rebranded: `Nural*` → `Nuraljs*`

**What changed.** The exported identifiers `NuralAuth`, `NuralAuthKey`, and `NuralBinaryToken` are renamed to `NuraljsAuth`, `NuraljsAuthKey`, and `NuraljsBinaryToken`. (The `NuraljsAuthKey.secret` semantics from `0.2.0` are unchanged — see §5 below.)

**What to do.** Rename any references to these types/values to their `Nuraljs*` forms. The runtime behavior is identical.

---

## 0.1.0 → 0.2.0

This release hardens the `0.1.0` prototype into an enterprise-grade toolkit. It contains **breaking changes** across crypto, key management, sessions, and OAuth. They are grouped below with a *what changed → what to do*. Because `0.1.0` had **no persisted-token or store-shape compatibility contract**, there is no on-the-wire upgrade path for tokens/sessions minted by `0.1.0` — plan a credential/session reset (see "Rollout").

Every change here maps to a hardening sprint; the reasoning lives in each item.

---

### 1. Core dependency renamed: `@nuraljs/core` → `nural`

**What changed.** The package now depends on the core by its real published name, **`nural`** (`^0.4.0`), not `@nuraljs/core` (which never existed on the registry). The old guard imports (`defineGuard`, `GuardHandler`) never existed in core and are gone.

**What to do.**
- Ensure `nural@^0.4.0` is installed.
- If you imported anything from `@nuraljs/core`, import from `nural` instead.
- Use `auth.guard` (below) — there is no `defineGuard`.

### 2. Zod 3 → Zod 4 (peer dependency)

**What changed.** `peerDependencies.zod` is now `^4.0.0`.

**What to do.** Upgrade your app to **Zod 4**. The surface used here (`.parse`, `z.infer`, `ZodTypeAny`) is unchanged, but Zod 4 is a distinct major — follow [Zod's own 3→4 guide](https://zod.dev). Schemas you pass to `createAuth({ strategy: { schema } })` must be Zod 4 schemas.

### 3. Guard API — built on core `defineMiddleware`, user at `ctx.user`

**What changed.** The NuralJS guard is now a `defineMiddleware` handler that runs on `preValidation` and returns `{ user }`, which core merges onto the route context. A bad token is **401 before body validation**.

**Before → after.**
```ts
// before (never actually compiled against core):
import { defineGuard } from "@nuraljs/core";

// after:
const auth = createAuth({ strategy: { schema, keyProvider, expiresInSeconds } });
app.get("/me", { middleware: [auth.guard] }, (ctx) => ctx.user); // typed
```

### 4. Token engine — HKDF keying + mandatory `exp` (cryptographically breaking)

**What changed.**
- The AEAD key is now **HKDF-SHA256-derived** from the KMS secret, not a bare `SHA-256(secret)`. The binary packet layout is unchanged (`[1B ver][4B keyId][12B nonce][16B tag][ct]`) and the version byte is still `0x02`, **but tokens minted by `0.1.0` (bare-hash key) fail AEAD verification under `0.2.0` and vice-versa.**
- **`exp` is now mandatory.** A token without `exp` is rejected (there was previously a never-expiring path). New claims `iat`, optional `nbf`/`iss`/`aud`, a `jti`, and an optional `isRevoked(jti)` revocation hook were added.

**What to do.**
- Set `expiresInSeconds` (or an explicit `exp`) — a missing expiry now throws.
- Treat all `0.1.0` access tokens as invalid on upgrade (they won't decrypt). Since access tokens are short-lived, the simplest rollout is to let them expire / force re-auth.
- Optionally configure `clockToleranceSeconds`, `issuer`, `audience`, and `isRevoked`.

### 5. KMS — `NuraljsAuthKey.secret` is now the final 32-byte AEAD key

**What changed.** HKDF derivation moved to the **provider boundary**. `NuraljsAuthKey.secret` now means "the final 32-byte AEAD key", not "SHA-256(secret)". The built-in static/local/cloud providers handle this for you.

**What to do.** If you wrote a **custom `KeyProvider`**, it must now return **32 bytes of real key material** — call `deriveKeyMaterial(secret, keyId)` (exported path `kms/derive`) or supply 32 random bytes. The engine no longer KDFs the provider's output.

### 6. Sessions — store shape changed, refresh tokens hashed, reuse detection

**What changed.** `SessionStore` and `MinimalRedisClient` interfaces changed. Refresh tokens are now **hashed at rest** (`sha256(token)`; the plaintext is never stored), rotation is **atomic** (Lua/MULTI), set members expire with the token TTL, and replaying a rotated token triggers **token-family revocation** + a `RefreshTokenReuseError` / `onReuse` audit event.

**What to do.**
- Existing `0.1.0` session records (plaintext tokens, old shape) are **not compatible** — flush the session store on upgrade (users re-login).
- If you wrote a **custom `SessionStore`**, implement the new interface (`issue`/`rotate`/`verify`/`revoke` with the hashed-token + family/`RotateResult` semantics — see `session/types.ts`).
- `createSessionManager(auth, store, options)` accepts an options object; the old bare-number 3rd arg (`refreshTtlSeconds`) still works for back-compat.

### 7. OAuth/OIDC — `state` + PKCE now required; provider signatures changed

**What changed.** `AuthProvider` methods take **object params** and enforce anti-CSRF `state` + PKCE:
- `getAuthUrl(state?)` → `getAuthUrl({ state, codeChallenge, nonce? })` — `state` and `codeChallenge` are **required**.
- `exchangeCode(code)` → `exchangeCode({ code, state, expectedState, codeVerifier, expectedNonce? })` — `codeVerifier` is **required** (throws otherwise); `state` is verified against `expectedState`.
- OIDC additionally validates the `id_token` (JWKS signature, `iss`/`aud`/`exp`/`nonce`). All `fetch`es go through a hardened `httpJson()` (timeout, retry, `.ok`, Zod-validated bodies) and no longer coerce missing identity fields to `""`.

**Before → after.**
```ts
// before:
const url = provider.getAuthUrl(state);
const profile = await provider.exchangeCode(code);

// after:
import { createState, createPkcePair } from "@nuraljs/auth";
const state = createState();
const { codeVerifier, codeChallenge } = createPkcePair();
// persist { state, codeVerifier } in the user's session, then:
const url = provider.getAuthUrl({ state, codeChallenge });
// on callback:
const profile = await provider.exchangeCode({ code, state: cbState, expectedState: state, codeVerifier });
```

---

## Additive (non-breaking) in this release

- **Typed error taxonomy** extending core `HttpException` (`TokenExpiredError`, `TokenRevokedError`, `InvalidStateError`, `OAuthExchangeError`, `AuthConfigError`, `RateLimitError`, …) + `isAuthError`.
- **Observability**: `createAuditor` (secret-free audit lines), `AuthMetrics` counters, `enforceRateLimit` hooks — all no-op by default.
- **Policy engine + `requirePolicy` guard** (RBAC/ABAC) with explicit `PolicyDenied` (a malformed role/permission claim now denies *explicitly* rather than silently — same deny outcome, so no working route breaks).
- **Config validation**: every `createX` validates its config with a typed `AuthConfigError`.

## Rollout checklist

1. Upgrade the app to **Zod 4** and install **`nural@^0.4.0`**.
2. Replace any `@nuraljs/core` / `defineGuard` imports; use `auth.guard`.
3. Set `expiresInSeconds` on your strategy.
4. Update custom `KeyProvider`s (return 32-byte derived material) and custom `SessionStore`s (new interface).
5. Migrate OAuth call sites to the object-param + `state`/PKCE flow.
6. **Reset credentials/sessions**: `0.1.0` tokens won't decrypt and old session records are incompatible — force re-auth / flush the session store.
