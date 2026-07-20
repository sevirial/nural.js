// ──────────────────────────────────────────────────────────────────────────
// Pluggable telemetry (Sprint 10).
//
// Observability is optional and behind a **no-op default**: with no `telemetry`
// configured the client, builder, and transports still call these hooks — they
// just do nothing (the {@link NoopTelemetry} implementation). So there is no cost
// and no hard dependency on OpenTelemetry. Supply a `Telemetry` (e.g. a thin OTel
// adapter) to get spans + metrics.
//
// Two spans model the RPC path:
//   • client `send`   → a `client`-kind span that also **injects** trace context
//                        into the outgoing wire headers (the `carrier`);
//   • server `handle` → a `server`-kind span that **extracts** the parent trace
//                        context from the incoming wire headers (the `carrier`).
// The `carrier` is `RpcContext.headers` — the same map that carries the
// correlation id — so trace context propagates **on the wire** (T10.3) through
// whatever standard the adapter implements (e.g. W3C `traceparent`).
//
// Metrics cover latency, in-flight, errors, and retries.
// ──────────────────────────────────────────────────────────────────────────

/** Whether a span is the client (caller) or server (handler) side of an RPC. */
export type SpanKind = "client" | "server";

/** A started span. `setError` and `end` must each be safe to call. */
export interface Span {
  /** Marks the span as failed (never records a stack trace onto the wire). */
  setError(err: unknown): void;
  /** Ends the span. Implementations should tolerate a double `end()`. */
  end(): void;
}

/**
 * Pluggable telemetry sink. All calls must be cheap and MUST NOT throw — a
 * telemetry failure must never break message processing. Use {@link NoopTelemetry}
 * (the default) as a base if you only want to implement some of the hooks.
 */
export interface Telemetry {
  /**
   * Starts a span. `carrier` is the wire header map: a `client` span should
   * **inject** trace context into it (so it travels on the wire); a `server` span
   * should **extract** the parent from it. `attributes` carry low-cardinality
   * context (topic, transport) — never payloads or secrets.
   */
  startSpan(
    name: string,
    kind: SpanKind,
    carrier: Record<string, string>,
    attributes?: Record<string, string>,
  ): Span;
  /** Records an operation's latency, in milliseconds. */
  recordLatency(name: string, ms: number, attributes?: Record<string, string>): void;
  /** Adjusts an in-flight gauge by `delta` (+1 at start, −1 at end). */
  recordInFlight(name: string, delta: number, attributes?: Record<string, string>): void;
  /** Increments a counter (errors, retries) by one. */
  incrementCounter(name: string, attributes?: Record<string, string>): void;
}

/** Stable metric/span names emitted by the client, builder, and transports. */
export const TELEMETRY_NAMES = {
  clientSpan: "microservice.client.send",
  clientLatency: "microservice.client.duration_ms",
  clientInFlight: "microservice.client.in_flight",
  clientErrors: "microservice.client.errors",
  serverSpan: "microservice.server.handle",
  serverLatency: "microservice.server.duration_ms",
  serverInFlight: "microservice.server.in_flight",
  serverErrors: "microservice.server.errors",
  retries: "microservice.retries",
} as const;

/** A span that does nothing — used whenever telemetry is not configured. */
const NOOP_SPAN: Span = { setError() {}, end() {} };

/** No-op telemetry: every hook is a zero-cost, no-throw no-op. The default sink. */
export class NoopTelemetry implements Telemetry {
  startSpan(): Span {
    return NOOP_SPAN;
  }
  recordLatency(): void {}
  recordInFlight(): void {}
  incrementCounter(): void {}
}

/** The shared default no-op telemetry instance. */
export const NOOP_TELEMETRY: Telemetry = new NoopTelemetry();
