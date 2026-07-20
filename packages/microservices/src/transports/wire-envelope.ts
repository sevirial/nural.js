// ──────────────────────────────────────────────────────────────────────────
// Discriminated wire envelope (Sprint SF2 — audit finding L2).
//
// Every message a transport puts on the wire is wrapped in an envelope carrying
// an explicit `k` (kind) discriminator, so the *shape of the payload* can never
// decide how the message is routed:
//
//   { k: "evt", d }                        ← emit(): fire-and-forget event
//   { k: "rpc", d, r?, c?, h? }            ← send(): request expecting a reply
//                                            (r=replyTo, c=correlationId, h=headers)
//
// Before this, Redis and memory classified an inbound message as RPC with the
// structural sniff `"replyTo" in parsed` — and because `emit()` published the raw
// payload, a fire-and-forget event whose data happened to contain a `replyTo`
// field was served as an RPC request and its handler's output published to that
// payload-chosen channel. With the discriminator, `emit()` data lives one level
// down in `d`, so a `replyTo` *inside* it is just data.
//
// RPC replies are deliberately NOT enveloped: they arrive on a private, unguessable
// per-client inbox and are matched by correlation id, never classified as event vs
// request — there is nothing for a discriminator to disambiguate.
// ──────────────────────────────────────────────────────────────────────────

import { InvalidMessageError } from "../errors";

/** Envelope kind for a fire-and-forget event (`emit`). */
export const WIRE_EVENT = "evt";
/** Envelope kind for an RPC request expecting a reply (`send`). */
export const WIRE_RPC = "rpc";

/** A fire-and-forget event: the payload is `d`, and nothing in it affects routing. */
export interface WireEvent {
  k: typeof WIRE_EVENT;
  d: unknown;
}

/** An RPC request: payload `d` plus the reply metadata the server needs. */
export interface WireRpc {
  k: typeof WIRE_RPC;
  d: unknown;
  /** replyTo — the channel/queue the reply is published to. */
  r?: string;
  /** correlationId — matches the reply to its pending call. */
  c?: string;
  /** headers — correlation/trace metadata surfaced on `RpcContext.headers`. */
  h?: Record<string, string>;
}

/** Every message on the wire is one of these. */
export type WireEnvelope = WireEvent | WireRpc;

/** RPC metadata accompanying a {@link WireRpc}. */
export interface WireRpcMeta {
  replyTo?: string;
  correlationId?: string;
  headers?: Record<string, string>;
}

/** Wraps `data` as a fire-and-forget event envelope. */
export function wrapEvent(data: unknown): WireEvent {
  return { k: WIRE_EVENT, d: data };
}

/**
 * Wraps `data` as an RPC request envelope. Reply metadata is optional: RMQ carries
 * it in the native AMQP message properties instead and passes no `meta` here.
 */
export function wrapRpc(data: unknown, meta: WireRpcMeta = {}): WireRpc {
  const envelope: WireRpc = { k: WIRE_RPC, d: data };
  if (meta.replyTo !== undefined) envelope.r = meta.replyTo;
  if (meta.correlationId !== undefined) envelope.c = meta.correlationId;
  if (meta.headers !== undefined) envelope.h = meta.headers;
  return envelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Keeps only string-valued header entries — a header is metadata, never a nested object. */
function asHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const headers: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") headers[key] = v;
  }
  return headers;
}

/**
 * Classifies a **legacy** (pre-envelope) message with the old structural heuristic
 * — the very sniff this sprint removes. Reachable only while `acceptLegacyWire` is
 * on, to let a mixed fleet roll without a flag-day.
 *
 * Note the security caveat: within this window a legacy *publisher*'s `emit()`
 * payload containing a `replyTo` field is still classified as RPC (finding L2's
 * original behavior). The window narrows the finding to legacy senders only; it is
 * fully closed by `acceptLegacyWire: false`, which is the default from the next major.
 */
function classifyLegacy(parsed: unknown): WireEnvelope {
  if (isRecord(parsed) && "replyTo" in parsed) {
    return {
      k: WIRE_RPC,
      d: parsed["data"],
      r: asString(parsed["replyTo"]),
      c: asString(parsed["correlationId"]),
      h: asHeaders(parsed["headers"]),
    };
  }
  return { k: WIRE_EVENT, d: parsed };
}

/**
 * Parses a verified wire string into a {@link WireEnvelope}.
 *
 * Throws a permanent {@link InvalidMessageError} (never retried — the transport
 * dead-letters it) when the bytes are not JSON, or carry an absent/unrecognized
 * `k`. Error messages carry no payload bytes: a malformed envelope is attacker-
 * influenced input, and echoing it would put it in the operator's logs.
 *
 * @param acceptLegacy accept pre-SF2 unwrapped messages via the old heuristic.
 */
export function parseWire(raw: string, acceptLegacy = false): WireEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidMessageError("invalid_json", "message is not valid JSON");
  }

  if (isRecord(parsed) && parsed["k"] !== undefined) {
    switch (parsed["k"]) {
      case WIRE_EVENT:
        return { k: WIRE_EVENT, d: parsed["d"] };
      case WIRE_RPC:
        return {
          k: WIRE_RPC,
          d: parsed["d"],
          r: asString(parsed["r"]),
          c: asString(parsed["c"]),
          h: asHeaders(parsed["h"]),
        };
      default:
        throw new InvalidMessageError(
          "invalid_envelope",
          'message carries an unrecognized wire envelope kind ("k"); expected "evt" or "rpc"',
        );
    }
  }

  if (!acceptLegacy) {
    throw new InvalidMessageError(
      "invalid_envelope",
      'message is not a discriminated wire envelope (no "k") — the sender may predate ' +
        "@nuraljs/microservices 0.5.0; set acceptLegacyWire: true to accept it during migration",
    );
  }
  return classifyLegacy(parsed);
}
