// ──────────────────────────────────────────────────────────────────
// Provider secret-length policy (Sprint SF3 — audit finding L5).
//
// Every KMS provider seeds a 256-bit ChaCha20-Poly1305 key from an operator-
// supplied secret via HKDF-SHA256. HKDF spreads whatever entropy the secret has
// across the full key, but it cannot create entropy that was never there — a
// 16-character secret is a weak floor for a 256-bit key.
//
// **Warn-then-enforce.** Raising the floor to 32 outright would reject a
// previously-valid secret on a point upgrade and take a running app down at boot.
// So this release keeps the hard reject at {@link MIN_SECRET_LENGTH_HARD} (16)
// and emits a one-time deprecation warning for a 16–31-character secret; the next
// major raises the hard floor to {@link SECRET_LENGTH_RECOMMENDED} (32).
// ──────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { KmsLogger } from "./types";

/**
 * The hard floor: a shorter secret is **rejected** at provider construction.
 * Stays at 16 for this release — see the warn-then-enforce note above.
 */
export const MIN_SECRET_LENGTH_HARD = 16;

/**
 * The recommended (and next-major hard) floor. A secret between
 * {@link MIN_SECRET_LENGTH_HARD} and this length still works, but warns once.
 */
export const SECRET_LENGTH_RECOMMENDED = 32;

/** `code` on the emitted `process.emitWarning` — lets operators filter/assert on it. */
export const SHORT_SECRET_WARNING_CODE = "NURALJS_AUTH_SHORT_SECRET";

/**
 * The shared secret-length schema every provider builds on: enforces the hard
 * floor. `label` names the field in the error (e.g. `secret`, `key value`).
 *
 * Zod issue messages describe the failing path and never echo the parsed value,
 * so a rejected secret never reaches the error text.
 */
export function secretSchema(label = "secret"): z.ZodString {
  return z
    .string()
    .min(
      MIN_SECRET_LENGTH_HARD,
      `${label} must be at least ${MIN_SECRET_LENGTH_HARD} characters long`,
    );
}

/** One secret's *length* (plus its key id, where the provider has one). */
export interface SecretLengthEntry {
  length: number;
  /** Key/version id, so an operator knows which key to rotate. Not secret material. */
  id?: number;
}

/**
 * Builds the once-per-provider deprecation warner for short secrets.
 *
 * Call the returned function with every secret's **length** — it never receives
 * the secret itself, so no amount of formatting can leak key material into a log
 * line. It latches after the first warning, so a provider that re-validates on a
 * schedule (the cloud provider polls its vault) warns once, not once per refresh.
 *
 * Emits through `logger.warn` when the provider has a logger (routing it into the
 * app's structured logging), otherwise `process.emitWarning` as a
 * `DeprecationWarning`.
 */
export function createShortSecretWarner(
  label: string,
  logger?: KmsLogger,
): (entries: SecretLengthEntry[]) => void {
  let warned = false;

  return (entries) => {
    if (warned) return;
    const short = entries.filter((e) => e.length < SECRET_LENGTH_RECOMMENDED);
    if (short.length === 0) return;
    warned = true;

    const subject =
      entries.length === 1
        ? "the configured secret is"
        : `${short.length} of ${entries.length} secrets are`;
    const ids = short.map((e) => e.id).filter((id): id is number => id !== undefined);
    const where = ids.length > 0 ? ` (key id${ids.length > 1 ? "s" : ""}: ${ids.join(", ")})` : "";

    const message =
      `${label}: ${subject} shorter than ${SECRET_LENGTH_RECOMMENDED} characters${where}. ` +
      `Secrets under ${SECRET_LENGTH_RECOMMENDED} characters are deprecated and will be ` +
      `REJECTED in the next major version of @nuraljs/auth — rotate to a secret of at least ` +
      `${SECRET_LENGTH_RECOMMENDED} characters (e.g. \`openssl rand -base64 32\`). ` +
      `This warning is emitted once per provider.`;

    if (logger) {
      logger.warn(message);
    } else {
      process.emitWarning(message, {
        type: "DeprecationWarning",
        code: SHORT_SECRET_WARNING_CODE,
      });
    }
  };
}
