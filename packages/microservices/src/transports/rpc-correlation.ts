// ──────────────────────────────────────────────────────────────────────────
// Shared RPC correlation + timeout helper (Sprint 8).
//
// Both the Redis and RMQ request/reply paths follow the same shape: generate a
// UUID correlation id, register a pending promise keyed by that id with a
// per-call timeout, publish the request carrying the id, and resolve the pending
// promise when a reply bearing the same id arrives. This helper factors that out
// so the two transports share one correct implementation (UUIDs, not
// `Math.random`; a typed `RpcTimeoutError`; clean pending cleanup).
// ──────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { RpcTimeoutError } from "../errors";

/** A cryptographically-strong RPC correlation id (UUID v4). */
export function newCorrelationId(): string {
  return randomUUID();
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A registry of in-flight RPC calls keyed by correlation id. Each call gets a
 * timeout that rejects with a typed {@link RpcTimeoutError} and cleans up.
 */
export class RpcCorrelator {
  private readonly pending = new Map<string, Pending>();

  /** Number of in-flight RPC calls awaiting a reply. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Registers a pending RPC and returns a promise that resolves when
   * {@link deliver} is called with the matching `correlationId`, or rejects with
   * an {@link RpcTimeoutError} after `timeoutMs`. `onTimeout` runs before the
   * rejection (e.g. to unsubscribe a reply channel).
   */
  waitFor(correlationId: string, timeoutMs: number, onTimeout?: () => void): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        try {
          onTimeout?.();
        } finally {
          reject(new RpcTimeoutError(`RPC request timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(correlationId, { resolve, reject, timer });
    });
  }

  /** Resolves the pending call for `correlationId`. Returns false if none matched. */
  deliver(correlationId: string, value: unknown): boolean {
    const p = this.pending.get(correlationId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(correlationId);
    p.resolve(value);
    return true;
  }

  /** Rejects the pending call for `correlationId` (e.g. a publish failure). */
  fail(correlationId: string, err: Error): boolean {
    const p = this.pending.get(correlationId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(correlationId);
    p.reject(err);
    return true;
  }

  /** Rejects every pending call (e.g. on transport close) and clears the registry. */
  rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
