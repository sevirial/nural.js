// ──────────────────────────────────────────────────────────────────────────
// Optional idempotency support (Sprint 9).
//
// At-least-once transports (RMQ with retry/redelivery, Kafka) can deliver the
// same message more than once. A caller may attach an idempotency key
// (`send(.., { idempotencyKey })`, carried on the wire as `x-idempotency-key`);
// a MicroserviceBuilder configured with an {@link IdempotencyStore} then records
// the outcome per key and, on a duplicate delivery, replays it WITHOUT re-running
// the handler:
//   • RPC  → the cached reply envelope is sent back (same result, no re-execution);
//   • emit → the delivery is skipped (already processed).
//
// Only outcomes for messages that were *processed to completion* are recorded;
// a failed fire-and-forget message is not cached, so the transport's retry/DLQ
// path is never short-circuited by idempotency.
//
// The default {@link MemoryIdempotencyStore} is in-process (per worker). For a
// horizontally-scaled fleet supply a shared store (e.g. Redis-backed) — the
// interface is intentionally tiny.
// ──────────────────────────────────────────────────────────────────────────

import type { RpcEnvelope } from "./rpc-envelope";

/** Records + replays RPC/emit outcomes keyed by idempotency key. */
export interface IdempotencyStore {
  /** The recorded outcome for a previously-seen key, or `undefined` if new. */
  get(key: string): Promise<RpcEnvelope | undefined> | RpcEnvelope | undefined;
  /** Records the outcome for a key. */
  set(key: string, value: RpcEnvelope): Promise<void> | void;
}

/**
 * In-process idempotency store bounded to `maxEntries` (oldest evicted first).
 * Bounded by construction — never an unbounded memory leak. Not shared across
 * workers; supply your own {@link IdempotencyStore} for distributed dedup.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, RpcEnvelope>();

  constructor(private readonly maxEntries = 1000) {}

  get(key: string): RpcEnvelope | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: RpcEnvelope): void {
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, value);
  }
}
