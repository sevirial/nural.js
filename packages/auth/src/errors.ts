// ──────────────────────────────────────────────────────────────────────────
// @nuraljs/auth — Typed error taxonomy (Sprint 6, T6.3)
//
// Every auth failure is a subclass of core's `HttpException`, so it carries the
// right HTTP `statusCode` (a `nuraljs` error handler renders it directly) AND a
// stable, machine-readable `code` for programmatic branching. Callers can:
//   • `catch (e) { if (e instanceof TokenExpiredError) … }`  — by class, or
//   • `catch (e) { if (isAuthError(e) && e.code === "token_expired") … }` — by code.
//
// Messages are deliberately non-secret: they never contain token bytes, key
// material, or the parsed config value (Zod issue messages describe the failing
// path, not the input). See `observability.ts` for the audit-logging layer that
// records these events without leaking secrets.
// ──────────────────────────────────────────────────────────────────────────

import { HttpException } from "@nuraljs/core";

/** Stable, machine-readable discriminator carried by every {@link AuthError}. */
export type AuthErrorCode =
  | "token_invalid"
  | "token_expired"
  | "token_not_yet_valid"
  | "token_revoked"
  | "invalid_state"
  | "oauth_exchange_failed"
  | "auth_config_invalid"
  | "rate_limited";

/**
 * Base class for every `@nuraljs/auth` error. Extends core `HttpException`
 * (so it renders as a proper HTTP error through a `nuraljs` route) and adds a
 * stable {@link AuthErrorCode} for programmatic distinction independent of the
 * human-readable message.
 */
export class AuthError extends HttpException {
  /** Stable, machine-readable error discriminator. */
  public readonly code: AuthErrorCode;

  constructor(
    code: AuthErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message, statusCode, details);
    this.code = code;
    // Give each subclass its own `.name` (HttpException sets the prototype
    // chain; we set the name for readable stacks / logs).
    this.name = new.target.name;
  }
}

/** Type guard — narrows an unknown thrown value to an {@link AuthError}. */
export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError;
}

// ── Token errors (401) ────────────────────────────────────────────────────

/**
 * A token failed verification for a structural/cryptographic reason that is not
 * one of the more specific cases below — too short, unsupported version byte,
 * unknown key id, bad AEAD tag (tampered/forged/corrupt), or a missing/invalid
 * claim. The generic "invalid token" bucket.
 */
export class TokenInvalidError extends AuthError {
  constructor(message = "Invalid token", details?: unknown) {
    super("token_invalid", message, 401, details);
  }
}

/** The token's `exp` has passed (beyond the configured clock-skew tolerance). */
export class TokenExpiredError extends AuthError {
  constructor(message = "Token expired", details?: unknown) {
    super("token_expired", message, 401, details);
  }
}

/** The token's `nbf` is in the future — it is not valid yet. */
export class TokenNotYetValidError extends AuthError {
  constructor(message = "Token not yet valid", details?: unknown) {
    super("token_not_yet_valid", message, 401, details);
  }
}

/** The token's `jti` was reported revoked by the configured revocation hook. */
export class TokenRevokedError extends AuthError {
  constructor(message = "Token revoked", details?: unknown) {
    super("token_revoked", message, 401, details);
  }
}

// ── OAuth / OIDC errors ─────────────────────────────────────────────────────

/**
 * The OAuth `state` returned on the callback did not match the one issued before
 * the redirect (or none was issued/returned). A CSRF / mix-up defence — 400.
 */
export class InvalidStateError extends AuthError {
  constructor(message = "OAuth state verification failed", details?: unknown) {
    super("invalid_state", message, 400, details);
  }
}

/**
 * An OAuth/OIDC authorization-code exchange failed — the provider returned an
 * error, an unusable token response, or an unverifiable identity. 401.
 */
export class OAuthExchangeError extends AuthError {
  constructor(message = "OAuth code exchange failed", details?: unknown) {
    super("oauth_exchange_failed", message, 401, details);
  }
}

// ── Configuration & rate limiting ───────────────────────────────────────────

/**
 * A `createX` factory was called with invalid configuration (caught by Zod
 * validation at construction). A programmer error surfaced as 500 — never
 * echoes the offending value.
 */
export class AuthConfigError extends AuthError {
  constructor(message = "Invalid auth configuration", details?: unknown) {
    super("auth_config_invalid", message, 500, details);
  }
}

/**
 * A configured rate-limit hook rejected the operation (verify / exchange /
 * rotate). 429 — the caller should back off.
 */
export class RateLimitError extends AuthError {
  constructor(message = "Rate limit exceeded", details?: unknown) {
    super("rate_limited", message, 429, details);
  }
}
