/**
 * Minimal Redis client interface.
 *
 * The refresh-session store performs every multi-key mutation as a single
 * server-side Lua script so the operation is **atomic** (Redis executes a
 * script uninterrupted). All the store needs from the client is `eval`; both
 * `ioredis` and `redis` satisfy this shape.
 *
 * NOTE (Sprint 3): the previous granular surface (`set`/`get`/`del`/`sadd`/…)
 * was removed — the store no longer issues non-atomic multi-step commands.
 * Real clients still satisfy the new shape (they all expose `eval`); this only
 * affects hand-rolled mocks. See the Sprint 3 handoff in Task.md.
 */
export interface MinimalRedisClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * A resolved refresh-session record — the owning user and its token family.
 */
export interface SessionRecord {
  userId: string;
  familyId: string;
}

/**
 * Outcome of an atomic refresh-token rotation.
 *
 * - `ok`      — the presented token was the family's current token; a new token
 *               was issued and the old one consumed.
 * - `invalid` — the token is unknown/expired (no family), reject.
 * - `revoked` — the family was already revoked (e.g. logout), reject.
 * - `reuse`   — the token belongs to a live family but is **not** its current
 *               token, i.e. an already-rotated token was replayed. The whole
 *               family is revoked as a compromise signal; the caller should
 *               emit an audit event.
 */
export type RotateStatus = "ok" | "invalid" | "revoked" | "reuse";

export interface RotateResult {
  status: RotateStatus;
  /** Present for `ok` / `reuse` / `revoked`. */
  userId?: string;
  /** Present for `ok` / `reuse` / `revoked`. */
  familyId?: string;
}

/**
 * Session store interface for refresh-token management.
 *
 * Implementations MUST persist only a **hash** of the refresh token, never the
 * raw value, and MUST perform `issue`/`rotate`/`revoke` atomically. Implement
 * this to use a custom backend (Redis, Postgres, DynamoDB, …).
 */
export interface SessionStore {
  /**
   * Persist a brand-new refresh token as the head of a **new token family**.
   * Returns the generated `familyId`. Enforces the optional per-user session
   * cap and prunes expired members.
   */
  issue(refreshToken: string, userId: string, ttlSeconds: number): Promise<{ familyId: string }>;

  /**
   * Atomically rotate `oldRefreshToken` → `newRefreshToken` within its family.
   * See {@link RotateResult} for the possible outcomes (including reuse
   * detection, which revokes the family).
   */
  rotate(
    oldRefreshToken: string,
    newRefreshToken: string,
    ttlSeconds: number,
  ): Promise<RotateResult>;

  /**
   * Resolve a refresh token to its session **only if** it is the current token
   * of a live (non-revoked) family. Returns `null` otherwise. Does not rotate.
   */
  lookup(refreshToken: string): Promise<SessionRecord | null>;

  /** Revoke the single family that owns `refreshToken` (one logout). */
  revoke(refreshToken: string): Promise<void>;

  /** Revoke every family for a user (logout everywhere). */
  revokeAllForUser(userId: string): Promise<void>;
}

/**
 * Options for {@link createRedisSessionStore}.
 */
export interface RedisSessionStoreOptions {
  /**
   * Maximum concurrent refresh-token families (≈ devices) per user. When a new
   * session would exceed the cap, the oldest families are evicted atomically.
   * `0` (default) means unlimited.
   */
  maxSessionsPerUser?: number;
  /**
   * Clock injection point (ms since epoch). Defaults to `Date.now`. Primarily
   * for deterministic tests of member expiry / sliding TTL.
   */
  now?: () => number;
}
