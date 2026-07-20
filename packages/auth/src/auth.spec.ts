import { describe, it, expect, beforeAll, vi } from "vitest";
import { Nuraljs, createRoute, Schema as z } from "@nuraljs/core";
import type { FastifyInstance } from "fastify";
import { createAuth, type AuthConfig } from "./auth";
import { createStaticKeyProvider } from "./kms/static-provider";
import { AuthConfigError, TokenInvalidError, RateLimitError, isAuthError } from "./errors";
import type { AuthLogger } from "./observability";

const SECRET = "test-secret-at-least-16-chars-long";
const UserSchema = z.object({ id: z.string(), role: z.enum(["admin", "user"]) });

function recordingLogger() {
  const lines: string[] = [];
  const push = (m: string) => lines.push(m);
  const logger: AuthLogger = { log: push, warn: push, error: push, debug: push };
  return { logger, all: () => lines.join("\n") };
}

function makeAuth(extra: Partial<AuthConfig<typeof UserSchema>> = {}) {
  return createAuth({
    strategy: {
      schema: UserSchema,
      keyProvider: createStaticKeyProvider(SECRET),
      expiresInSeconds: 300,
    },
    ...extra,
  });
}

// ──────────────────────────────────────────────────────────────────
// T6.4 — config validation on the createAuth factory (typed errors)
// ──────────────────────────────────────────────────────────────────

describe("createAuth — config validation (T6.4)", () => {
  it("rejects a missing keyProvider with a typed AuthConfigError (500)", () => {
    const bad = { strategy: { schema: UserSchema } } as unknown as AuthConfig<typeof UserSchema>;
    try {
      createAuth(bad);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AuthConfigError);
      expect(isAuthError(e) && e.code).toBe("auth_config_invalid");
      expect((e as AuthConfigError).statusCode).toBe(500);
    }
  });

  it("rejects a missing schema", () => {
    const bad = {
      strategy: { keyProvider: createStaticKeyProvider(SECRET) },
    } as unknown as AuthConfig<typeof UserSchema>;
    expect(() => createAuth(bad)).toThrow(AuthConfigError);
  });

  it("rejects a non-function rateLimit", () => {
    const bad = {
      strategy: { schema: UserSchema, keyProvider: createStaticKeyProvider(SECRET) },
      rateLimit: 123,
    } as unknown as AuthConfig<typeof UserSchema>;
    expect(() => createAuth(bad)).toThrow(AuthConfigError);
  });

  it("the config error message never echoes the secret", () => {
    const bad = { strategy: { schema: UserSchema } } as unknown as AuthConfig<typeof UserSchema>;
    try {
      createAuth(bad);
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
    }
  });

  it("accepts a valid config", () => {
    expect(() => makeAuth()).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────
// T6.1 — audit logging (sign / verify-fail) + T6.6 no-secret assertion
// ──────────────────────────────────────────────────────────────────

describe("createAuth — audit logging (T6.1) never leaks secrets", () => {
  it("logs token.sign (success) and token.verify_fail — but never the token/secret", async () => {
    const { logger, all } = recordingLogger();
    const auth = makeAuth({ observability: { logger } });

    const token = await auth.sign({ id: "u1", role: "admin" });

    // A tampered token must fail verification → a verify_fail audit line.
    const tampered = token.slice(0, -6) + "AAAAAA";
    await expect(auth.verify(tampered)).rejects.toBeInstanceOf(TokenInvalidError);

    const logged = all();
    expect(logged).toContain("token.sign");
    expect(logged).toContain("u1"); // subject id is fine to log
    expect(logged).toContain("token.verify_fail");
    expect(logged).toContain("token_invalid"); // the reason code

    // The hard guarantee: no token bytes and no secret ever hit the log.
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(tampered);
  });

  it("routes verify_fail reason from the typed error code", async () => {
    const events: string[] = [];
    const auth = makeAuth({ observability: { onAudit: (e) => events.push(`${e.type}:${e.reason ?? ""}`) } });
    const token = await auth.sign({ id: "u2", role: "user" });

    // Fast-forward past exp by verifying an expired engine — simulate via a
    // short-lived token: sign with 1s and check the reason surfaces as a code.
    await expect(auth.verify(token.slice(0, -6) + "BBBBBB")).rejects.toBeInstanceOf(TokenInvalidError);
    expect(events.some((e) => e.startsWith("token.verify_fail:token_invalid"))).toBe(true);
  });

  it("is silent when no observability is wired", async () => {
    const auth = makeAuth();
    const token = await auth.sign({ id: "u3", role: "user" });
    // No throw, no logger required.
    await expect(auth.verify(token)).resolves.toEqual({ id: "u3", role: "user" });
  });
});

// ──────────────────────────────────────────────────────────────────
// T6.5 — rate-limit hooks
// ──────────────────────────────────────────────────────────────────

describe("createAuth — rate-limit hook (T6.5)", () => {
  it("verify throws RateLimitError (429) when the hook denies", async () => {
    const auth = makeAuth({ rateLimit: () => false });
    await expect(auth.verify("anything")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("the hook is invoked with the verify operation", async () => {
    const hook = vi.fn(() => true);
    const auth = makeAuth({ rateLimit: hook });
    const token = await auth.sign({ id: "u4", role: "admin" });
    await auth.verify(token);
    expect(hook).toHaveBeenCalledWith({ operation: "verify" });
  });
});

// ──────────────────────────────────────────────────────────────────
// AUTH GATE (T6.8) — the guard on a REAL nural Fastify route: a thrown
// UnauthorizedException in preValidation yields 401 BEFORE body validation.
// ──────────────────────────────────────────────────────────────────

describe("AUTH GATE — guard on a real nural Fastify route (401 before validation)", () => {
  const auth = makeAuth();
  let app: FastifyInstance;

  beforeAll(async () => {
    const nural = new Nuraljs({ framework: "fastify", logger: { enabled: false } });
    const route = createRoute({
      method: "POST",
      path: "/protected",
      request: { body: z.object({ note: z.string() }) },
      responses: { 200: z.object({ id: z.string() }) },
      // The auth guard runs as a preValidation middleware.
      middleware: [auth.guard],
      handler: async (ctx) => ({ id: (ctx.user as { id: string }).id }),
    });
    nural.register([route]);
    app = (nural as unknown as { adapter: { app: FastifyInstance } }).adapter.app;
    await app.ready();
  });

  it("no Authorization header + INVALID body → 401 (auth before validation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      payload: { bad: 123 }, // would be a 400 if validation ran first
    });
    expect(res.statusCode).toBe(401);
  });

  it("garbage bearer token → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: "Bearer not-a-real-token" },
      payload: { note: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("valid token + valid body → 200 with ctx.user surfaced", async () => {
    const token = await auth.sign({ id: "admin_1", role: "admin" });
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
      payload: { note: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ id: "admin_1" });
  });

  it("valid token + INVALID body → 400 (validation runs only after auth passes)", async () => {
    const token = await auth.sign({ id: "u_1", role: "user" });
    const res = await app.inject({
      method: "POST",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
      payload: { nope: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
