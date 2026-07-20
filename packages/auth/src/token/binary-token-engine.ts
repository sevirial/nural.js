import * as crypto from "node:crypto";
import { pack, unpack } from "msgpackr";
import type { z } from "zod";
import type { KeyProvider } from "../kms/types";
import {
  ACCEPTED_VERSIONS,
  CIPHERTEXT_OFFSET,
  HEADER_LENGTH,
  KEY_ID_OFFSET,
  NONCE_OFFSET,
  TAG_OFFSET,
  TOKEN_VERSION,
} from "./packet";
import {
  TokenExpiredError,
  TokenInvalidError,
  TokenNotYetValidError,
  TokenRevokedError,
} from "../errors";

export interface BinaryTokenEngineOptions<T extends z.ZodTypeAny> {
  schema: T;
  keyProvider: KeyProvider;
  /** Lifetime of a signed token, in seconds (drives the mandatory `exp`). Default 300. */
  expiresInSeconds?: number;
  /**
   * Clock-skew tolerance (seconds) applied to `exp`/`nbf` checks on `verify`,
   * to forgive small drift between the signer's and verifier's clocks. Default 0.
   */
  clockToleranceSeconds?: number;
  /**
   * Seconds until a signed token becomes valid. When > 0, `sign` stamps an
   * `nbf` claim and `verify` rejects the token before that time. Default 0 (no `nbf`).
   */
  notBeforeSeconds?: number;
  /** When set, `sign` stamps `iss` and `verify` requires a matching issuer. */
  issuer?: string;
  /** When set, `sign` stamps `aud` and `verify` requires a matching audience. */
  audience?: string;
  /**
   * Pluggable revocation check. When provided, `verify` calls it with the token's
   * `jti` and rejects the token if it resolves truthy. Fails closed: a token with
   * no `jti` is rejected when this hook is configured.
   */
  isRevoked?: (jti: string) => boolean | Promise<boolean>;
  /**
   * Maximum accepted length of a token string, bytes. Checked before the token is
   * base64url-decoded or unpacked, so an absurdly long string is rejected without
   * allocating its decoded form. Default {@link DEFAULT_MAX_TOKEN_BYTES} (8 KiB) —
   * generous for a claims token, which is normally a few hundred bytes. Set `0`
   * to disable.
   */
  maxTokenBytes?: number;
}

/** Default cap on an inbound token string, bytes (8 KiB). Generous; `0` disables. */
export const DEFAULT_MAX_TOKEN_BYTES = 8192;

// ──────────────────────────────────────────────────────────────────
// Wire format — the versioned packet layout, offsets, and accept-list live in
// `./packet` so the engine and the inspector share one definition.
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
// Key material — HKDF-SHA256 is applied at the KMS provider boundary
// (`kms/derive.ts`), so `key.secret` is already the final 32-byte AEAD key.
// The engine uses it verbatim; it no longer derives keys itself.
// ──────────────────────────────────────────────────────────────────

/**
 * Creates a zero-overhead binary token engine using ChaCha20-Poly1305 + MessagePack.
 *
 * Tokens are compact, encrypted, and schema-validated via Zod. The wire key is
 * the HKDF-SHA256-derived key supplied by the KMS provider, and every token
 * carries a mandatory `exp` plus `iat`/`jti` (and optional `nbf`/`iss`/`aud`).
 *
 * Packet layout: `[1B Version][4B KeyID][12B Nonce][16B AuthTag][XB Ciphertext]`
 */
export function createBinaryTokenEngine<T extends z.ZodTypeAny>(
  options: BinaryTokenEngineOptions<T>
) {
  const {
    schema,
    keyProvider,
    expiresInSeconds = 300,
    clockToleranceSeconds = 0,
    notBeforeSeconds = 0,
    issuer,
    audience,
    isRevoked,
    maxTokenBytes = DEFAULT_MAX_TOKEN_BYTES,
  } = options;

  return {
    /**
     * Signs a payload into an encrypted binary token (base64url).
     * The payload is validated against the Zod schema before encryption, then
     * stamped with `iat`, a mandatory `exp`, a `jti`, and any configured
     * `nbf`/`iss`/`aud` claims.
     */
    sign: async (payload: z.infer<T>): Promise<string> => {
      // Zod 4 narrows `.parse()` on a generic schema to `unknown` (was `any` in
      // Zod 3); the payload is an object by contract, so assert it as one to spread.
      const validData = schema.parse(payload) as Record<string, unknown>;
      const primaryKey = await keyProvider.getPrimaryKey();
      const encryptionKey = primaryKey.secret;

      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        ...validData,
        iat: now,
        exp: now + expiresInSeconds,
        jti: crypto.randomUUID(),
      };
      if (notBeforeSeconds > 0) claims["nbf"] = now + notBeforeSeconds;
      if (issuer !== undefined) claims["iss"] = issuer;
      if (audience !== undefined) claims["aud"] = audience;

      const binaryPayload = pack(claims);

      // ChaCha20-Poly1305 requires a 12-byte nonce
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("chacha20-poly1305", encryptionKey, nonce, {
        authTagLength: 16,
      });

      const ciphertext = Buffer.concat([cipher.update(binaryPayload), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // Packet: [1B Version][4B KeyID][12B Nonce][16B Tag][XB Ciphertext]
      const packet = Buffer.alloc(HEADER_LENGTH + ciphertext.length);
      packet.writeUInt8(TOKEN_VERSION, 0);
      packet.writeUInt32BE(primaryKey.id, KEY_ID_OFFSET);
      nonce.copy(packet, NONCE_OFFSET);
      authTag.copy(packet, TAG_OFFSET);
      ciphertext.copy(packet, CIPHERTEXT_OFFSET);

      return packet.toString("base64url");
    },

    /**
     * Verifies and decrypts a binary token, returning the typed payload.
     * Checks version (accept-list), key ID, AEAD integrity, then the temporal
     * and binding claims (`exp` mandatory, `nbf`/`iss`/`aud`/revocation).
     */
    verify: async (token: string): Promise<z.infer<T>> => {
      // Bound the input before decoding it: `unpack` only ever sees AEAD-authenticated
      // bytes, but decoding a multi-megabyte string to find that out is wasted work an
      // unauthenticated caller shouldn't be able to force (audit L4).
      if (maxTokenBytes > 0 && Buffer.byteLength(token, "utf8") > maxTokenBytes) {
        throw new TokenInvalidError("NuraljsBinaryToken: Token too long");
      }
      const packet = Buffer.from(token, "base64url");
      if (packet.length < HEADER_LENGTH) {
        throw new TokenInvalidError("NuraljsBinaryToken: Token too short");
      }
      if (!ACCEPTED_VERSIONS.has(packet.readUInt8(0))) {
        throw new TokenInvalidError("NuraljsBinaryToken: Unsupported version");
      }

      const keyId = packet.readUInt32BE(KEY_ID_OFFSET);
      const key = await keyProvider.getKey(keyId);
      if (!key) {
        throw new TokenInvalidError(`NuraljsBinaryToken: Unknown Key ID (${keyId})`);
      }

      const nonce = packet.subarray(NONCE_OFFSET, TAG_OFFSET);
      const authTag = packet.subarray(TAG_OFFSET, CIPHERTEXT_OFFSET);
      const ciphertext = packet.subarray(CIPHERTEXT_OFFSET);

      // AEAD decrypt — any failure here means a tampered/corrupt/forged token.
      // Kept in its own try so a genuine claim-validation error below is not
      // masked by the generic "invalid signature" message.
      let payload: Record<string, unknown>;
      try {
        const decipher = crypto.createDecipheriv("chacha20-poly1305", key.secret, nonce, {
          authTagLength: 16,
        });
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        payload = unpack(decrypted) as Record<string, unknown>;
      } catch {
        throw new TokenInvalidError(
          "NuraljsBinaryToken: Invalid signature or corrupted token",
        );
      }

      // Claim validation runs only on authentic (AEAD-verified) payloads.
      const now = Math.floor(Date.now() / 1000);

      // `exp` is mandatory: a token without it must never be treated as
      // non-expiring. (Prior behavior silently accepted a missing `exp`.)
      const exp = payload["exp"];
      if (typeof exp !== "number") {
        throw new TokenInvalidError("NuraljsBinaryToken: Missing expiration claim");
      }
      if (now >= exp + clockToleranceSeconds) {
        throw new TokenExpiredError("NuraljsBinaryToken: Token expired");
      }

      // `nbf` (optional): reject if the token is not yet valid.
      const nbf = payload["nbf"];
      if (typeof nbf === "number" && now + clockToleranceSeconds < nbf) {
        throw new TokenNotYetValidError("NuraljsBinaryToken: Token not yet valid");
      }

      // `iss`/`aud` bindings: enforced only when the engine is configured for them.
      if (issuer !== undefined && payload["iss"] !== issuer) {
        throw new TokenInvalidError("NuraljsBinaryToken: Issuer mismatch");
      }
      if (audience !== undefined) {
        const aud = payload["aud"];
        const matches = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
        if (!matches) {
          throw new TokenInvalidError("NuraljsBinaryToken: Audience mismatch");
        }
      }

      // Revocation: fail closed — a missing `jti` is a rejection when a hook is set.
      if (isRevoked) {
        const jti = payload["jti"];
        if (typeof jti !== "string") {
          throw new TokenInvalidError("NuraljsBinaryToken: Missing token id");
        }
        if (await isRevoked(jti)) {
          throw new TokenRevokedError("NuraljsBinaryToken: Token revoked");
        }
      }

      return schema.parse(payload) as z.infer<T>;
    },
  };
}
