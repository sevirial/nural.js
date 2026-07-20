/**
 * Integration suite — drives the rewritten Fastify hot path through the REAL
 * adapter via `createTestClient` (the package's whole purpose). Covers the four
 * Sprint 6 correctness cases: `.refine()` runtime fallback, `.transform()`,
 * response extra-field stripping (fast-json-stringify), and validation-failure
 * 400-shape parity between the fast path (ajv) and the fallback path (Zod).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Nuraljs, createRoute, Schema as z } from "@nuraljs/core";
import { createTestClient, type TestClient } from "./index";

// ---- Routes exercising every path of the rewrite ----

// Fast path (ajv validates, fast-json-stringify serializes).
const fastRoute = createRoute({
  method: "POST",
  path: "/validate",
  request: {
    body: z.object({ email: z.string(), age: z.number() }),
  },
  responses: { 200: z.object({ ok: z.boolean() }) },
  handler: async () => ({ ok: true }),
});

// `.refine()` → non-representable → runtime Zod fallback (sync parse).
const refineRoute = createRoute({
  method: "POST",
  path: "/refine",
  request: {
    body: z
      .object({ password: z.string(), confirm: z.string() })
      .refine((d) => d.password === d.confirm, {
        message: "Passwords must match",
      }),
  },
  responses: { 200: z.object({ ok: z.boolean() }) },
  handler: async () => ({ ok: true }),
});

// `.transform()` → runtime fallback; transform must actually run.
const transformRoute = createRoute({
  method: "POST",
  path: "/transform",
  request: {
    body: z.object({ name: z.string().transform((s) => s.toUpperCase()) }),
  },
  responses: { 200: z.object({ name: z.string() }) },
  handler: async ({ body }) => ({ name: (body as { name: string }).name }),
});

// Response carries an extra field the schema doesn't list → must be stripped.
const stripRoute = createRoute({
  method: "GET",
  path: "/strip",
  responses: { 200: z.object({ id: z.number() }) },
  handler: async () => ({ id: 1, secret: "leak" }) as { id: number },
});

// Functional multi-status: `status(code)` picks which declared response the
// returned value is shaped by — no dropping to raw `res`.
const statusRoute = createRoute({
  method: "POST",
  path: "/multi-status",
  responses: {
    201: z.object({ documentId: z.string() }),
    202: z.object({ message: z.string() }),
  },
  handler: async ({ body, status }) => {
    if ((body as { async?: boolean })?.async) {
      status(202);
      return { message: "queued", secret: "leak" } as { message: string };
    }
    return { documentId: "123-abc", secret: "leak" } as { documentId: string };
  },
});

// T7.7 — run the ENTIRE suite against BOTH engines so the Express fast path
// (F.4: ajv + fast-json-stringify) is held to the same behavior + error-shape
// parity as the Fastify hot path.
const ENGINES = ["fastify", "express"] as const;

describe.each(ENGINES)(
  "rewritten hot path — %s (via real adapter)",
  (framework) => {
    let client: TestClient;

    beforeAll(() => {
      const app = new Nuraljs({ framework, logger: { enabled: false } });
      app.register([fastRoute, refineRoute, transformRoute, stripRoute, statusRoute]);
      client = createTestClient(app);
    });

  it("fast path: valid body → 200", async () => {
    const res = await client.post("/validate", { email: "a@b.com", age: 30 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // ---- T6.3: .refine() route (runtime fallback) ----
  it("T6.3 .refine(): satisfied predicate → 200", async () => {
    const res = await client.post("/refine", {
      password: "hunter2",
      confirm: "hunter2",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("T6.3 .refine(): violated predicate → 400 (fallback threw ZodError)", async () => {
    const res = await client.post("/refine", {
      password: "hunter2",
      confirm: "nope",
    });
    expect(res.status).toBe(400);
    const body = res.body as { error: string; message: string; details: unknown[] };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe("Request validation failed");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  // ---- T6.4: .transform() route ----
  it("T6.4 .transform(): transform runs on the fallback path", async () => {
    const res = await client.post("/transform", { name: "alice" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "ALICE" });
  });

  // ---- T6.5: response extra-field stripped by fast-json-stringify ----
  it("T6.5 response stripping: unlisted field removed (no data leak)", async () => {
    const res = await client.get("/strip");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1 });
    expect((res.body as Record<string, unknown>).secret).toBeUndefined();
  });

  // ---- T6.6: validation failure returns the same 400 shape ----
  it("T6.6 fast-path validation failure → same 400 envelope", async () => {
    const res = await client.post("/validate", { email: "a@b.com" }); // missing age
    expect(res.status).toBe(400);
    const body = res.body as { error: string; message: string; details: unknown[] };
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.message).toBe("Request validation failed");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("T6.6 fast-path (ajv) and fallback (Zod) 400 envelopes agree", async () => {
    const fastFail = await client.post("/validate", { email: "a@b.com" });
    const fallbackFail = await client.post("/refine", {
      password: "x",
      confirm: "y",
    });
    const shape = (b: unknown) => {
      const { error, message } = b as { error: string; message: string };
      return { error, message };
    };
    expect(fastFail.status).toBe(400);
    expect(fallbackFail.status).toBe(400);
    // Same envelope (error + message) regardless of which validator produced it.
    expect(shape(fastFail.body)).toEqual(shape(fallbackFail.body));
  });

  it("status(): default → first 2xx, shaped + stripped to that code", async () => {
    const res = await client.post("/multi-status", { async: false });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ documentId: "123-abc" }); // `secret` stripped
  });

  it("status(code): picks the code and shapes to ITS schema", async () => {
    const res = await client.post("/multi-status", { async: true });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: "queued" }); // 202 schema, `secret` stripped
  });
});
