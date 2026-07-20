// ──────────────────────────────────────────────────────────────────────────
// @nuraljs/microservices — typed RPC error taxonomy (Sprint 8, extended Sprint 9).
//
// RPC failures are surfaced as typed, programmatically-distinguishable errors
// (a stable `code` independent of the message) so callers can branch on them.
// Sprint 9 adds the wire error-envelope taxonomy: a remote handler failure
// crosses the wire as an {@link RpcErrorPayload} and is rehydrated on the client
// as an {@link RpcRemoteError}.
// ──────────────────────────────────────────────────────────────────────────

/** Stable, machine-readable discriminator carried by every {@link RpcError}. */
export type RpcErrorCode = "rpc_timeout" | "rpc_unsupported" | "rpc_remote";

/**
 * The serializable failure description carried by an error envelope on the wire
 * (Sprint 9). `code` is a stable, machine-readable discriminator the server
 * assigns (`handler_error`, `invalid_request`, `invalid_response`, or a custom
 * code the handler threw); `message` is human-readable and MUST NOT carry
 * secrets — stack traces are never placed here.
 */
export interface RpcErrorPayload {
  /** Stable, server-assigned discriminator (e.g. `handler_error`). */
  code: string;
  /** Human-readable, secret-free description. */
  message: string;
}

/** Base class for every microservices RPC error. */
export class RpcError extends Error {
  /** Stable, machine-readable error discriminator. */
  public readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/** Type guard — narrows an unknown thrown value to an {@link RpcError}. */
export function isRpcError(err: unknown): err is RpcError {
  return err instanceof RpcError;
}

/** An RPC request did not receive a reply within the (per-call or per-client) timeout. */
export class RpcTimeoutError extends RpcError {
  constructor(message = "RPC request timed out") {
    super("rpc_timeout", message);
  }
}

/**
 * An RPC (`send`) was attempted over a transport that does not support
 * request/reply (e.g. Kafka). Thrown **fast, at the call site**, before any
 * network work — driven by the transport's `capabilities.supportsRpc` flag.
 */
export class RpcUnsupportedError extends RpcError {
  constructor(message = "This transport does not support RPC") {
    super("rpc_unsupported", message);
  }
}

/**
 * A remote RPC handler reported a failure (Sprint 9). The server catches the
 * handler throw / validation failure, sends a typed error envelope back to the
 * caller, and the client rehydrates it into this error — so a failed `send()`
 * **rejects with a typed error instead of timing out**.
 *
 * `remoteCode` is the stable code the server assigned to the failure
 * (`handler_error`, `invalid_request`, `invalid_response`, or a custom code the
 * handler threw), letting callers branch on the remote cause.
 */
export class RpcRemoteError extends RpcError {
  /** The stable code the server assigned to the failure. */
  public readonly remoteCode: string;

  constructor(payload: RpcErrorPayload) {
    super("rpc_remote", payload.message);
    this.remoteCode = payload.code;
  }
}

/**
 * A message that could not be processed and must **not** be retried (Sprint 9) —
 * e.g. it failed schema validation or was malformed on the wire. Transports
 * route it straight to the dead-letter queue rather than retrying (a retry would
 * fail identically) or silently dropping it. `retryable: false` is the signal a
 * transport's failure router keys on.
 */
export class InvalidMessageError extends Error {
  /** Permanent failure — never retried; dead-lettered immediately. */
  public readonly retryable = false;
  /** Stable, machine-readable discriminator (e.g. `invalid_request`, `invalid_json`). */
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "InvalidMessageError";
    this.code = code;
  }
}
