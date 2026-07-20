/**
 * Fastify Adapter — Validation-Error Shape Parity (Sprint 3)
 *
 * On the fast path ajv (not Zod) validates the request, so a validation failure
 * surfaces as a Fastify validation error. These tests assert the resulting 400
 * body is identical in shape to the pre-rewrite runtime-Zod path — i.e. the
 * `defaultErrorHandler` ZodError branch (`types/error.ts`) — and that the
 * fast-path and runtime-fallback paths now agree. They also confirm
 * HttpException handling and the auth-before-validation (401-before-400)
 * ordering are unchanged.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { FastifyAdapter } from "./fastify";
import { defaultErrorHandler, resolveErrorHandlerConfig } from "../types/error";
import type { ErrorContext } from "../types/error";
import { NotFoundException, UnauthorizedException } from "../core/exceptions";
import { defineMiddleware } from "../core/middleware";
import type { NuralRequest } from "../core/middleware";
import type { AnyRouteConfig, InferMiddleware } from "../types/route";

/** Build a minimal route config; handler returns whatever it's given. */
const route = (cfg: Partial<AnyRouteConfig>): AnyRouteConfig =>
  ({
    method: "post",
    path: "/x",
    handler: () => ({ ok: true }),
    ...cfg,
  }) as AnyRouteConfig;

/** Fresh adapter with logging silenced (keeps test output clean). */
const makeAdapter = () =>
  new FastifyAdapter(resolveErrorHandlerConfig({ logErrors: false }));

/** The 400 body the pre-rewrite path emits for a real ZodError. */
const zodErrorEnvelope = async () => {
  let err: unknown;
  try {
    z.object({ name: z.string(), age: z.number() }).parse({ age: "x" });
  } catch (e) {
    err = e;
  }
  return defaultErrorHandler({ error: err } as unknown as ErrorContext);
};

describe("FastifyAdapter — validation-error parity", () => {
  it("fast-path (ajv) validation failure returns the ZodError-branch 400 body", async () => {
    const adapter = makeAdapter();
    adapter.registerRoute(
      route({
        request: { body: z.object({ name: z.string(), age: z.number() }) },
      }),
    );

    const res = await adapter.app.inject({
      method: "POST",
      url: "/x",
      payload: { age: "x" }, // missing `name`, wrong `age` type
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();

    // Envelope must match the pre-rewrite ZodError branch exactly.
    const expected = await zodErrorEnvelope();
    expect(body.error).toBe(expected.body.error); // "VALIDATION_ERROR"
    expect(body.message).toBe(expected.body.message); // "Request validation failed"

    // Not Fastify's native placeholder shape.
    expect(body).not.toHaveProperty("statusCode");
    expect(body.error).not.toBe("BAD_REQUEST");

    // `details` is a non-empty array of Zod-shaped issues.
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    expect(body.details[0]).toHaveProperty("path");
    expect(body.details[0]).toHaveProperty("message");
    expect(body.details[0]).toHaveProperty("code");

    // Non-prod keeps a stack field, as the pre-rewrite path did.
    if (process.env.NODE_ENV !== "production") {
      expect(typeof body.stack).toBe("string");
    }
  });

  it("carries the failing field into the issue path", async () => {
    const adapter = makeAdapter();
    adapter.registerRoute(
      route({ request: { body: z.object({ name: z.string() }) } }),
    );

    const res = await adapter.app.inject({
      method: "POST",
      url: "/x",
      payload: {}, // missing `name`
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.details[0].path).toContain("name");
  });

  it("runtime-fallback (.refine) route emits the SAME 400 envelope as the fast path", async () => {
    const adapter = makeAdapter();
    adapter.registerRoute(
      route({
        request: {
          body: z
            .object({ name: z.string() })
            .refine((v) => v.name.length > 2, "too short"),
        },
      }),
    );

    const res = await adapter.app.inject({
      method: "POST",
      url: "/x",
      payload: {}, // missing `name` → ZodError from the sync .parse() fallback
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    const expected = await zodErrorEnvelope();
    expect(body.error).toBe(expected.body.error);
    expect(body.message).toBe(expected.body.message);
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("leaves HttpException handling unchanged (404 body intact)", async () => {
    const adapter = makeAdapter();
    adapter.registerRoute(
      route({
        method: "GET",
        path: "/missing",
        handler: () => {
          throw new NotFoundException("User not found");
        },
      }),
    );

    const res = await adapter.app.inject({ method: "GET", url: "/missing" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.statusCode).toBe(404);
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBe("User not found");
  });

  it("runs auth before validation → 401 before 400", async () => {
    const adapter = makeAdapter();
    adapter.registerRoute(
      route({
        // Auth middleware throws → must win over the invalid body (which would
        // otherwise be a 400). preValidation runs ahead of ajv validation.
        middleware: [
          async () => {
            throw new UnauthorizedException("Missing token");
          },
        ],
        request: { body: z.object({ name: z.string() }) },
      }),
    );

    const res = await adapter.app.inject({
      method: "POST",
      url: "/x",
      payload: {}, // also invalid — but auth should reject first
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("builds and validates a route whose schema carries OpenAPI annotations (.meta example)", async () => {
    const adapter = makeAdapter();
    // `.meta({ example })` lands in the JSON Schema fed to ajv; strict mode used
    // to fail the whole route build with `unknown keyword: "example"`.
    adapter.registerRoute(
      route({
        method: "POST",
        path: "/login",
        request: {
          body: z.object({
            email: z.string().email().meta({ example: "user@example.com" }),
            password: z.string().min(6).meta({ example: "s3cret!" }),
          }),
        },
        responses: {
          200: z.object({ token: z.string() }).meta({ example: { token: "abc" } }),
        },
        handler: () => ({ token: "abc" }),
      }),
    );
    await adapter.app.ready(); // schema build happens here — must not throw

    // Validation still works: a bad body is a 400, a good one a 200.
    const bad = await adapter.app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "not-an-email", password: "x" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await adapter.app.inject({
      method: "POST",
      url: "/login",
      payload: { email: "user@example.com", password: "s3cret!" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ token: "abc" });
  });

  it("exposes an upstream guard's context to a downstream middleware via req.nuralCtx", async () => {
    const adapter = makeAdapter();

    // Upstream guard stashes a user; the downstream middleware reads it through
    // the typed `req.nuralCtx` (no `any` cast) — the DX gap Issue 2 fixed.
    // Annotating `req` with the upstream contract (inferred via
    // `InferMiddleware`) makes `req.nuralCtx.user` type-check; the return type
    // still infers from the body.
    const upstream = defineMiddleware(async () => ({
      user: { id: "u1", role: "admin" },
    }));
    type Auth = InferMiddleware<typeof upstream>;
    const downstream = defineMiddleware((req: NuralRequest<Auth>) => {
      const user = req.nuralCtx.user;
      return { isAdmin: user.role === "admin" };
    });

    adapter.registerRoute(
      route({
        method: "GET",
        path: "/me",
        middleware: [upstream, downstream],
        responses: { 200: z.object({ id: z.string(), isAdmin: z.boolean() }) },
        handler: (ctx: { user: { id: string }; isAdmin: boolean }) => ({
          id: ctx.user.id,
          isAdmin: ctx.isAdmin,
        }),
      }),
    );

    const res = await adapter.app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "u1", isAdmin: true });
  });
});
