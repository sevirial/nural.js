// ──────────────────────────────────────────────────────────────────────────
// @nuraljs/auth — Observability: audit logging, metrics, rate-limit hooks
// (Sprint 6, T6.1 / T6.2 / T6.5)
//
// Auth is a security surface: sign / verify-fail / rotate / revoke / OAuth
// exchange must be *auditable*, but the audit trail must NEVER contain secrets —
// no token bytes, no key material, no client secrets, no raw refresh tokens.
// This module centralizes that guarantee: `createAuditor` serializes ONLY an
// allow-listed set of non-secret fields, so a caller can never accidentally
// widen the log surface by stuffing extra data into an event.
//
// Everything here is optional and defaults to a no-op — auth works with zero
// observability wiring, and telemetry is opt-in behind interfaces so we pull in
// no OpenTelemetry (or any) dependency by default.
// ──────────────────────────────────────────────────────────────────────────

import { RateLimitError } from "./errors";

// ── Logging ─────────────────────────────────────────────────────────────────

/**
 * Minimal structural logger — satisfied by the core `nuraljs` `Logger`. Kept
 * structural so any logger (or a silent test spy) can be supplied without a
 * hard dependency on a concrete class.
 */
export interface AuthLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string, trace?: string): void;
  debug(message: string): void;
}

// ── Metrics (optional OpenTelemetry-style counters; no-op by default) ────────

/**
 * A counter sink for auth events. Bridge this to OpenTelemetry (or StatsD,
 * Prometheus, …) by implementing `increment`. Behind a no-op default, so metrics
 * cost nothing until wired.
 */
export interface AuthMetrics {
  /**
   * Record one occurrence of `event` (e.g. `"token.sign.success"`), optionally
   * tagged with low-cardinality, **non-secret** attributes (provider, reason).
   */
  increment(event: string, attributes?: Record<string, string | number>): void;
}

/** The default metrics sink — does nothing. */
export const noopMetrics: AuthMetrics = { increment: () => {} };

// ── Audit events ─────────────────────────────────────────────────────────────

/** The auditable auth operations. */
export type AuthAuditType =
  | "token.sign"
  | "token.verify_fail"
  | "session.rotate"
  | "session.revoke"
  | "session.reuse"
  | "oauth.exchange";

/**
 * A structured audit event. **Only the fields declared here are ever logged** —
 * every value is a non-secret identifier or category:
 *   • `userId`   — a subject id, not a credential.
 *   • `jti`      — the token's opaque UUID id, not the token bytes.
 *   • `familyId` — a session-family UUID.
 *   • `provider` — an OAuth provider name ("github"/"google"/"oidc").
 *   • `reason`   — a non-secret failure category (typically an {@link import("./errors").AuthErrorCode}).
 * There is deliberately no field for token bytes, secrets, or key material.
 */
export interface AuthAuditEvent {
  type: AuthAuditType;
  outcome: "success" | "failure";
  userId?: string;
  jti?: string;
  familyId?: string;
  provider?: string;
  reason?: string;
  /** Epoch milliseconds. Stamped by {@link createAuditor} when omitted. */
  at?: number;
}

/** The exact, fixed set of keys serialized into a log line — the allow-list. */
const SAFE_AUDIT_KEYS: readonly (keyof AuthAuditEvent)[] = [
  "type",
  "outcome",
  "userId",
  "jti",
  "familyId",
  "provider",
  "reason",
  "at",
];

/**
 * Observability wiring passed to the auth factories. All optional.
 */
export interface AuthObservability {
  /** Structured logger for the audit trail (e.g. a core `nuraljs` `Logger`). */
  logger?: AuthLogger;
  /** Optional counter sink (OpenTelemetry etc.). Defaults to a no-op. */
  metrics?: AuthMetrics;
  /**
   * Additional audit sink invoked with the (secret-free) event — e.g. a SIEM
   * forwarder or an in-app security-event store. Runs in addition to the logger.
   */
  onAudit?: (event: AuthAuditEvent) => void;
}

/** Records audit events to a logger + metrics + sink, secret-free. */
export interface Auditor {
  record(event: AuthAuditEvent): void;
}

/**
 * Builds an {@link Auditor} from optional observability wiring.
 *
 * The returned `record` is defensive: it copies **only** the allow-listed
 * {@link SAFE_AUDIT_KEYS} into the serialized line, so no caller can smuggle a
 * secret into the audit trail by attaching extra properties to the event object.
 * A `success` outcome logs at `log` level, a `failure` at `warn`.
 */
export function createAuditor(obs: AuthObservability = {}): Auditor {
  const metrics = obs.metrics ?? noopMetrics;
  const logger = obs.logger;
  const onAudit = obs.onAudit;

  return {
    record(event: AuthAuditEvent): void {
      const at = event.at ?? Date.now();

      // Build the log payload from the fixed allow-list ONLY. Even if `event`
      // carried extra keys, they are never serialized.
      const safe: Record<string, unknown> = {};
      for (const key of SAFE_AUDIT_KEYS) {
        const value = key === "at" ? at : event[key];
        if (value !== undefined) safe[key] = value;
      }

      if (logger) {
        const line = `auth.audit ${JSON.stringify(safe)}`;
        if (event.outcome === "failure") logger.warn(line);
        else logger.log(line);
      }

      metrics.increment(`${event.type}.${event.outcome}`, {
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
      });

      if (onAudit) onAudit({ ...event, at });
    },
  };
}

// ── Rate limiting (optional hooks) ───────────────────────────────────────────

/** The rate-limited auth operations. */
export type RateLimitOperation = "verify" | "exchange" | "rotate";

/** Context handed to a {@link RateLimitHook}. Carries no secrets. */
export interface RateLimitInfo {
  operation: RateLimitOperation;
  /** OAuth provider name, when the operation is an exchange. */
  provider?: string;
}

/**
 * A pluggable rate-limit gate. Invoked before the guarded operation runs.
 * **Throw to deny** — throw a {@link RateLimitError} (or return `false`) to
 * reject the operation; return `void`/`true` to allow. Defaults to unset (no
 * limiting). Async is supported (e.g. a Redis token-bucket check).
 */
export type RateLimitHook = (
  info: RateLimitInfo,
) => void | boolean | Promise<void | boolean>;

/**
 * Enforces an optional rate-limit hook. A no-op when `hook` is undefined; when
 * the hook returns `false` a {@link RateLimitError} is thrown; a hook that
 * throws propagates its own error unchanged.
 */
export async function enforceRateLimit(
  hook: RateLimitHook | undefined,
  info: RateLimitInfo,
): Promise<void> {
  if (!hook) return;
  const allowed = await hook(info);
  if (allowed === false) {
    throw new RateLimitError(`Rate limit exceeded for ${info.operation}`);
  }
}
