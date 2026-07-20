import { describe, it, expect } from "vitest";
import {
  definePolicy,
  requireAll,
  requireAny,
  requireNone,
  hasRole,
  hasAnyRole,
  hasPermission,
  hasAnyPermission,
} from "./engine";

// ── Test user shapes ──────────────────────────────────────────────

interface SingleRoleUser {
  id: string;
  role: string;
  banned: boolean;
}

interface MultiRoleUser {
  id: string;
  roles: string[];
  permissions: string[];
}

interface RouteCtx {
  params: { userId: string };
}

describe("Policy Engine — Core Combinators", () => {
  const ctx: RouteCtx = { params: { userId: "user_1" } };

  it("definePolicy creates a working policy function", async () => {
    const isOwner = definePolicy<SingleRoleUser, RouteCtx>(
      (user, ctx) => user.id === ctx.params.userId
    );

    expect(await isOwner({ id: "user_1", role: "user", banned: false }, ctx)).toBe(true);
    expect(await isOwner({ id: "user_2", role: "user", banned: false }, ctx)).toBe(false);
  });

  it("requireAll passes only when ALL policies pass", async () => {
    const isNotBanned = definePolicy<SingleRoleUser, RouteCtx>((u) => !u.banned);
    const isAdmin = definePolicy<SingleRoleUser, RouteCtx>((u) => u.role === "admin");

    const policy = requireAll(isNotBanned, isAdmin);

    expect(await policy({ id: "1", role: "admin", banned: false }, ctx)).toBe(true);
    expect(await policy({ id: "1", role: "admin", banned: true }, ctx)).toBe(false);
    expect(await policy({ id: "1", role: "user", banned: false }, ctx)).toBe(false);
  });

  it("requireAny passes when at least ONE policy passes", async () => {
    const isAdmin = definePolicy<SingleRoleUser, RouteCtx>((u) => u.role === "admin");
    const isOwner = definePolicy<SingleRoleUser, RouteCtx>(
      (u, c) => u.id === c.params.userId
    );

    const policy = requireAny(isAdmin, isOwner);

    expect(await policy({ id: "user_1", role: "user", banned: false }, ctx)).toBe(true);
    expect(await policy({ id: "user_2", role: "admin", banned: false }, ctx)).toBe(true);
    expect(await policy({ id: "user_2", role: "user", banned: false }, ctx)).toBe(false);
  });

  it("requireNone passes only when ALL policies return false", async () => {
    const isBanned = definePolicy<SingleRoleUser, RouteCtx>((u) => u.banned);
    const isSuspended = definePolicy<SingleRoleUser, RouteCtx>((u) => u.role === "suspended");

    const notRestricted = requireNone(isBanned, isSuspended);

    expect(await notRestricted({ id: "1", role: "user", banned: false }, ctx)).toBe(true);
    expect(await notRestricted({ id: "1", role: "user", banned: true }, ctx)).toBe(false);
    expect(await notRestricted({ id: "1", role: "suspended", banned: false }, ctx)).toBe(false);
  });
});

describe("Policy Engine — RBAC Helpers", () => {
  const ctx = {};

  describe("hasRole", () => {
    it("works with single string role (user.role)", () => {
      const isAdmin = hasRole<SingleRoleUser, unknown>("admin");

      expect(isAdmin({ id: "1", role: "admin", banned: false }, ctx)).toBe(true);
      expect(isAdmin({ id: "1", role: "user", banned: false }, ctx)).toBe(false);
    });

    it("works with array roles (user.roles)", () => {
      const isMod = hasRole<MultiRoleUser, unknown>("moderator");

      expect(
        isMod({ id: "1", roles: ["user", "moderator"], permissions: [] }, ctx)
      ).toBe(true);
      expect(
        isMod({ id: "1", roles: ["user"], permissions: [] }, ctx)
      ).toBe(false);
    });

    it("works with custom accessor", () => {
      interface CustomUser {
        department: { level: string };
      }
      const isManager = hasRole<CustomUser, unknown>(
        "manager",
        (u) => u.department.level
      );

      expect(isManager({ department: { level: "manager" } }, ctx)).toBe(true);
      expect(isManager({ department: { level: "junior" } }, ctx)).toBe(false);
    });
  });

  describe("hasAnyRole", () => {
    it("returns true if user has at least one matching role", () => {
      const isStaff = hasAnyRole<MultiRoleUser, unknown>(["admin", "moderator", "support"]);

      expect(
        isStaff({ id: "1", roles: ["moderator"], permissions: [] }, ctx)
      ).toBe(true);
      expect(
        isStaff({ id: "1", roles: ["user"], permissions: [] }, ctx)
      ).toBe(false);
    });

    it("works with single string role field", () => {
      const isStaff = hasAnyRole<SingleRoleUser, unknown>(["admin", "moderator"]);

      expect(isStaff({ id: "1", role: "admin", banned: false }, ctx)).toBe(true);
      expect(isStaff({ id: "1", role: "user", banned: false }, ctx)).toBe(false);
    });
  });
});

describe("Policy Engine — Permission Helpers", () => {
  const ctx = {};

  describe("hasPermission", () => {
    it("checks for a specific permission", () => {
      const canWrite = hasPermission<MultiRoleUser, unknown>("posts:write");

      expect(
        canWrite({ id: "1", roles: [], permissions: ["posts:read", "posts:write"] }, ctx)
      ).toBe(true);
      expect(
        canWrite({ id: "1", roles: [], permissions: ["posts:read"] }, ctx)
      ).toBe(false);
    });

    it("works with custom accessor", () => {
      interface CustomUser {
        grants: string[];
      }
      const canDelete = hasPermission<CustomUser, unknown>(
        "users:delete",
        (u) => u.grants
      );

      expect(canDelete({ grants: ["users:delete"] }, ctx)).toBe(true);
      expect(canDelete({ grants: ["users:read"] }, ctx)).toBe(false);
    });
  });

  describe("hasAnyPermission", () => {
    it("returns true if user has at least one matching permission", () => {
      const canManage = hasAnyPermission<MultiRoleUser, unknown>([
        "posts:write",
        "posts:delete",
      ]);

      expect(
        canManage({ id: "1", roles: [], permissions: ["posts:delete"] }, ctx)
      ).toBe(true);
      expect(
        canManage({ id: "1", roles: [], permissions: ["posts:read"] }, ctx)
      ).toBe(false);
    });
  });
});

describe("Policy Engine — Complex Composition (RBAC + ABAC)", () => {
  interface User {
    id: string;
    role: string;
    permissions: string[];
    banned: boolean;
  }

  interface Ctx {
    params: { userId: string };
  }

  const ctx: Ctx = { params: { userId: "user_1" } };

  it("composes RBAC + ABAC + deny rules", async () => {
    const isAdmin = hasRole<User, Ctx>("admin");
    const isModerator = hasRole<User, Ctx>("moderator");
    const isOwner = definePolicy<User, Ctx>((u, c) => u.id === c.params.userId);
    const isBanned = definePolicy<User, Ctx>((u) => u.banned);

    // Admin OR (moderator AND resource owner), AND not banned
    const canEditUser = requireAll(
      requireAny(isAdmin, requireAll(isModerator, isOwner)),
      requireNone(isBanned)
    );

    // Admin — allowed
    expect(
      await canEditUser(
        { id: "user_2", role: "admin", permissions: [], banned: false },
        ctx
      )
    ).toBe(true);

    // Moderator who is the resource owner — allowed
    expect(
      await canEditUser(
        { id: "user_1", role: "moderator", permissions: [], banned: false },
        ctx
      )
    ).toBe(true);

    // Moderator who is NOT the resource owner — denied
    expect(
      await canEditUser(
        { id: "user_2", role: "moderator", permissions: [], banned: false },
        ctx
      )
    ).toBe(false);

    // Admin who is banned — denied
    expect(
      await canEditUser(
        { id: "user_2", role: "admin", permissions: [], banned: true },
        ctx
      )
    ).toBe(false);

    // Regular user — denied
    expect(
      await canEditUser(
        { id: "user_1", role: "user", permissions: [], banned: false },
        ctx
      )
    ).toBe(false);
  });
});
