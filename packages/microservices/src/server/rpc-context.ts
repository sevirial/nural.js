import { TransportType } from "../transports/transport.interface";

/** Wire header key carrying the RPC correlation id. */
export const CORRELATION_HEADER = "x-correlation-id";

/** Wire header key carrying an optional idempotency key (Sprint 9). */
export const IDEMPOTENCY_HEADER = "x-idempotency-key";

/**
 * Abstracts the underlying protocol so handlers don't care if
 * the message came from Kafka, Redis, or RMQ.
 *
 * `headers` carries propagated context — the correlation id (also exposed as
 * `correlationId`) and any trace context (e.g. `traceparent`) — end to end.
 */
export class RpcContext {
  constructor(
    public readonly protocol: TransportType,
    public readonly topic: string,
    public readonly replyTo?: string,
    public readonly headers: Record<string, string> = {},
    /** The RPC correlation id (UUID), when this message is part of a request/reply. */
    public readonly correlationId?: string,
  ) {}
}
