import * as crypto from "node:crypto";
import { InvalidStateError, OAuthExchangeError } from "../errors";

// ──────────────────────────────────────────────────────────────────────────
// OAuth anti-CSRF (`state`), replay (`nonce`), and PKCE (RFC 7636) helpers.
//
// The providers are stateless closures, so the *caller* owns the ephemeral
// per-authorization secrets: it generates a `state` (+ optional `nonce`) and a
// PKCE pair before redirecting, stashes `{ state, codeVerifier, nonce }` in the
// user's session/cookie, and hands them back to `exchangeCode` on the callback.
// These helpers produce those values; `verifyState` performs the constant-time
// comparison the provider runs before it will trade the code.
// ──────────────────────────────────────────────────────────────────────────

/** base64url with no padding — the encoding OAuth/PKCE use throughout. */
function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** An opaque, high-entropy anti-CSRF `state` value (256 bits, base64url). */
export function createState(): string {
  return base64url(crypto.randomBytes(32));
}

/** An opaque OIDC `nonce` (256 bits, base64url) bound into the id_token. */
export function createNonce(): string {
  return base64url(crypto.randomBytes(32));
}

export interface PkcePair {
  /** Secret held by the caller; sent to the token endpoint on exchange. */
  codeVerifier: string;
  /** S256 hash of the verifier; sent to the authorize endpoint. */
  codeChallenge: string;
  /** Always "S256" — the only method these providers issue. */
  codeChallengeMethod: "S256";
}

/**
 * Generates a PKCE verifier/challenge pair (S256).
 *
 * The verifier is 32 random bytes base64url-encoded (43 chars — within the
 * RFC 7636 43–128 range); the challenge is `base64url(SHA-256(verifier))`.
 */
export function createPkcePair(): PkcePair {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

/**
 * Verifies the `state` returned on the OAuth callback against the one issued
 * before the redirect. Throws on a missing or mismatched value — the caller
 * must abort the exchange (CSRF / mix-up defence). Uses a length-guarded
 * constant-time compare so a mismatch leaks no timing signal.
 */
export function verifyState(returned: string | undefined, expected: string | undefined): void {
  if (!expected)
    throw new InvalidStateError("OAuth state verification failed: no expected state was issued");
  if (!returned)
    throw new InvalidStateError("OAuth state verification failed: callback returned no state");
  const a = Buffer.from(returned);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new InvalidStateError("OAuth state verification failed: state mismatch");
  }
}

/** Guards that a PKCE verifier was supplied to `exchangeCode`. */
export function requireCodeVerifier(codeVerifier: string | undefined): string {
  if (!codeVerifier) {
    throw new OAuthExchangeError("PKCE code verifier is required for token exchange");
  }
  return codeVerifier;
}
