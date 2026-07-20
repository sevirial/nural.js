import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

// The `nuraljs` barrel eagerly imports the Fastify + Express adapters, so loading
// it pulls in `fastify`/`express` — neither is installed in this package (the
// full HTTP boot is the Sprint 6 gate). The guard only uses two trivial symbols
// from core: `defineMiddleware` (literally `fn => fn`) and `ForbiddenException`
// (a thin `HttpException` subclass). We mock `nuraljs` with faithful equivalents —
// same class shape (`statusCode`, prototype chain) — so `instanceof` and the 403
// contract are exercised without the adapters. `auth.ts` (imported below for the
// end-to-end test) resolves to the same mock, keeping the classes identical.
vi.mock("@nuraljs/core", () => {
  class HttpException extends Error {
    statusCode: number;
    error: string;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
      this.error = statusCode === 403 ? "FORBIDDEN" : "UNAUTHORIZED";
      this.name = new.target.name;
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }
  class ForbiddenException extends HttpException {
    constructor(message = "Forbidden") {
      super(message, 403);
    }
  }
  class UnauthorizedException extends HttpException {
    constructor(message = "Unauthorized") {
      super(message, 401);
    }
  }
  return {
    defineMiddleware: <T>(fn: T): T => fn,
    HttpException,
    ForbiddenException,
    UnauthorizedException,
  };
});

import { ForbiddenException } from "@nuraljs/core";
import { requirePolicy } from "./guard";
import {
  hasRole,
  hasPermission,
  definePolicy,
  requireAll,
  PolicyDenied,
  isStringArray,
  defaultRoleAccessor,
  defaultPermissionAccessor,
} from "./engine";
import { createAuth } from "../auth";
import { createStaticKeyProvider } from "../kms/static-provider";

// ── Middleware = (req, res) => result | void | Promise<...> ─────────
type Middleware = (req: unknown, res: unknown) => unknown;

/**
 * Faithful replica of core's Fastify `preValidation` pipeline
 * (`packages/core/src/adapters/fastify.ts:221-232`): decorate the request with a
 * single per-request context bag, run each middleware in order, and merge every
 * returned object onto the bag *before the next runs*. This is exactly how a real
 * Nuraljs route drives `[auth.guard, requirePolicy(...)]`, so a throw here is the
 * throw a real request would surface (401 from the guard, 403 from requirePolicy)
 * — before ajv validation. Returns the final context bag on success.
 *
 * `fastify` itself is not resolvable from this package (and `nuraljs` imports both
 * adapters eagerly), so we drive the documented middleware contract directly
 * rather than booting an HTTP server; the full HTTP boot is the Sprint 6 gate.
 */
async function runRoute(
  middleware: Middleware[],
  req: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bag: Record<string, unknown> = {};
  req["nuralCtx"] = bag;
  const reply = { status: () => reply, send: () => reply };
  for (const mw of middleware) {
    const result = await mw(req, reply);
    if (result && typeof result === "object") {
      Object.assign(bag, result as Record<string, unknown>);
    }
  }
  return bag;
}

// A stand-in upstream auth guard: mirrors createAuth().guard's contract of
// returning `{ user }`, which core merges to `ctx.user`.
const injectUser = (user: unknown): Middleware => async () => ({ user });

describe("requirePolicy — authorization middleware", () => {
  it("allows the request when the policy passes (user reaches the handler)", async () => {
    const isAdmin = hasRole<{ role: string }, unknown>("admin");

    const ctx = await runRoute(
      [injectUser({ id: "u1", role: "admin" }), requirePolicy(isAdmin)],
      { headers: {} },
    );

    // No throw ⇒ allowed. The user the guard stashed is still on the context.
    expect(ctx["user"]).toEqual({ id: "u1", role: "admin" });
  });

  it("denies with ForbiddenException (403) when the policy fails", async () => {
    const isAdmin = hasRole<{ role: string }, unknown>("admin");

    await expect(
      runRoute(
        [injectUser({ id: "u2", role: "user" }), requirePolicy(isAdmin)],
        { headers: {} },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 403, generic message (no reason leaked to the client).
    try {
      await runRoute(
        [injectUser({ id: "u2", role: "user" }), requirePolicy(isAdmin)],
        { headers: {} },
      );
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect((e as ForbiddenException).statusCode).toBe(403);
      expect((e as ForbiddenException).message).toBe("Access denied");
    }
  });

  it("fails closed with 403 when no authenticated user is present", async () => {
    const isAdmin = hasRole<{ role: string }, unknown>("admin");
    const onDeny = vi.fn();

    // requirePolicy with NO upstream guard ⇒ ctx.user is undefined.
    await expect(
      runRoute([requirePolicy(isAdmin, { onDeny })], { headers: {} }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringMatching(/no authenticated user/) }),
    );
  });

  it("fires the onDeny observability hook with a reason on a policy deny", async () => {
    const onDeny = vi.fn();
    const isAdmin = hasRole<{ role: string }, unknown>("admin");

    await expect(
      runRoute(
        [injectUser({ id: "u3", role: "user" }), requirePolicy(isAdmin, { onDeny })],
        { headers: {} },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringMatching(/policy evaluated to false/) }),
    );
  });

  it("passes route params/query/body to the policy for ABAC (resource-owner)", async () => {
    interface User {
      id: string;
    }
    interface Ctx {
      params: { userId: string };
    }
    const isOwner = definePolicy<User, Ctx>((u, c) => u.id === c.params.userId);

    // Owner — allowed.
    await expect(
      runRoute([injectUser({ id: "u_1" }), requirePolicy<User, Ctx>(isOwner)], {
        headers: {},
        params: { userId: "u_1" },
      }),
    ).resolves.toBeTruthy();

    // Not the owner — denied.
    await expect(
      runRoute([injectUser({ id: "u_2" }), requirePolicy<User, Ctx>(isOwner)], {
        headers: {},
        params: { userId: "u_1" },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("supports a custom userKey", async () => {
    const isAdmin = hasRole<{ role: string }, unknown>("admin");
    const setPrincipal: Middleware = async () => ({ principal: { role: "admin" } });

    await expect(
      runRoute([setPrincipal, requirePolicy(isAdmin, { userKey: "principal" })], {
        headers: {},
      }),
    ).resolves.toBeTruthy();
  });

  it("composes with combinators (requireAll: role AND permission)", async () => {
    const canPublish = requireAll<{ role: string; permissions: string[] }, unknown>(
      hasRole("editor"),
      hasPermission("posts:publish"),
    );

    await expect(
      runRoute(
        [
          injectUser({ role: "editor", permissions: ["posts:publish"] }),
          requirePolicy(canPublish),
        ],
        { headers: {} },
      ),
    ).resolves.toBeTruthy();

    await expect(
      runRoute(
        [
          injectUser({ role: "editor", permissions: ["posts:read"] }),
          requirePolicy(canPublish),
        ],
        { headers: {} },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("requirePolicy — end-to-end with the real createAuth guard", () => {
  const UserSchema = z.object({
    id: z.string(),
    role: z.enum(["admin", "user"]),
  });

  const auth = createAuth({
    strategy: {
      schema: UserSchema,
      keyProvider: createStaticKeyProvider("test-secret-at-least-16-chars-long"),
      expiresInSeconds: 300,
    },
  });

  it("guard verifies a real token, then requirePolicy allows the admin", async () => {
    const token = await auth.sign({ id: "admin_1", role: "admin" });
    const isAdmin = hasRole<z.infer<typeof UserSchema>, unknown>("admin");

    const ctx = await runRoute([auth.guard as Middleware, requirePolicy(isAdmin)], {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(ctx["user"]).toEqual({ id: "admin_1", role: "admin" });
  });

  it("guard verifies a real token, then requirePolicy denies the non-admin (403)", async () => {
    const token = await auth.sign({ id: "user_1", role: "user" });
    const isAdmin = hasRole<z.infer<typeof UserSchema>, unknown>("admin");

    await expect(
      runRoute([auth.guard as Middleware, requirePolicy(isAdmin)], {
        headers: { authorization: `Bearer ${token}` },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("Policy accessors — boundary type-guards & explicit deny", () => {
  describe("isStringArray", () => {
    it("accepts a string[] (including empty)", () => {
      expect(isStringArray([])).toBe(true);
      expect(isStringArray(["a", "b"])).toBe(true);
    });

    it("rejects non-arrays and arrays with non-string elements", () => {
      expect(isStringArray("a")).toBe(false);
      expect(isStringArray(null)).toBe(false);
      expect(isStringArray(["a", 1])).toBe(false);
      expect(isStringArray([1, 2, 3])).toBe(false);
      expect(isStringArray([{}, "a"])).toBe(false);
    });
  });

  describe("defaultRoleAccessor", () => {
    it("reads a valid `role` string", () => {
      expect(defaultRoleAccessor({ role: "admin" })).toBe("admin");
    });

    it("reads a validated `roles` string[]", () => {
      expect(defaultRoleAccessor({ roles: ["a", "b"] })).toEqual(["a", "b"]);
    });

    it("returns a typed PolicyDenied when neither claim exists (not a silent [])", () => {
      const denied = defaultRoleAccessor({ id: "u1" });
      expect(denied).toBeInstanceOf(PolicyDenied);
      expect((denied as PolicyDenied).reason).toMatch(/no `role`/);
    });

    it("returns PolicyDenied when `roles` is present but not a string[]", () => {
      const denied = defaultRoleAccessor({ roles: [1, 2, 3] });
      expect(denied).toBeInstanceOf(PolicyDenied);
      expect((denied as PolicyDenied).reason).toMatch(/not a string\[\]/);
    });

    it("returns PolicyDenied for a non-object user", () => {
      expect(defaultRoleAccessor(null)).toBeInstanceOf(PolicyDenied);
      expect(defaultRoleAccessor("nope")).toBeInstanceOf(PolicyDenied);
    });

    it("distinguishes an empty-roles user (valid) from a missing-claim user", () => {
      // Empty roles is a valid, non-denied claim (a user with zero roles)...
      expect(defaultRoleAccessor({ roles: [] })).toEqual([]);
      // ...whereas no claim at all is an explicit, observable deny.
      expect(defaultRoleAccessor({})).toBeInstanceOf(PolicyDenied);
    });
  });

  describe("defaultPermissionAccessor", () => {
    it("reads a validated `permissions` string[]", () => {
      expect(defaultPermissionAccessor({ permissions: ["x"] })).toEqual(["x"]);
    });

    it("returns PolicyDenied when the claim is missing or malformed", () => {
      expect(defaultPermissionAccessor({})).toBeInstanceOf(PolicyDenied);
      expect(defaultPermissionAccessor({ permissions: [1] })).toBeInstanceOf(
        PolicyDenied,
      );
      expect(defaultPermissionAccessor(42)).toBeInstanceOf(PolicyDenied);
    });
  });

  describe("RBAC helpers deny (fail-closed) on a PolicyDenied claim", () => {
    it("hasRole denies a user with no role claim instead of throwing", () => {
      const isAdmin = hasRole<Record<string, unknown>, unknown>("admin");
      expect(isAdmin({ id: "u1" }, {})).toBe(false);
    });

    it("hasRole denies a user whose `roles` is not a string[]", () => {
      const isAdmin = hasRole<Record<string, unknown>, unknown>("admin");
      expect(isAdmin({ roles: [1, 2] }, {})).toBe(false);
    });

    it("hasPermission denies a user with no permissions claim", () => {
      const canWrite = hasPermission<Record<string, unknown>, unknown>("posts:write");
      expect(canWrite({ id: "u1" }, {})).toBe(false);
    });
  });
});
