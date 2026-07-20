import { describe, it, expect } from "vitest";
import { HttpException } from "@nuraljs/core";
import {
  AuthError,
  isAuthError,
  TokenInvalidError,
  TokenExpiredError,
  TokenNotYetValidError,
  TokenRevokedError,
  InvalidStateError,
  OAuthExchangeError,
  AuthConfigError,
  RateLimitError,
  type AuthErrorCode,
} from "./errors";

// Each entry: the class, its expected HTTP status, and its stable code.
const CASES: Array<[new (m?: string) => AuthError, number, AuthErrorCode]> = [
  [TokenInvalidError, 401, "token_invalid"],
  [TokenExpiredError, 401, "token_expired"],
  [TokenNotYetValidError, 401, "token_not_yet_valid"],
  [TokenRevokedError, 401, "token_revoked"],
  [InvalidStateError, 400, "invalid_state"],
  [OAuthExchangeError, 401, "oauth_exchange_failed"],
  [AuthConfigError, 500, "auth_config_invalid"],
  [RateLimitError, 429, "rate_limited"],
];

describe("typed error taxonomy", () => {
  it.each(CASES)("%s carries the right statusCode + code", (Ctor, status, code) => {
    const err = new Ctor("boom");

    // Extends the core HttpException hierarchy (renders as a real HTTP error).
    expect(err).toBeInstanceOf(HttpException);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(Ctor);
    expect(err).toBeInstanceOf(Error);

    expect(err.statusCode).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).toBe("boom");
    expect(err.name).toBe(Ctor.name);
  });

  it("isAuthError narrows only AuthError instances", () => {
    expect(isAuthError(new TokenExpiredError())).toBe(true);
    expect(isAuthError(new Error("plain"))).toBe(false);
    expect(isAuthError("nope")).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("is programmatically distinguishable by class AND by code", () => {
    const err: unknown = new TokenRevokedError();
    // by class
    expect(err instanceof TokenRevokedError).toBe(true);
    // by code (survives message changes / minification)
    expect(isAuthError(err) && err.code === "token_revoked").toBe(true);
  });

  it("each class has sensible non-secret default messages", () => {
    expect(new TokenExpiredError().message).toBe("Token expired");
    expect(new InvalidStateError().message).toBe("OAuth state verification failed");
    expect(new RateLimitError().message).toBe("Rate limit exceeded");
  });
});
