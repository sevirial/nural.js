// ──────────────────────────────────────────────────────────────────
// @nuraljs/auth — Zero-Class, Schema-First Authentication
// ──────────────────────────────────────────────────────────────────

// === Core ===
export { createAuth } from "./auth";
export type { AuthConfig, NuraljsAuth, AuthGuard } from "./auth";

// === Typed Error Taxonomy (extends core HttpException) ===
export {
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
} from "./errors";
export type { AuthErrorCode } from "./errors";

// === Observability (audit logging · metrics · rate-limit hooks) ===
export { createAuditor, noopMetrics, enforceRateLimit } from "./observability";
export type {
  AuthLogger,
  AuthMetrics,
  AuthAuditEvent,
  AuthAuditType,
  AuthObservability,
  Auditor,
  RateLimitHook,
  RateLimitInfo,
  RateLimitOperation,
} from "./observability";

// === Config validation helper (for custom factories) ===
export { parseAuthConfig } from "./config";

// === Token Engine ===
export { createBinaryTokenEngine, DEFAULT_MAX_TOKEN_BYTES } from "./token/binary-token-engine";
export type { BinaryTokenEngineOptions } from "./token/binary-token-engine";

// === Token Inspector (observability — the secure jwt.io equivalent) ===
export { inspectTokenHeader, decodeToken } from "./token/inspect";
export type {
  TokenHeader,
  DecodeTokenOptions,
  DecodedToken,
  TokenTemporal,
} from "./token/inspect";

// === OAuth Providers ===
export { createGoogleProvider } from "./providers/google";
export { createGithubProvider } from "./providers/github";
export { createOIDCProvider } from "./providers/oidc";
export type {
  AuthProvider,
  OAuthProfile,
  AuthorizeParams,
  ExchangeParams,
} from "./providers/types";
export type { GoogleConfig } from "./providers/google";
export type { GithubConfig } from "./providers/github";
export type { OIDCConfig } from "./providers/oidc";

// === OAuth helpers (state / nonce / PKCE) ===
export { createState, createNonce, createPkcePair, verifyState } from "./providers/pkce";
export type { PkcePair } from "./providers/pkce";
export { httpJson } from "./providers/http";
export type { HttpJsonOptions } from "./providers/http";
export { createJwksVerifier } from "./providers/jwks";
export type {
  JwksVerifier,
  JwksVerifierOptions,
  IdTokenClaims,
  VerifyIdTokenParams,
} from "./providers/jwks";

// === Key Management (3 tiers) ===
export { createStaticKeyProvider } from "./kms/static-provider";
export { createLocalKeyProvider } from "./kms/local-provider";
export { createCloudKeyProvider } from "./kms/cloud-provider";
export type {
  KeyProvider,
  NuraljsAuthKey,
  CloudProviderOptions,
  CloudKeyProvider,
  KmsLogger,
} from "./kms/types";
export type { LocalKeyConfig } from "./kms/local-provider";
export {
  MIN_SECRET_LENGTH_HARD,
  SECRET_LENGTH_RECOMMENDED,
  SHORT_SECRET_WARNING_CODE,
} from "./kms/limits";

// === Session Management ===
export { createSessionManager, RefreshTokenReuseError } from "./session/session-manager";
export type { SessionManagerOptions, SessionReuseEvent } from "./session/session-manager";
export { createRedisSessionStore } from "./session/redis-store";
export type {
  SessionStore,
  MinimalRedisClient,
  SessionRecord,
  RotateResult,
  RotateStatus,
  RedisSessionStoreOptions,
} from "./session/types";

// === Policy Engine (RBAC + ABAC) ===
export {
  definePolicy,
  requireAll,
  requireAny,
  requireNone,
  hasRole,
  hasAnyRole,
  hasPermission,
  hasAnyPermission,
  PolicyDenied,
  isStringArray,
  defaultRoleAccessor,
  defaultPermissionAccessor,
} from "./policy/engine";
export type { PolicyFn } from "./policy/engine";

// === Authorization Guard (policy → ForbiddenException) ===
export { requirePolicy } from "./policy/guard";
export type { PolicyContext, RequirePolicyOptions } from "./policy/guard";
