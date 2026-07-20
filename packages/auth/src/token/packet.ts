// ──────────────────────────────────────────────────────────────────
// Wire format — the single source of truth for the binary token packet.
//
// Both the token engine (`binary-token-engine.ts`, which mints and verifies)
// and the inspector (`inspect.ts`, which observes) parse this same envelope.
// Keeping the version byte, offsets, and header length here — rather than
// duplicated in each — means the two can never drift, which for a security
// wire format is the difference between a bug and a vulnerability.
//
// Packet layout: `[1B Version][4B KeyID][12B Nonce][16B AuthTag][XB Ciphertext]`
// ──────────────────────────────────────────────────────────────────

/** The version byte written by `sign`. */
export const TOKEN_VERSION = 0x02;

/**
 * Versions `verify` will accept. Formalized as an accept-list so a future
 * format can be introduced (bump `TOKEN_VERSION`, add the new byte here, keep
 * the old one during the migration window) without a flag-day cutover.
 * Reserved: `0x03`+ for the next packet/claim revision.
 */
export const ACCEPTED_VERSIONS: ReadonlySet<number> = new Set([TOKEN_VERSION]);

/** The AEAD in use — surfaced by the inspector; the engine hard-codes it. */
export const TOKEN_ALGORITHM = "chacha20-poly1305" as const;

// Fixed-width field offsets into the packet buffer.
export const KEY_ID_OFFSET = 1; // 4B, big-endian
export const NONCE_OFFSET = 5; // 12B
export const TAG_OFFSET = 17; // 16B
export const CIPHERTEXT_OFFSET = 33;

/** Bytes before the ciphertext: version + key id + nonce + tag. */
export const HEADER_LENGTH = CIPHERTEXT_OFFSET; // 33

/**
 * The public, key-free envelope of a token — everything readable *without* the
 * secret. Deliberately excludes the claims: those live in the encrypted
 * ciphertext and cannot be recovered without the key.
 */
export interface ParsedPacket {
  version: number;
  keyId: number;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
  totalBytes: number;
}

/**
 * Slices a decoded packet buffer into its fixed-width fields. Does **not**
 * validate the version or touch the key — it is pure structural parsing shared
 * by the engine's verify path and the inspector.
 *
 * @throws {RangeError} if the buffer is shorter than {@link HEADER_LENGTH}.
 *   Callers translate this into their own typed error (the engine's
 *   `TokenInvalidError`, the inspector's).
 */
export function parsePacket(packet: Buffer): ParsedPacket {
  if (packet.length < HEADER_LENGTH) {
    throw new RangeError("packet shorter than header");
  }
  return {
    version: packet.readUInt8(0),
    keyId: packet.readUInt32BE(KEY_ID_OFFSET),
    nonce: packet.subarray(NONCE_OFFSET, TAG_OFFSET),
    authTag: packet.subarray(TAG_OFFSET, CIPHERTEXT_OFFSET),
    ciphertext: packet.subarray(CIPHERTEXT_OFFSET),
    totalBytes: packet.length,
  };
}
