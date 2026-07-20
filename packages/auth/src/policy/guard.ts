// ──────────────────────────────────────────────────────────────────
// NuralJS Policy Guard — Authorization Middleware (RBAC/ABAC → 403)
// ──────────────────────────────────────────────────────────────────
// Bridges the pure policy engine (`./engine`) to core's middleware pipeline.
// `requirePolicy` runs as a Nuraljs `preValidation` middleware *after* the auth
// guard: it reads the authenticated user the guard stashed at `ctx.user`
// (Sprint 0 contract) and throws core's `ForbiddenException` (403) on deny.

import { defineMiddleware, ForbiddenException } from "@nuraljs/core";
import type { PolicyFn } from "./engine";

/**
 * The context object handed to a policy as its second argument when evaluated by
 * `requirePolicy`. Built from the *raw* (pre-validation) request so ABAC checks
 * — e.g. resource-owner (`user.id === ctx.params.userId`) — can read the route's
 * params/query/body. These values are unvalidated at `preValidation` time, so a
 * policy must treat them as untrusted input.
 */
export interface PolicyContext {
  params: unknown;
  query: unknown;
  body: unknown;
}

/** Options for `requirePolicy`. */
export interface RequirePolicyOptions {
  /**
   * Key on the middleware context bag where the authenticated user lives.
   * Defaults to `"user"` — the key `createAuth().guard` writes (Sprint 0).
   */
  userKey?: string;
  /**
   * Observability hook fired on every deny (missing user *or* policy → false),
   * carrying a non-secret `reason`. The client still receives a generic 403;
   * this is where Sprint 6 audit logging plugs in. Never receives the user or
   * token bytes.
   */
  onDeny?: (info: { reason: string }) => void;
}

/**
 * Builds a Nuraljs middleware that authorizes the request against `policy`.
 *
 * Order matters: `requirePolicy` must run **after** an auth guard that populates
 * `ctx.user`. In core's `preValidation` pipeline each middleware's returned
 * object is merged onto a single per-request context bag before the next runs,
 * so listing `[auth.guard, requirePolicy(...)]` on a route makes the user
 * available here. If no user is present, this fails closed with a 403 (an
 * unauthenticated request should never reach an authorization check).
 *
 * @example
 * ```ts
 * import { createAuth, requirePolicy, hasRole } from "@nuraljs/auth";
 *
 * const auth = createAuth({ ... });
 * const isAdmin = hasRole("admin");
 *
 * app.get("/admin", { middleware: [auth.guard, requirePolicy(isAdmin)] }, (ctx) => {
 *   // only reached when the user has the "admin" role
 * });
 * ```
 */
export function requirePolicy<U = unknown, C = PolicyContext>(
  policy: PolicyFn<U, C>,
  options: RequirePolicyOptions = {},
) {
  const userKey = options.userKey ?? "user";
  const onDeny = options.onDeny;

  return defineMiddleware(async (req: unknown) => {
    const r = req as {
      nuralCtx?: Record<string, unknown>;
      params?: unknown;
      query?: unknown;
      body?: unknown;
    };

    // The user is stashed on the per-request context bag by the upstream auth
    // guard. Absence ⇒ requirePolicy ran without (or before) authentication.
    const user = r.nuralCtx?.[userKey];
    if (user === undefined || user === null) {
      onDeny?.({
        reason:
          `requirePolicy: no authenticated user at ctx.${userKey} — an auth ` +
          `guard (createAuth().guard) must run before requirePolicy`,
      });
      throw new ForbiddenException("Access denied");
    }

    const ctx = {
      params: r.params,
      query: r.query,
      body: r.body,
    } as C;

    const allowed = await policy(user as U, ctx);
    if (!allowed) {
      onDeny?.({ reason: "requirePolicy: policy evaluated to false" });
      throw new ForbiddenException("Access denied");
    }

    // Allowed: nothing to merge onto the context bag — the user is already there.
  });
}
