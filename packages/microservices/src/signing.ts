// ──────────────────────────────────────────────────────────────────────────
// Optional wire message signing / shared-secret authentication (Sprint 10).
//
// A transport configured with a `MessageSigner` wraps every outgoing wire string
// in a signed envelope and verifies + unwraps every incoming one, **rejecting**
// any message whose signature is missing, forged (wrong secret), or tampered
// (bytes changed in flight). This authenticates the peer (a shared secret proves
// the sender holds it) and guarantees integrity on brokers that provide neither.
//
// Signing is complementary to transport encryption: for confidentiality + mutual
// authentication of the *connection*, terminate TLS/mTLS at the broker (see
// SECURITY.md). Signing protects the *message* end-to-end regardless.
//
// The signer operates on the serialized string a transport already puts on the
// wire (it is format-agnostic): `sign(payload) → wire`, `verify(wire) → payload`.
// The default {@link IDENTITY_SIGNER} leaves the wire unchanged (no signing).
// ──────────────────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidMessageError } from "./errors";

/** Wraps / unwraps a wire string with an authentication tag. */
export interface MessageSigner {
  /** Wraps a serialized payload, returning the string to place on the wire. */
  sign(payload: string): string;
  /**
   * Verifies + unwraps a wire string, returning the original payload. Throws an
   * {@link InvalidMessageError} (`retryable: false`) if the signature is missing,
   * forged, tampered, or expired — so a transport dead-letters it rather than
   * retrying (a retry would fail identically) or processing forged bytes.
   */
  verify(wire: string): string;
}

/** Identity signer — the default no-op (`wire === payload`). */
export const IDENTITY_SIGNER: MessageSigner = {
  sign: (payload) => payload,
  verify: (wire) => wire,
};

export interface SharedSecretSignerOptions {
  /** The shared secret both peers hold. Never logged. */
  secret: string;
  /**
   * Reject a message whose timestamp is older than this (ms), bounding replay.
   * Default `300_000` (5 min) — a captured signed message is only replayable
   * within that window. Set `0` to disable the replay check (e.g. when clocks
   * are unsynchronized and integrity/auth alone is the goal).
   */
  maxAgeMs?: number;
  /** Injectable clock (ms) for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/** Signed-envelope version — a real negotiation point for future rotation. */
const SIG_VERSION = 1;
/** Signature algorithm tag placed on the wire. */
const SIG_ALG = "HS256";

interface SignedEnvelope {
  v: number;
  alg: string;
  ts: number;
  payload: string;
  sig: string;
}

/**
 * HMAC-SHA256 shared-secret signer. The tag covers the version, timestamp, and
 * payload, so any change to the payload (tamper) or a wrong secret (forgery)
 * fails verification via a **constant-time** comparison.
 */
export function createSharedSecretSigner(options: SharedSecretSignerOptions): MessageSigner {
  if (!options.secret) throw new Error("createSharedSecretSigner: secret is required");
  const secret = options.secret;
  const maxAgeMs = options.maxAgeMs ?? 300_000;
  const now = options.now ?? Date.now;

  const mac = (v: number, ts: number, payload: string): string =>
    createHmac("sha256", secret).update(`${v}.${ts}.${payload}`).digest("base64");

  return {
    sign(payload: string): string {
      const ts = now();
      const env: SignedEnvelope = {
        v: SIG_VERSION,
        alg: SIG_ALG,
        ts,
        payload,
        sig: mac(SIG_VERSION, ts, payload),
      };
      return JSON.stringify(env);
    },

    verify(wire: string): string {
      let env: SignedEnvelope;
      try {
        env = JSON.parse(wire) as SignedEnvelope;
      } catch {
        throw new InvalidMessageError("signature_missing", "message is not a signed envelope");
      }
      if (
        typeof env !== "object" ||
        env === null ||
        env.v !== SIG_VERSION ||
        env.alg !== SIG_ALG ||
        typeof env.ts !== "number" ||
        typeof env.payload !== "string" ||
        typeof env.sig !== "string"
      ) {
        throw new InvalidMessageError("signature_missing", "message is not a signed envelope");
      }

      const expected = mac(env.v, env.ts, env.payload);
      const a = Buffer.from(env.sig, "base64");
      const b = Buffer.from(expected, "base64");
      // Constant-time compare; length guard first (timingSafeEqual throws on mismatch).
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new InvalidMessageError("signature_invalid", "message signature verification failed");
      }
      if (maxAgeMs > 0 && now() - env.ts > maxAgeMs) {
        throw new InvalidMessageError(
          "signature_expired",
          "signed message is older than the allowed replay window",
        );
      }
      return env.payload;
    },
  };
}
