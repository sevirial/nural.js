// ──────────────────────────────────────────────────────────────────────────
// @nuraljs/auth — Token inspector (observability).
//
// A JWT is base64 — anyone can paste it into jwt.io and read every claim. That
// is the convenience *and* the flaw: the payload is public. A Nuraljs binary
// token is ChaCha20-Poly1305-encrypted, so an intercepted token leaks nothing —
// but that also means there is no "just decode it" story for debugging. This
// module is that missing story, done securely:
//
//   • `inspectTokenHeader(token)` — reads ONLY the public envelope (version,
//     key id, nonce, tag, sizes). No key, no claims. Always safe to run on a
//     token you don't own: it cannot reveal the payload, because the payload is
//     encrypted. This is the honest jwt.io equivalent.
//
//   • `decodeToken(token, { secret })` — for the operator who HOLDS the key:
//     derives the wire key exactly as the KMS layer does, AEAD-decrypts, and
//     returns the claims with the temporal claims pre-interpreted. Fully local
//     and synchronous — unlike pasting a token into a third-party website, the
//     token never leaves the process.
//
// Neither function ever returns, logs, or embeds key material or the raw secret.
// ──────────────────────────────────────────────────────────────────────────

import * as crypto from "node:crypto";
import { unpack } from "msgpackr";
import {
  ACCEPTED_VERSIONS,
  HEADER_LENGTH,
  parsePacket,
  TOKEN_ALGORITHM,
} from "./packet";
import { deriveKeyMaterial } from "../kms/derive";
import { TokenInvalidError } from "../errors";

/** ChaCha20-Poly1305 wire-key length, bytes. */
const KEY_LENGTH = 32;

/**
 * The public, key-free view of a token's envelope — everything observable
 * *without* the secret. There is deliberately no `claims` field here: the claims
 * live in the encrypted `ciphertext` and are unreadable without the key. That is
 * the security property, surfaced honestly rather than hidden.
 */
export interface TokenHeader {
  /** The wire-format version byte. */
  version: number;
  /** Whether the engine's `verify` would accept this version (per the accept-list). */
  versionAccepted: boolean;
  /** The KMS key id that signed the token — the field you need to debug rotation. */
  keyId: number;
  /** The 12-byte AEAD nonce, hex-encoded. Public by construction. */
  nonce: string;
  /** The 16-byte Poly1305 authentication tag, hex-encoded. */
  authTag: string;
  /** The AEAD algorithm the token is sealed with. */
  algorithm: typeof TOKEN_ALGORITHM;
  /** Length of the encrypted claims, bytes. */
  ciphertextBytes: number;
  /** Total decoded packet size, bytes. */
  totalBytes: number;
  /**
   * Always `true` — a marker that the payload is sealed, not merely encoded.
   * The contrast with a JWT (`encrypted: false` in spirit) is the whole point.
   */
  encrypted: true;
}

/** How the caller supplies the key to {@link decodeToken}. Exactly one is used. */
export interface DecodeTokenOptions {
  /**
   * The raw secret you handed the KMS provider (from `.env`/vault). The wire key
   * is derived from it via HKDF-SHA256, salted by the token's own key id — the
   * same derivation the engine uses — so no manual key handling is needed.
   */
  secret?: string | Buffer;
  /**
   * Alternatively, the already-derived 32-byte ChaCha20-Poly1305 wire key. Use
   * this only if you are managing derived keys yourself; `secret` is the norm.
   */
  key?: Buffer;
  /**
   * "Now", in epoch **seconds**, for interpreting the temporal claims. Defaults
   * to the wall clock. Exposed mainly so tests are deterministic.
   */
  nowSeconds?: number;
}

/** The temporal claims, pre-interpreted so a human doesn't decode epochs by hand. */
export interface TokenTemporal {
  /** `iat` — issued-at, epoch seconds. */
  issuedAt?: number;
  /** `exp` — expiry, epoch seconds. */
  expiresAt?: number;
  /** `nbf` — not-before, epoch seconds. */
  notBefore?: number;
  /** Seconds since `iat` (present only when `iat` is). Negative ⇒ clock skew. */
  ageSeconds?: number;
  /** Seconds until `exp` (present only when `exp` is). Negative ⇒ already expired. */
  expiresInSeconds?: number;
  /** `true` when `exp` is in the past. `undefined` when there is no `exp`. */
  expired?: boolean;
  /** `true` when `nbf` is still in the future. `undefined` when there is no `nbf`. */
  notYetValid?: boolean;
}

/** The full result of a successful {@link decodeToken}. */
export interface DecodedToken {
  /** The same public envelope {@link inspectTokenHeader} returns. */
  header: TokenHeader;
  /**
   * The decrypted claims — the authored payload plus the engine-stamped
   * `iat`/`exp`/`jti` (and any `nbf`/`iss`/`aud`). Reported verbatim; decoding
   * does **not** enforce expiry or bindings (that is `verify`'s job) — it
   * reports, so an expired or misbound token can still be examined.
   */
  claims: Record<string, unknown>;
  /** The temporal claims, interpreted relative to `nowSeconds`. */
  temporal: TokenTemporal;
}

/**
 * Decodes a token string to its raw packet buffer, enforcing the same length
 * bound the engine uses before touching attacker-controlled bytes.
 */
function toPacket(token: string): Buffer {
  if (typeof token !== "string" || token.length === 0) {
    throw new TokenInvalidError("Token inspect: empty or non-string token");
  }
  const packet = Buffer.from(token.trim(), "base64url");
  if (packet.length < HEADER_LENGTH) {
    throw new TokenInvalidError("Token inspect: token too short to be a Nuraljs token");
  }
  return packet;
}

/**
 * Reads the **public envelope** of a binary token — version, key id, nonce,
 * tag, and sizes — without any key. Safe to run on any token: it structurally
 * cannot reveal the claims, because they are encrypted.
 *
 * @throws {TokenInvalidError} if the string is not a well-formed packet.
 */
export function inspectTokenHeader(token: string): TokenHeader {
  const packet = toPacket(token);
  const parsed = parsePacket(packet);
  return {
    version: parsed.version,
    versionAccepted: ACCEPTED_VERSIONS.has(parsed.version),
    keyId: parsed.keyId,
    nonce: parsed.nonce.toString("hex"),
    authTag: parsed.authTag.toString("hex"),
    algorithm: TOKEN_ALGORITHM,
    ciphertextBytes: parsed.ciphertext.length,
    totalBytes: parsed.totalBytes,
    encrypted: true,
  };
}

/** Interprets the temporal claims of an already-decrypted payload. */
function interpretTemporal(
  claims: Record<string, unknown>,
  nowSeconds: number,
): TokenTemporal {
  const temporal: TokenTemporal = {};
  const iat = claims["iat"];
  const exp = claims["exp"];
  const nbf = claims["nbf"];

  if (typeof iat === "number") {
    temporal.issuedAt = iat;
    temporal.ageSeconds = nowSeconds - iat;
  }
  if (typeof exp === "number") {
    temporal.expiresAt = exp;
    temporal.expiresInSeconds = exp - nowSeconds;
    temporal.expired = nowSeconds >= exp;
  }
  if (typeof nbf === "number") {
    temporal.notBefore = nbf;
    temporal.notYetValid = nowSeconds < nbf;
  }
  return temporal;
}

/**
 * Decrypts and returns a token's claims, for a caller that holds the key.
 *
 * The wire key is either supplied directly (`key`) or derived from the raw
 * `secret` the same way the KMS layer does — HKDF-SHA256 salted by the token's
 * own key id — so the operator only needs the secret they already configured.
 * Everything runs locally and synchronously; the token is never transmitted.
 *
 * Unlike `verify`, this does **not** reject expired / not-yet-valid / misbound
 * tokens — it decrypts and *reports*, so those very conditions can be debugged.
 * The temporal claims come back interpreted (age, time-to-expiry, expired flag).
 *
 * @throws {TokenInvalidError} on a malformed packet, a missing key, a wrong key,
 *   or a tampered/corrupt token (AEAD failure). The message never distinguishes
 *   "wrong key" from "tampered" — both mean the same to a decrypting party, and
 *   collapsing them avoids a decryption oracle. No secret is ever included.
 */
export function decodeToken(token: string, options: DecodeTokenOptions): DecodedToken {
  const header = inspectTokenHeader(token);
  const packet = toPacket(token);
  const parsed = parsePacket(packet);

  // Resolve the wire key: an explicit derived key, or derive from the secret.
  let wireKey: Buffer;
  if (options.key) {
    if (options.key.length !== KEY_LENGTH) {
      throw new TokenInvalidError(
        `Token decode: wire key must be ${KEY_LENGTH} bytes, got ${options.key.length}`,
      );
    }
    wireKey = options.key;
  } else if (options.secret !== undefined && options.secret !== "") {
    wireKey = deriveKeyMaterial(options.secret, parsed.keyId);
  } else {
    throw new TokenInvalidError("Token decode: a `secret` or `key` is required");
  }

  let claims: Record<string, unknown>;
  try {
    const decipher = crypto.createDecipheriv(TOKEN_ALGORITHM, wireKey, parsed.nonce, {
      authTagLength: 16,
    });
    decipher.setAuthTag(parsed.authTag);
    const decrypted = Buffer.concat([
      decipher.update(parsed.ciphertext),
      decipher.final(),
    ]);
    const unpacked = unpack(decrypted) as unknown;
    if (unpacked === null || typeof unpacked !== "object" || Array.isArray(unpacked)) {
      // AEAD passed but the plaintext isn't a claims object — treat as corrupt
      // rather than returning a non-object payload to the caller.
      throw new TokenInvalidError("Token decode: payload is not a claims object");
    }
    claims = unpacked as Record<string, unknown>;
  } catch (err) {
    // Preserve our own typed error; collapse any crypto/unpack failure into the
    // single, oracle-free "wrong key or tampered" message.
    if (err instanceof TokenInvalidError) throw err;
    throw new TokenInvalidError(
      "Token decode: could not decrypt — wrong key or the token was tampered with",
    );
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  return { header, claims, temporal: interpretTemporal(claims, nowSeconds) };
}
