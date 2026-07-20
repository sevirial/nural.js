// ──────────────────────────────────────────────────────────────────────────
// RPC wire envelope (Sprint 9).
//
// Every RPC reply now crosses the wire as a discriminated envelope so a failure
// is delivered to the caller as data (never a timeout) and is distinguishable
// from a legitimate result:
//
//   success → { ok: true,  data }
//   failure → { ok: false, error: { code, message } }
//
// The envelope lives at the MicroserviceBuilder ↔ RpcClient boundary; transports
// carry it opaquely as the reply body (they neither create nor inspect it). The
// emit / fire-and-forget path is unaffected — only request/reply is enveloped.
//
// ⚠️ Wire-format break vs Sprint 8 (raw reply body) — see Sprint 12 migration.
// ──────────────────────────────────────────────────────────────────────────

import { InvalidMessageError, type RpcErrorPayload } from "./errors";

/** A successful RPC reply. */
export interface RpcSuccessEnvelope {
  readonly ok: true;
  readonly data: unknown;
}

/** A failed RPC reply — carries a typed, secret-free failure description. */
export interface RpcErrorEnvelope {
  readonly ok: false;
  readonly error: RpcErrorPayload;
}

/** The discriminated RPC reply envelope. */
export type RpcEnvelope = RpcSuccessEnvelope | RpcErrorEnvelope;

/** Wraps a handler result as a success envelope. */
export function successEnvelope(data: unknown): RpcSuccessEnvelope {
  return { ok: true, data };
}

/** Builds an error envelope from an explicit code + message. */
export function errorEnvelope(code: string, message: string): RpcErrorEnvelope {
  return { ok: false, error: { code, message } };
}

/** Generic, secret-free message used when an error's own message is not exposed. */
const REDACTED_MESSAGE = "Internal handler error";

/**
 * Builds an error envelope from a thrown value. Never leaks stack traces onto
 * the wire; if the thrown error carries a stable string `code`, it is preserved
 * so the caller can branch on it, otherwise the failure is a generic
 * `handler_error`.
 *
 * The raw `message` is **redacted by default** — an arbitrary handler throw can
 * carry internal detail (a DSN, a file path, a secret), so its message is only
 * forwarded when `exposeMessage` is set, or when the error opts in as safe:
 * an {@link InvalidMessageError} (whose message is a fixed validation string) or
 * any error carrying `expose === true`. The stable `code` always crosses.
 */
export function toErrorEnvelope(
  err: unknown,
  opts: { exposeMessage?: boolean } = {},
): RpcErrorEnvelope {
  const code =
    typeof (err as { code?: unknown } | null)?.code === "string"
      ? (err as { code: string }).code
      : "handler_error";
  const safeToExpose =
    opts.exposeMessage === true ||
    err instanceof InvalidMessageError ||
    (err as { expose?: unknown } | null)?.expose === true;
  const message = safeToExpose
    ? err instanceof Error
      ? err.message
      : String(err)
    : REDACTED_MESSAGE;
  return errorEnvelope(code, message);
}

/** Narrows an unknown reply body to an {@link RpcEnvelope}. */
export function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}
