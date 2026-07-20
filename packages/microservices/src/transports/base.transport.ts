// ──────────────────────────────────────────────────────────────────────────
// BaseTransport — shared connection lifecycle for every transport (Sprint 7).
//
// Redis, RMQ, and Kafka have very different native reconnection stories
// (ioredis and kafkajs self-heal; amqplib does nothing). This base factors out
// the parts that must behave identically regardless:
//   • a single connection state machine (idle → connecting → connected →
//     reconnecting → closing → closed),
//   • ONE exponential-backoff-with-jitter policy (`backoffDelay`) — used both by
//     the built-in reconnect driver (RMQ) and fed into a client's own retry hook
//     (ioredis `retryStrategy`),
//   • in-flight operation tracking so `close()` can **drain** before tearing the
//     connection down (no dropped RPC replies / half-published messages),
//   • a graceful `close()` template that drains then calls the subclass teardown.
//
// Subclasses implement two hooks — `openConnection()` (establish/reestablish the
// underlying client) and `teardown()` (quit it gracefully) — and call
// `handleDisconnect()` when they detect an unexpected drop.
// ──────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import { Logger } from "@nuraljs/core";
import { NOOP_TELEMETRY, Telemetry } from "../telemetry";
import { IDENTITY_SIGNER, MessageSigner } from "../signing";
import { InvalidMessageError } from "../errors";
import { WireEnvelope, parseWire } from "./wire-envelope";

/** Default inbound wire-size cap, bytes (1 MiB). Secure by default; `0` disables. */
export const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;

/**
 * Whether inbound legacy (pre-0.5.0, un-enveloped) messages are accepted by
 * default. `true` for the 0.5.x migration window; flips to `false` next major.
 */
export const DEFAULT_ACCEPT_LEGACY_WIRE = true;

/** Lifecycle states shared by every transport. */
export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed";

/** Minimal structural logger — satisfied by the core `nuraljs` `Logger`. */
export interface TransportLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, trace?: string): void;
}

/** Reconnect/backoff policy. */
export interface ReconnectOptions {
  /** First retry delay, ms (doubles per attempt). Default 500. */
  initialDelayMs?: number;
  /** Cap on the backoff delay, ms. Default 30_000. */
  maxDelayMs?: number;
  /**
   * Max retry attempts after the first try before giving up. Default Infinity
   * (retry forever — the resilient default for a long-running worker).
   */
  maxRetries?: number;
}

/** Lifecycle options common to all transports (merged into each transport's own options). */
export interface BaseTransportOptions {
  /** Reconnect/backoff policy. */
  reconnect?: ReconnectOptions;
  /** How long `close()` waits for in-flight operations to settle, ms. Default 10_000. */
  drainTimeoutMs?: number;
  /** Structured logger. Defaults to a core `Logger` tagged with the transport name. */
  logger?: TransportLogger;
  /** Injectable RNG for the jitter — deterministic backoff in tests. Default `Math.random`. */
  random?: () => number;
  /** Injectable sleep — instant backoff in tests. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional telemetry sink (spans/metrics). Defaults to a no-op (Sprint 10). */
  telemetry?: Telemetry;
  /**
   * Optional wire message signer (shared-secret auth). When set, every outgoing
   * message is signed and every incoming one is verified — a tampered/forged
   * message is rejected. Defaults to identity (no signing). (Sprint 10, T10.4.)
   */
  signer?: MessageSigner;
  /**
   * Maximum size of an **inbound** wire message, bytes. A larger message is
   * rejected before it is verified or parsed — so an oversize payload can never
   * be `JSON.parse`d into memory — and dead-lettered as a permanent failure.
   * Default {@link DEFAULT_MAX_MESSAGE_BYTES} (1 MiB). Set `0` to disable the cap
   * (explicit opt-out; the broker's own max-frame setting then bounds you).
   */
  maxMessageBytes?: number;
  /**
   * Accept **legacy** inbound messages — those published by a pre-0.5.0 peer,
   * which put the raw payload on the wire instead of a discriminated
   * {@link WireEnvelope}. Outbound `emit`/`send` always write the new envelope;
   * this only widens what is *read*, so a mixed fleet can roll without a flag-day.
   *
   * Default {@link DEFAULT_ACCEPT_LEGACY_WIRE} (`true`) for the 0.5.x window;
   * the default flips to `false` next major. Set `false` once every publisher is
   * on ≥ 0.5.0: the legacy branch still classifies RPC by the old
   * `"replyTo" in payload` heuristic (audit finding L2), so only `false` closes
   * that finding for legacy senders.
   */
  acceptLegacyWire?: boolean;
}

/** The base-lifecycle fields, as a Zod object each transport's schema extends. */
export const baseOptionsShape = {
  reconnect: z
    .object({
      initialDelayMs: z.number().int().positive().optional(),
      maxDelayMs: z.number().int().positive().optional(),
      maxRetries: z.number().nonnegative().optional(),
    })
    .optional(),
  drainTimeoutMs: z.number().int().nonnegative().optional(),
  logger: z.custom<TransportLogger>().optional(),
  random: z.custom<() => number>().optional(),
  sleep: z.custom<(ms: number) => Promise<void>>().optional(),
  telemetry: z.custom<Telemetry>().optional(),
  signer: z.custom<MessageSigner>().optional(),
  // `nonnegative`, not `positive`: 0 is the documented "unlimited" opt-out.
  maxMessageBytes: z.number().int().nonnegative().optional(),
  acceptLegacyWire: z.boolean().optional(),
};

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validates a transport's options against a Zod schema, throwing a single clear
 * Error prefixed with the transport name. Zod issue messages describe the failing
 * path, never the value, so a password/URL is never echoed.
 */
export function parseTransportOptions<T extends z.ZodTypeAny>(
  label: string,
  schema: T,
  value: unknown,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new Error(`${label}: invalid options — ${detail}`);
  }
  return result.data;
}

/**
 * Loads an optional broker peer dependency at runtime, throwing a clear,
 * actionable error if it is not installed. Brokers are optional peers (Sprint 7,
 * T7.6): a consumer using only Redis must not be forced to install kafkajs/amqplib.
 */
export async function loadOptionalDep<T>(moduleName: string, transportName: string): Promise<T> {
  try {
    return (await import(moduleName)) as T;
  } catch (err) {
    throw new Error(
      `The "${transportName}" transport requires the optional peer dependency ` +
        `"${moduleName}", which is not installed. Install it to use this transport ` +
        `(e.g. \`npm install ${moduleName}\`). Original error: ${errMessage(err)}`,
    );
  }
}

/**
 * Abstract base providing the shared connection lifecycle. See the file header.
 */
export abstract class BaseTransport {
  protected state: ConnectionState = "idle";
  protected readonly logger: TransportLogger;
  /** Telemetry sink for transport-level metrics (e.g. retries). No-op by default. */
  protected readonly telemetry: Telemetry;

  private readonly name: string;
  private readonly signer: MessageSigner;
  private readonly maxMessageBytes: number;
  private readonly acceptLegacyWire: boolean;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetries: number;
  private readonly drainTimeoutMs: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly inflight = new Set<Promise<unknown>>();
  private reconnecting: Promise<void> | null = null;

  protected constructor(name: string, opts: BaseTransportOptions = {}) {
    this.name = name;
    this.logger = opts.logger ?? new Logger(name);
    this.initialDelayMs = opts.reconnect?.initialDelayMs ?? 500;
    this.maxDelayMs = opts.reconnect?.maxDelayMs ?? 30_000;
    this.maxRetries = opts.reconnect?.maxRetries ?? Number.POSITIVE_INFINITY;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.telemetry = opts.telemetry ?? NOOP_TELEMETRY;
    this.signer = opts.signer ?? IDENTITY_SIGNER;
    this.maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.acceptLegacyWire = opts.acceptLegacyWire ?? DEFAULT_ACCEPT_LEGACY_WIRE;
  }

  // ── Wire signing (identity unless a signer is configured) ──────────────────

  /** Signs an outgoing serialized payload (a no-op passthrough without a signer). */
  protected signWire(payload: string): string {
    return this.signer.sign(payload);
  }
  /**
   * Rejects an inbound wire string larger than `maxMessageBytes` (Sprint SF1,
   * audit L4). Runs **before** signature verification and `JSON.parse`, so an
   * oversize message is never parsed into memory — the whole point of the cap.
   * Only the measured size and the limit are reported; no payload bytes.
   */
  protected guardMessageSize(wire: string): void {
    if (this.maxMessageBytes === 0) return; // explicit opt-out
    const size = Buffer.byteLength(wire, "utf8");
    if (size > this.maxMessageBytes) {
      throw new InvalidMessageError(
        "message_too_large",
        `message is ${size} bytes, exceeding the ${this.maxMessageBytes}-byte limit`,
      );
    }
  }

  /**
   * Verifies + unwraps an incoming wire string. Throws an `InvalidMessageError`
   * (permanent failure) if the message is oversize, or on a missing/forged/tampered
   * signature — a size-guarded passthrough without a signer.
   */
  protected verifyWire(wire: string): string {
    this.guardMessageSize(wire);
    return this.signer.verify(wire);
  }

  /**
   * The full inbound read: size-guard → signature-verify → parse into a
   * discriminated {@link WireEnvelope} (Sprint SF2, audit L2). Every transport's
   * request path funnels through this, so message *kind* is always read from the
   * explicit `k` discriminator and never inferred from the payload's shape.
   *
   * Throws a permanent `InvalidMessageError` on oversize / forged / malformed /
   * unrecognized-kind bytes — the caller dead-letters it.
   */
  protected readWire(wire: string): WireEnvelope {
    return parseWire(this.verifyWire(wire), this.acceptLegacyWire);
  }

  // ── Subclass hooks ────────────────────────────────────────────────────────

  /** Establish (or re-establish) the underlying client(s). Throw on failure. */
  protected abstract openConnection(): Promise<void>;
  /** Gracefully quit the underlying client(s). Called once, after draining. */
  protected abstract teardown(): Promise<void>;

  // ── Public state ──────────────────────────────────────────────────────────

  get connectionState(): ConnectionState {
    return this.state;
  }
  get isConnected(): boolean {
    return this.state === "connected";
  }
  protected get inflightCount(): number {
    return this.inflight.size;
  }

  // ── Backoff policy (shared by the reconnect driver and clients' own hooks) ──

  /**
   * Exponential backoff with **equal jitter**: the delay for attempt `n` is drawn
   * from `[d/2, d]` where `d = min(maxDelayMs, initialDelayMs · 2^(n-1))`. Jitter
   * spreads a fleet's retries so they don't stampede a recovering broker.
   */
  protected backoffDelay(attempt: number): number {
    const n = Math.max(1, attempt);
    const ceiling = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** (n - 1));
    const half = Math.floor(ceiling / 2);
    return half + Math.floor(this.random() * (ceiling - half + 1));
  }

  // ── Connect / reconnect ───────────────────────────────────────────────────

  /**
   * Connects, retrying with backoff until success, `close()`, or `maxRetries`.
   * Idempotent: a no-op when already connected/connecting; awaits an in-flight
   * reconnect if one is running.
   */
  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;
    if (this.state === "reconnecting" && this.reconnecting) {
      await this.reconnecting;
      return;
    }
    if (this.state === "closing" || this.state === "closed") {
      throw new Error(`${this.name}: cannot connect — transport is ${this.state}`);
    }
    this.state = "connecting";
    await this.openWithRetry("connect");
  }

  /** The shared open-with-backoff loop. */
  private async openWithRetry(reason: "connect" | "reconnect"): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (this.state === "closing" || this.state === "closed") return;
      try {
        await this.openConnection();
        this.state = "connected";
        if (attempt > 0) this.logger.log(`${reason} succeeded after ${attempt} retr${attempt === 1 ? "y" : "ies"}`);
        return;
      } catch (err) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          this.state = "idle";
          throw new Error(
            `${this.name}: ${reason} failed after ${this.maxRetries} retries — ${errMessage(err)}`,
          );
        }
        const delay = this.backoffDelay(attempt);
        this.logger.warn(
          `${this.name}: ${reason} attempt ${attempt} failed, retrying in ${delay}ms — ${errMessage(err)}`,
        );
        await this.sleep(delay);
      }
    }
  }

  /**
   * Called by a subclass when the underlying connection drops unexpectedly.
   * Single-flight: kicks off a background reconnect (with backoff) and ignores
   * further drops while one is already in progress or while closing.
   */
  protected handleDisconnect(err?: unknown): void {
    if (this.state !== "connected") return; // ignore drops while connecting/closing/reconnecting
    this.state = "reconnecting";
    this.logger.warn(`${this.name}: connection lost${err ? ` — ${errMessage(err)}` : ""}; reconnecting`);
    this.reconnecting = this.openWithRetry("reconnect")
      .catch((e) => {
        this.logger.error(`${this.name}: reconnect gave up — ${errMessage(e)}`);
      })
      .finally(() => {
        this.reconnecting = null;
      });
  }

  // ── In-flight tracking + drain ────────────────────────────────────────────

  /**
   * Registers an in-flight operation so `close()` can await it. Returns the same
   * promise (settlement, value, and rejection all pass through unchanged).
   */
  protected trackInflight<T>(op: Promise<T>): Promise<T> {
    const tracked: Promise<T> = op.finally(() => {
      this.inflight.delete(tracked);
    });
    this.inflight.add(tracked);
    return tracked;
  }

  /** Awaits all in-flight operations, bounded by `drainTimeoutMs`. */
  private async drainInflight(): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.drainTimeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
    const drained = Promise.allSettled([...this.inflight]).then(() => "drained" as const);
    const result = await Promise.race([drained, timeout]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") {
      this.logger.warn(
        `${this.name}: drain timed out after ${this.drainTimeoutMs}ms with ${this.inflight.size} in-flight op(s)`,
      );
    }
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  /**
   * Graceful shutdown: stop accepting reconnects, **drain** in-flight operations
   * (bounded by `drainTimeoutMs`), then tear the underlying client(s) down.
   * Idempotent.
   */
  async close(): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    this.logger.log(`${this.name}: closing — draining ${this.inflight.size} in-flight op(s)`);
    await this.drainInflight();
    try {
      await this.teardown();
    } finally {
      this.state = "closed";
    }
  }
}
