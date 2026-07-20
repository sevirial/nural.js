// ──────────────────────────────────────────────────────────────────
// NuralJS Policy Engine — Purely Functional RBAC + ABAC
// ──────────────────────────────────────────────────────────────────
// U = Typed User (from Zod schema)
// C = Route Context (params, body, query, etc.)

/**
 * A policy function that evaluates whether a user can perform an action.
 * Returns `true` to allow, `false` to deny.
 */
export type PolicyFn<U, C> = (user: U, ctx: C) => boolean | Promise<boolean>;

// ──────────────────────────────────────────────────────────────────
// Core Combinators
// ──────────────────────────────────────────────────────────────────

/**
 * Defines a type-safe policy function.
 *
 * @example
 * ```ts
 * const isResourceOwner = definePolicy<User, Ctx>(
 *   (user, ctx) => user.id === ctx.params.userId
 * );
 * ```
 */
export function definePolicy<U, C>(fn: PolicyFn<U, C>): PolicyFn<U, C> {
  return fn;
}

/**
 * AND combinator — ALL policies must pass.
 *
 * @example
 * ```ts
 * const canEdit = requireAll(isAuthenticated, isResourceOwner);
 * ```
 */
export function requireAll<U, C>(...policies: PolicyFn<U, C>[]): PolicyFn<U, C> {
  return async (user, ctx) => {
    for (const policy of policies) {
      if (!(await policy(user, ctx))) return false;
    }
    return true;
  };
}

/**
 * OR combinator — at least ONE policy must pass.
 *
 * @example
 * ```ts
 * const canView = requireAny(isAdmin, isResourceOwner);
 * ```
 */
export function requireAny<U, C>(...policies: PolicyFn<U, C>[]): PolicyFn<U, C> {
  return async (user, ctx) => {
    for (const policy of policies) {
      if (await policy(user, ctx)) return true;
    }
    return false;
  };
}

/**
 * DENY combinator — ALL policies must return false.
 * Use this to compose exclusion rules (e.g. "not banned", "not suspended").
 *
 * @example
 * ```ts
 * const notRestricted = requireNone(isBanned, isSuspended);
 * const canPost = requireAll(hasRole("user"), notRestricted);
 * ```
 */
export function requireNone<U, C>(...policies: PolicyFn<U, C>[]): PolicyFn<U, C> {
  return async (user, ctx) => {
    for (const policy of policies) {
      if (await policy(user, ctx)) return false;
    }
    return true;
  };
}

// ──────────────────────────────────────────────────────────────────
// Type-guards & explicit-deny signalling
// ──────────────────────────────────────────────────────────────────

/**
 * An explicit, typed "cannot evaluate this claim" outcome. Replaces the old
 * silent `return []` in the default accessors: instead of an empty array that
 * is indistinguishable from a user who legitimately has *zero* roles, a missing
 * or malformed claim now surfaces a typed, inspectable value. RBAC helpers treat
 * it as a deny (fail-closed); `requirePolicy` (and Sprint 6 audit logging) can
 * observe the `reason`.
 */
export class PolicyDenied {
  readonly kind = "policy-denied" as const;
  constructor(readonly reason: string) {}
}

/**
 * Boundary type-guard: an untrusted value is a `string[]` only when it is an
 * array whose every element is a string. An empty array passes (a user with
 * zero roles/permissions is valid and distinct from a missing claim).
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// ──────────────────────────────────────────────────────────────────
// RBAC Helpers
// ──────────────────────────────────────────────────────────────────

/**
 * Default role accessor — reads `user.role` (string) or `user.roles` (string[]),
 * validating both at the trust boundary. Returns a typed `PolicyDenied` (never a
 * silent `[]`) when the user is not an object, or carries neither a `role` string
 * nor a valid `roles` string-array claim.
 */
export function defaultRoleAccessor<U>(user: U): string | string[] | PolicyDenied {
  if (user === null || typeof user !== "object") {
    return new PolicyDenied("cannot read roles: user is not an object");
  }
  const u = user as Record<string, unknown>;
  if (typeof u["role"] === "string") return u["role"];
  if ("roles" in u) {
    if (isStringArray(u["roles"])) return u["roles"];
    return new PolicyDenied("user.roles is present but is not a string[]");
  }
  return new PolicyDenied("user has no `role` (string) or `roles` (string[]) claim");
}

/**
 * Checks if the user has a specific role.
 *
 * @param role - The role to check for
 * @param accessor - Optional function to extract role(s) from the user object.
 *                   Defaults to reading `user.role` (string) or `user.roles` (string[]).
 *
 * @example
 * ```ts
 * const isAdmin = hasRole("admin");
 * const isManager = hasRole("manager", (u) => u.department.role);
 * ```
 */
export function hasRole<U, C>(
  role: string,
  accessor?: (user: U) => string | string[]
): PolicyFn<U, C> {
  return (user) => {
    const roles = accessor ? accessor(user) : defaultRoleAccessor(user);
    if (roles instanceof PolicyDenied) return false;
    return Array.isArray(roles) ? roles.includes(role) : roles === role;
  };
}

/**
 * Checks if the user has at least one of the specified roles.
 *
 * @example
 * ```ts
 * const isStaff = hasAnyRole(["admin", "moderator", "support"]);
 * ```
 */
export function hasAnyRole<U, C>(
  roles: string[],
  accessor?: (user: U) => string | string[]
): PolicyFn<U, C> {
  return (user) => {
    const userRoles = accessor ? accessor(user) : defaultRoleAccessor(user);
    if (userRoles instanceof PolicyDenied) return false;
    if (Array.isArray(userRoles)) {
      return userRoles.some((r) => roles.includes(r));
    }
    return roles.includes(userRoles);
  };
}

// ──────────────────────────────────────────────────────────────────
// Permission Helpers (fine-grained RBAC / ABAC)
// ──────────────────────────────────────────────────────────────────

/**
 * Default permission accessor — reads `user.permissions` (string[]), validated
 * at the trust boundary. Returns a typed `PolicyDenied` (never a silent `[]`)
 * when the user is not an object or carries no valid `permissions` string-array.
 */
export function defaultPermissionAccessor<U>(user: U): string[] | PolicyDenied {
  if (user === null || typeof user !== "object") {
    return new PolicyDenied("cannot read permissions: user is not an object");
  }
  const u = user as Record<string, unknown>;
  if ("permissions" in u) {
    if (isStringArray(u["permissions"])) return u["permissions"];
    return new PolicyDenied("user.permissions is present but is not a string[]");
  }
  return new PolicyDenied("user has no `permissions` (string[]) claim");
}

/**
 * Checks if the user has a specific permission.
 *
 * @param permission - The permission string (e.g. `"posts:write"`, `"users:delete"`)
 * @param accessor - Optional function to extract permissions from the user object.
 *                   Defaults to reading `user.permissions` (string[]).
 *
 * @example
 * ```ts
 * const canWrite = hasPermission("posts:write");
 * const canDeleteUsers = hasPermission("users:delete", (u) => u.grants);
 * ```
 */
export function hasPermission<U, C>(
  permission: string,
  accessor?: (user: U) => string[]
): PolicyFn<U, C> {
  return (user) => {
    const perms = accessor ? accessor(user) : defaultPermissionAccessor(user);
    if (perms instanceof PolicyDenied) return false;
    return perms.includes(permission);
  };
}

/**
 * Checks if the user has at least one of the specified permissions.
 *
 * @example
 * ```ts
 * const canManagePosts = hasAnyPermission(["posts:write", "posts:delete"]);
 * ```
 */
export function hasAnyPermission<U, C>(
  permissions: string[],
  accessor?: (user: U) => string[]
): PolicyFn<U, C> {
  return (user) => {
    const perms = accessor ? accessor(user) : defaultPermissionAccessor(user);
    if (perms instanceof PolicyDenied) return false;
    return perms.some((p) => permissions.includes(p));
  };
}
