import { RpcContext } from "../server/rpc-context";

export type RawMessageHandler = (data: unknown, ctx: RpcContext) => Promise<unknown | void>;

export type TransportType = "redis" | "kafka" | "grpc" | "rmq" | "memory";

/**
 * Declares what a transport can do, so mismatched wiring fails fast with a clear
 * typed error instead of a generic throw deep in a call (Sprint 8, T8.5).
 */
export interface TransportCapabilities {
  /** Whether the transport supports request/reply RPC (`send`). Kafka: false. */
  readonly supportsRpc: boolean;
}

/** Per-call options for an RPC `send` (Sprint 8). */
export interface SendOptions {
  /** Overrides the transport's default RPC timeout for this call, ms. */
  timeoutMs?: number;
  /**
   * Extra wire headers to propagate to the server's `RpcContext.headers`
   * (e.g. `traceparent` for trace-context propagation). The correlation id is
   * added automatically.
   */
  headers?: Record<string, string>;
  /**
   * Optional idempotency key (Sprint 9). Propagated on the wire as
   * `x-idempotency-key`; a server configured with an `IdempotencyStore` replays
   * the recorded reply for a duplicate delivery instead of re-running the handler.
   */
  idempotencyKey?: string;
}

export interface ClientTransport {
  /** What this transport can do — checked at wiring time. */
  readonly capabilities: TransportCapabilities;
  connect(): Promise<void>;
  emit(topic: string, data: unknown): Promise<void>;
  send(topic: string, data: unknown, options?: SendOptions): Promise<unknown>;
  close(): Promise<void>;
}

export interface ServerTransport {
  /** What this transport can do — checked at wiring time. */
  readonly capabilities: TransportCapabilities;
  listen(handlers: Map<string, RawMessageHandler>): Promise<void>;
  /**
   * Sends an RPC reply. Receives the request's {@link RpcContext} so the
   * transport has everything it needs to route the reply — the reply address
   * (`ctx.replyTo`) and the `ctx.correlationId` the caller matches on.
   * (Sprint 8: signature changed from `reply(replyTo, data)` to carry correlation.)
   */
  reply?(ctx: RpcContext, data: unknown): Promise<void>;
  close(): Promise<void>;
}
