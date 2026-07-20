import { defineMiddleware, UnauthorizedException } from "@nuraljs/core";
import { z } from "zod";
import { createBinaryTokenEngine } from "./token/binary-token-engine";
import type { BinaryTokenEngineOptions } from "./token/binary-token-engine";
import type { AuthProvider } from "./providers/types";
import { isAuthError, type AuthErrorCode } from "./errors";
import { parseAuthConfig } from "./config";
import {
  createAuditor,
  enforceRateLimit,
  type AuthObservability,
  type RateLimitHook,
} from "./observability";

// ──────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────

export interface AuthConfig<Schema extends z.ZodTypeAny> {
  strategy: BinaryTokenEngineOptions<Schema>;
  providers?: AuthProvider[];
  /**
   * Optional observability wiring (Sprint 6). When a `logger` is supplied,
   * `createAuth` writes secret-free structured audit lines for `token.sign`
   * (success) and `token.verify_fail`. `metrics` (OpenTelemetry-style counters)
   * default to a no-op. Omit entirely for silent operation.
   */
  observability?: AuthObservability;
  /**
   * Optional rate-limit gate applied before every `verify` (and the guard).
   * Throw a `RateLimitError` (or return `false`) from the hook to reject.
   */
  rateLimit?: RateLimitHook;
}

// ──────────────────────────────────────────────────────────────────
// Config validation (T6.4) — reject a misconfigured factory at construction
// with a typed `AuthConfigError`, never echoing secrets/key material.
// ──────────────────────────────────────────────────────────────────

const isZodSchema = (v: unknown): boolean =>
  typeof v === "object" && v !== null && typeof (v as { parse?: unknown }).parse === "function";

const isKeyProvider = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as { getPrimaryKey?: unknown; getKey?: unknown };
  return typeof p.getPrimaryKey === "function" && typeof p.getKey === "function";
};

const StrategySchema = z.object({
  schema: z.custom<unknown>(isZodSchema, "strategy.schema must be a Zod schema"),
  keyProvider: z.custom<unknown>(
    isKeyProvider,
    "strategy.keyProvider must implement getPrimaryKey() and getKey()",
  ),
  expiresInSeconds: z.number().int().positive().optional(),
  clockToleranceSeconds: z.number().int().nonnegative().optional(),
  notBeforeSeconds: z.number().int().nonnegative().optional(),
  issuer: z.string().optional(),
  audience: z.string().optional(),
  isRevoked: z
    .custom<unknown>((v) => v === undefined || typeof v === "function", "isRevoked must be a function")
    .optional(),
});

const AuthConfigSchema = z.object({
  // The strategy is validated structurally (its non-serializable members —
  // schema/keyProvider — are checked by predicate, not re-parsed).
  strategy: StrategySchema.passthrough(),
  providers: z.array(z.custom<AuthProvider>()).optional(),
  observability: z.custom<AuthObservability>().optional(),
  rateLimit: z
    .custom<RateLimitHook>((v) => v === undefined || typeof v === "function", "rateLimit must be a function")
    .optional(),
});

/**
 * The Nuraljs middleware produced by `createAuth`. It runs on core's
 * `preValidation` hook (auth-before-validation) and, on success, returns
 * `{ user }` — which core merges onto the route context, exposing the typed
 * payload at `ctx.user`. Mirrors core's (unexported) `MiddlewareHandler` shape.
 */
export type AuthGuard<Schema extends z.ZodTypeAny> = (
  req: unknown,
  res: unknown,
) => Promise<{ user: z.infer<Schema> }> | { user: z.infer<Schema> };

// ──────────────────────────────────────────────────────────────────
// Return type — the public surface of createAuth()
// ──────────────────────────────────────────────────────────────────

export interface NuraljsAuth<Schema extends z.ZodTypeAny> {
  /** The underlying binary token engine (for advanced usage). */
  readonly engine: ReturnType<typeof createBinaryTokenEngine<Schema>>;

  /** A Nuraljs middleware that extracts and injects the user at `ctx.user`. */
  readonly guard: AuthGuard<Schema>;

  /** Signs a payload into an encrypted binary token. */
  sign(payload: z.infer<Schema>): Promise<string>;

  /** Verifies and decrypts a binary token, returning the typed payload. */
  verify(token: string): Promise<z.infer<Schema>>;

  /** Retrieves a registered OAuth provider by name. */
  getProvider(name: string): AuthProvider;
}

// ──────────────────────────────────────────────────────────────────
// Factory — pure functional, zero classes
// ──────────────────────────────────────────────────────────────────

/**
 * Creates the NuralJS authentication module.
 *
 * Zero classes. Returns a plain object with `sign`, `verify`, `guard`,
 * and provider lookup — everything you need for token-based auth.
 *
 * @example
 * ```ts
 * import { createAuth, createStaticKeyProvider } from "@nuraljs/auth";
 * import { z } from "zod";
 *
 * const UserSchema = z.object({
 *   id: z.string(),
 *   role: z.enum(["admin", "user"]),
 * });
 *
 * const auth = createAuth({
 *   strategy: {
 *     schema: UserSchema,
 *     keyProvider: createStaticKeyProvider(process.env.AUTH_SECRET!),
 *     expiresInSeconds: 900,
 *   },
 * });
 *
 * // Sign a token
 * const token = await auth.sign({ id: "user_123", role: "admin" });
 *
 * // Verify a token
 * const user = await auth.verify(token);
 *
 * // Use as Nuraljs middleware (runs before validation)
 * app.get("/protected", { middleware: [auth.guard] }, (ctx) => {
 *   const user = ctx.user; // Fully typed!
 * });
 * ```
 */
export function createAuth<Schema extends z.ZodTypeAny>(
  config: AuthConfig<Schema>
): NuraljsAuth<Schema> {
  // Validate the factory config up front — a misconfigured auth module fails
  // loudly at boot with a typed `AuthConfigError`, never at first request.
  parseAuthConfig("createAuth", AuthConfigSchema, config);

  const engine = createBinaryTokenEngine<Schema>(config.strategy);
  const audit = createAuditor(config.observability);
  const rateLimit = config.rateLimit;

  // Register OAuth providers
  const providers = new Map<string, AuthProvider>();
  if (config.providers) {
    for (const p of config.providers) {
      providers.set(p.name, p);
    }
  }

  // Best-effort, non-secret subject id for the audit trail: the conventional
  // `id`/`sub` field when it's a string. Never logs the whole payload.
  const subjectOf = (payload: unknown): string | undefined => {
    if (payload && typeof payload === "object") {
      const p = payload as Record<string, unknown>;
      if (typeof p["id"] === "string") return p["id"];
      if (typeof p["sub"] === "string") return p["sub"];
    }
    return undefined;
  };

  const sign = async (payload: z.infer<Schema>): Promise<string> => {
    const token = await engine.sign(payload);
    audit.record({
      type: "token.sign",
      outcome: "success",
      userId: subjectOf(payload),
    });
    return token;
  };

  // Wrapped verify: optional rate-limit gate, then decrypt; on ANY failure,
  // emit a secret-free `token.verify_fail` audit event (reason = the typed
  // error code, or "token_invalid") and rethrow the typed error unchanged.
  const verify = async (token: string): Promise<z.infer<Schema>> => {
    await enforceRateLimit(rateLimit, { operation: "verify" });
    try {
      return await engine.verify(token);
    } catch (error: unknown) {
      const reason: AuthErrorCode = isAuthError(error) ? error.code : "token_invalid";
      audit.record({ type: "token.verify_fail", outcome: "failure", reason });
      throw error;
    }
  };

  // Build the Nuraljs middleware — decrypts the Bearer token and returns the
  // typed user payload. Core merges the returned record onto the route
  // context (`preValidation`), so the handler reads it at `ctx.user`. Throwing
  // here yields a 401 *before* body validation, preserving auth-before-validation.
  const guard: AuthGuard<Schema> = defineMiddleware(
    async (req: unknown) => {
      const headers = (req as { headers?: Record<string, string | undefined> }).headers;
      const authHeader = headers?.["authorization"];

      if (!authHeader || typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        audit.record({ type: "token.verify_fail", outcome: "failure", reason: "missing_bearer" });
        throw new UnauthorizedException("Missing Bearer Token");
      }

      const token = authHeader.slice("Bearer ".length);
      if (!token) {
        audit.record({ type: "token.verify_fail", outcome: "failure", reason: "malformed_bearer" });
        throw new UnauthorizedException("Malformed Bearer Token");
      }

      // `verify` already audits + rate-limits. A typed AuthError is already a
      // proper 401 (and programmatically distinguishable), so propagate it as-is;
      // wrap only a truly unexpected non-Error value.
      try {
        const user = await verify(token);
        return { user };
      } catch (error: unknown) {
        if (isAuthError(error) || error instanceof UnauthorizedException) throw error;
        const message = error instanceof Error ? error.message : "Invalid Token";
        throw new UnauthorizedException(message);
      }
    },
  );

  return {
    engine,
    guard,
    sign,
    verify,
    getProvider: (name) => {
      const p = providers.get(name);
      if (!p) throw new Error(`Provider '${name}' is not registered`);
      return p;
    },
  };
}
