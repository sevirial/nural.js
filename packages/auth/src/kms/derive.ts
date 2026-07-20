import * as crypto from "node:crypto";

// ──────────────────────────────────────────────────────────────────
// Key derivation — HKDF-SHA256 at the provider boundary.
//
// Sprint 1 introduced HKDF inside the token engine (over the provider's
// SHA-256(secret) output). Sprint 2 (T2.1) moves that single derivation here,
// into the KMS layer, so providers hand the engine a ready-to-use AEAD key and
// the engine no longer knows about key derivation.
//
// The composition is unchanged, so previously-signed tokens still decrypt:
//   wireKey = HKDF-SHA256( SHA-256(secret), salt = BE32(keyId), info, L=32 )
// Do NOT change these params — the engine uses `key.secret` verbatim as the
// ChaCha20-Poly1305 key, and tokens minted under the old params would fail AEAD.
// ──────────────────────────────────────────────────────────────────

/** HKDF `info` label — domain-separates this key usage from any other. */
const HKDF_INFO = Buffer.from("nuraljs-auth-token");
/** ChaCha20-Poly1305 key length. */
const KEY_LENGTH = 32;

/**
 * Derives the 32-byte ChaCha20-Poly1305 wire key from a provider secret.
 *
 * The secret is first hashed to fixed-length IKM (SHA-256), then run through
 * HKDF-SHA256 salted with the 4-byte big-endian key id. The salt binds each
 * derived key to its id, so two keys sharing a secret string still differ.
 *
 * @param secret Raw secret material (string from `.env`/vault, or bytes).
 * @param keyId  The key id (0…2³²-1); becomes the HKDF salt.
 */
export function deriveKeyMaterial(secret: string | Buffer, keyId: number): Buffer {
  const ikm = crypto.createHash("sha256").update(secret).digest();
  const salt = Buffer.alloc(4);
  salt.writeUInt32BE(keyId, 0);
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, HKDF_INFO, KEY_LENGTH));
}
