import * as crypto from "node:crypto";
import { z } from "zod";
import { httpJson } from "./http";

// ──────────────────────────────────────────────────────────────────────────
// OIDC id_token validation — JWKS fetch/cache + signature & claim checks.
//
// The old OIDC provider trusted the userinfo endpoint and never looked at the
// id_token. A conforming OIDC flow instead proves identity from the *signed*
// id_token: fetch the issuer's JWKS, verify the JWT signature against the key
// named by its `kid`, then validate `iss` / `aud` / `exp` / `nonce`. This
// module does exactly that, with a small TTL cache in front of the JWKS
// endpoint (keys rotate rarely; a per-exchange fetch would be wasteful and a
// soft DoS on the IdP).
//
// Only asymmetric algorithms are accepted (RS*/ES* + PS*). `none` and the HS*
// family are rejected outright: an HS* "verification" against a *public* JWKS
// key is the classic algorithm-confusion forgery.
// ──────────────────────────────────────────────────────────────────────────

const jwkSchema = z
  .object({
    kty: z.string(),
    kid: z.string().optional(),
    use: z.string().optional(),
    alg: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .passthrough();

const jwksSchema = z.object({ keys: z.array(jwkSchema) });
type Jwk = z.infer<typeof jwkSchema>;

/** Validated id_token claim set returned to the OIDC provider. */
export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  [claim: string]: unknown;
}

/** hash → { node digest name, EC signatures are IEEE-P1363, RSA-PSS needs padding }. */
const ALGORITHMS: Record<string, { hash: string; kty: "RSA" | "EC"; ec?: boolean; pss?: boolean }> = {
  RS256: { hash: "sha256", kty: "RSA" },
  RS384: { hash: "sha384", kty: "RSA" },
  RS512: { hash: "sha512", kty: "RSA" },
  PS256: { hash: "sha256", kty: "RSA", pss: true },
  PS384: { hash: "sha384", kty: "RSA", pss: true },
  PS512: { hash: "sha512", kty: "RSA", pss: true },
  ES256: { hash: "sha256", kty: "EC", ec: true },
  ES384: { hash: "sha384", kty: "EC", ec: true },
  ES512: { hash: "sha512", kty: "EC", ec: true },
};

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

export interface VerifyIdTokenParams {
  idToken: string;
  jwksUri: string;
  /** Expected `iss` — the discovery-document issuer. */
  issuer: string;
  /** Expected `aud` — the OIDC client id. */
  audience: string;
  /** Nonce originally issued; must equal the token `nonce` when provided. */
  expectedNonce?: string;
  /** Allowed clock skew in seconds for `exp`/`nbf`/`iat`. Default 60. */
  clockSkewSec?: number;
}

export interface JwksVerifier {
  verifyIdToken(params: VerifyIdTokenParams): Promise<IdTokenClaims>;
  /** Clears the cache — test/rotation aid. */
  clearCache(): void;
}

export interface JwksVerifierOptions {
  /** JWKS cache lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Per-request timeout for the JWKS fetch in ms. Default 10_000. */
  timeoutMs?: number;
}

interface CacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

/**
 * Creates a JWKS-backed id_token verifier with a shared TTL cache.
 *
 * Cache TTL defaults to 10 minutes. On a `kid` miss the cache is force-refreshed
 * once (to pick up a just-rotated signing key) before failing, but no more than
 * once per 30s per JWKS URI so a forged `kid` can't hammer the IdP.
 */
export function createJwksVerifier(options: JwksVerifierOptions = {}): JwksVerifier {
  const { ttlMs = 10 * 60_000, now = Date.now, timeoutMs = 10_000 } = options;
  const MIN_REFRESH_MS = 30_000;
  const cache = new Map<string, CacheEntry>();

  const fetchJwks = async (jwksUri: string): Promise<Jwk[]> => {
    const body = await httpJson(jwksUri, { method: "GET" }, jwksSchema, {
      timeoutMs,
      label: "OIDC JWKS fetch",
    });
    cache.set(jwksUri, { keys: body.keys, fetchedAt: now() });
    return body.keys;
  };

  const getKeys = async (jwksUri: string): Promise<Jwk[]> => {
    const entry = cache.get(jwksUri);
    if (entry && now() - entry.fetchedAt < ttlMs) return entry.keys;
    return fetchJwks(jwksUri);
  };

  const selectKey = async (jwksUri: string, header: JwtHeader, kty: string): Promise<Jwk> => {
    const match = (keys: Jwk[]): Jwk | undefined => {
      // Defense-in-depth: honour a key's declared usage/algorithm restrictions.
      // A key marked for encryption (`use: "enc"`) or pinned to a different `alg`
      // must not be used to verify this signature.
      const candidates = keys.filter(
        (k) =>
          k.kty === kty &&
          (!header.kid || k.kid === header.kid) &&
          (k.use === undefined || k.use === "sig") &&
          (k.alg === undefined || k.alg === header.alg),
      );
      // With a kid we require an exact match; without one, a lone key is unambiguous.
      if (header.kid) return candidates.find((k) => k.kid === header.kid);
      return candidates.length === 1 ? candidates[0] : undefined;
    };

    let keys = await getKeys(jwksUri);
    let key = match(keys);
    if (!key) {
      const entry = cache.get(jwksUri);
      if (!entry || now() - entry.fetchedAt >= MIN_REFRESH_MS) {
        keys = await fetchJwks(jwksUri);
        key = match(keys);
      }
    }
    if (!key) throw new Error("OIDC id_token validation failed: no matching JWKS key");
    return key;
  };

  const verifyIdToken = async (params: VerifyIdTokenParams): Promise<IdTokenClaims> => {
    const { idToken, jwksUri, issuer, audience, expectedNonce, clockSkewSec = 60 } = params;

    const parts = idToken.split(".");
    if (parts.length !== 3) throw new Error("OIDC id_token validation failed: malformed JWT");
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    let header: JwtHeader;
    let claims: IdTokenClaims;
    try {
      header = decodeSegment(headerB64) as JwtHeader;
      claims = decodeSegment(payloadB64) as IdTokenClaims;
    } catch {
      throw new Error("OIDC id_token validation failed: undecodable JWT segments");
    }

    const algo = ALGORITHMS[header.alg];
    if (!algo) throw new Error(`OIDC id_token validation failed: unsupported alg '${header.alg}'`);

    const jwk = await selectKey(jwksUri, header, algo.kty);
    const publicKey = crypto.createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(signatureB64, "base64url");

    const keyInput: crypto.VerifyKeyObjectInput = { key: publicKey };
    if (algo.ec) keyInput.dsaEncoding = "ieee-p1363";
    if (algo.pss) keyInput.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;

    if (!crypto.verify(algo.hash, signingInput, keyInput, signature)) {
      throw new Error("OIDC id_token validation failed: bad signature");
    }

    // ── Claims (only after the signature is proven) ──────────────────────
    if (claims.iss !== issuer) {
      throw new Error("OIDC id_token validation failed: issuer mismatch");
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) {
      throw new Error("OIDC id_token validation failed: audience mismatch");
    }
    if (typeof claims.exp !== "number") {
      throw new Error("OIDC id_token validation failed: missing exp");
    }
    const nowSec = Math.floor(now() / 1000);
    if (nowSec > claims.exp + clockSkewSec) {
      throw new Error("OIDC id_token validation failed: token expired");
    }
    if (typeof claims.nbf === "number" && nowSec + clockSkewSec < claims.nbf) {
      throw new Error("OIDC id_token validation failed: token not yet valid");
    }
    if (expectedNonce !== undefined && claims.nonce !== expectedNonce) {
      throw new Error("OIDC id_token validation failed: nonce mismatch");
    }

    return claims;
  };

  return { verifyIdToken, clearCache: () => cache.clear() };
}
