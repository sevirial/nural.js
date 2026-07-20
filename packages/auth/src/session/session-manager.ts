import * as crypto from "node:crypto";
import { z } from "zod";
import type { SessionStore } from "./types";
import { parseAuthConfig } from "../config";
import {
  createAuditor,
  enforceRateLimit,
  type AuthObservability,
  type RateLimitHook,
} from "../observability";

/**
 * Auth signer interface — the minimal contract needed by the session manager.
 * Decoupled from any specific auth implementation.
 */
interface TokenSigner<Schema extends z.ZodTypeAny> {
  sign(payload: z.infer<Schema>): Promise<string>;
}

/**
 * Audit event emitted when a **rotated (already-consumed) refresh token is
 * replayed** — a strong indicator that a refresh token leaked. The offending
 * token's whole family has already been revoked by the store; this hook lets
 * the caller record/alert. Never carries the token bytes.
 */
export interface SessionReuseEvent {
  type: "refresh_reuse";
  userId?: string;
  familyId?: string;
  at: number;
}

/**
 * Thrown by `rotate` when reuse of a rotated refresh token is detected. The
 * token family has been revoked; the user should be forced to re-authenticate.
 * Distinguishable from the generic invalid-token error for programmatic
 * handling and audit.
 */
export class RefreshTokenReuseError extends Error {
  readonly familyId?: string;
  readonly userId?: string;
  constructor(userId?: string, familyId?: string) {
    super("Refresh token reuse detected — session family revoked");
    this.name = "RefreshTokenReuseError";
    this.userId = userId;
    this.familyId = familyId;
  }
}

export interface SessionManagerOptions {
  /** Long-lived refresh-token TTL in seconds (also the reuse-detection window). */
  refreshTtlSeconds?: number;
  /** Audit sink for reuse detection. Fires in addition to `observability`. */
  onReuse?: (event: SessionReuseEvent) => void;
  /**
   * Optional observability wiring (Sprint 6). When a `logger` is supplied,
   * emits secret-free `session.rotate` / `session.revoke` / `session.reuse`
   * audit lines (never the refresh-token bytes). Metrics default to a no-op.
   */
  observability?: AuthObservability;
  /** Optional rate-limit gate applied before every `rotate`. */
  rateLimit?: RateLimitHook;
}

const SessionManagerOptionsSchema = z.object({
  refreshTtlSeconds: z.number().int().positive().optional(),
  onReuse: z
    .custom<SessionManagerOptions["onReuse"]>(
      (v) => v === undefined || typeof v === "function",
      "onReuse must be a function",
    )
    .optional(),
  observability: z.custom<AuthObservability>().optional(),
  rateLimit: z
    .custom<RateLimitHook>(
      (v) => v === undefined || typeof v === "function",
      "rateLimit must be a function",
    )
    .optional(),
});

/**
 * Creates a session manager for access + refresh token pairs.
 *
 * - Issues short-lived access tokens (via the auth engine) and long-lived,
 *   opaque refresh tokens (only their SHA-256 hash is persisted).
 * - Rotates refresh tokens atomically; a replayed rotated token trips
 *   **reuse detection** and revokes the entire token family.
 * - Refresh TTL slides forward on every rotation.
 * - Supports single-session and bulk (all-devices) revocation.
 *
 * @example
 * ```ts
 * const sessions = createSessionManager(auth, redisStore, {
 *   onReuse: (e) => logger.warn("refresh reuse", e),
 * });
 *
 * const { accessToken, refreshToken } = await sessions.issue(userId, userPayload);
 * const rotated = await sessions.rotate(refreshToken, userPayload);
 * await sessions.revokeAll(userId); // logout everywhere
 * ```
 */
export function createSessionManager<Schema extends z.ZodTypeAny>(
  auth: TokenSigner<Schema>,
  store: SessionStore,
  optionsOrTtl: SessionManagerOptions | number = {},
) {
  // Back-compat: the 3rd arg used to be a bare `refreshTtlSeconds` number.
  const options: SessionManagerOptions =
    typeof optionsOrTtl === "number" ? { refreshTtlSeconds: optionsOrTtl } : optionsOrTtl;
  parseAuthConfig("createSessionManager", SessionManagerOptionsSchema, options);
  const refreshTtlSeconds = options.refreshTtlSeconds ?? 604800; // 7 days
  const audit = createAuditor(options.observability);
  const rateLimit = options.rateLimit;

  const issue = async (userId: string, payload: z.infer<Schema>) => {
    const accessToken = await auth.sign(payload);
    const refreshToken = crypto.randomUUID();
    await store.issue(refreshToken, userId, refreshTtlSeconds);
    return { accessToken, refreshToken };
  };

  return {
    issue,

    rotate: async (oldRefreshToken: string, newPayload: z.infer<Schema>) => {
      await enforceRateLimit(rateLimit, { operation: "rotate" });
      const newRefreshToken = crypto.randomUUID();
      const result = await store.rotate(oldRefreshToken, newRefreshToken, refreshTtlSeconds);

      if (result.status === "reuse") {
        // Both sinks receive the secret-free event: the legacy `onReuse` hook
        // and the structured audit trail. Never carries the token bytes.
        options.onReuse?.({
          type: "refresh_reuse",
          userId: result.userId,
          familyId: result.familyId,
          at: Date.now(),
        });
        audit.record({
          type: "session.reuse",
          outcome: "failure",
          userId: result.userId,
          familyId: result.familyId,
          reason: "refresh_reuse",
        });
        throw new RefreshTokenReuseError(result.userId, result.familyId);
      }
      if (result.status !== "ok") {
        throw new Error("Invalid or expired refresh token");
      }

      // Family verified + rotated atomically; only now mint the access token.
      const accessToken = await auth.sign(newPayload);
      audit.record({
        type: "session.rotate",
        outcome: "success",
        userId: result.userId,
        familyId: result.familyId,
      });
      return { accessToken, refreshToken: newRefreshToken };
    },

    /** Resolve a refresh token to its user without rotating (returns null if stale/revoked). */
    verify: async (refreshToken: string): Promise<string | null> => {
      const record = await store.lookup(refreshToken);
      return record?.userId ?? null;
    },

    /** Revoke the single session (family) owning this refresh token. */
    revoke: async (refreshToken: string) => {
      await store.revoke(refreshToken);
      audit.record({ type: "session.revoke", outcome: "success" });
    },

    revokeAll: async (userId: string) => {
      await store.revokeAllForUser(userId);
      audit.record({ type: "session.revoke", outcome: "success", userId });
    },
  };
}
