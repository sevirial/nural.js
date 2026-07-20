/**
 * Schema Compiler Tests
 *
 * Exercises the boot-time compiler in isolation: correct JSON Schema for
 * fast-path routes, and correct `needsRuntimeZod` flagging for `.refine()` /
 * `.transform()` / `.superRefine()` routes.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  compileRouteSchema,
  getCompiledSchema,
  schemaNeedsRuntimeZod,
} from "./schema-compiler";
import type { AnyRouteConfig } from "../types/route";

/** Build a minimal route config for the compiler (handler is never called). */
const route = (cfg: Partial<AnyRouteConfig>): AnyRouteConfig =>
  ({
    method: "post",
    path: "/x",
    handler: () => undefined,
    ...cfg,
  }) as AnyRouteConfig;

describe("schema-compiler", () => {
  describe("fast path (fully compilable routes)", () => {
    it("compiles params/query/body to draft-07 JSON Schema under the right keys", () => {
      const compiled = compileRouteSchema(
        route({
          request: {
            params: z.object({ id: z.string() }),
            query: z.object({ page: z.number().int() }),
            body: z.object({ name: z.string(), age: z.number() }),
          },
        }),
      );

      const { fastifySchema, needsRuntimeZod, runtimeSchemas } = compiled;

      // query is exposed under Fastify's `querystring` key
      expect(fastifySchema.querystring).toBeDefined();
      expect(fastifySchema.params).toMatchObject({
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      });
      expect(fastifySchema.body).toMatchObject({
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
      });

      // draft-07, and the meta `$schema` pointer is stripped
      expect(fastifySchema.params).not.toHaveProperty("$schema");
      expect(fastifySchema.body).not.toHaveProperty("$schema");

      // nothing flagged; no runtime schemas retained
      expect(needsRuntimeZod.any).toBe(false);
      expect(needsRuntimeZod.params).toBe(false);
      expect(needsRuntimeZod.query).toBe(false);
      expect(needsRuntimeZod.body).toBe(false);
      expect(runtimeSchemas).toEqual({});
    });

    it("compiles responses keyed by numeric status code with additionalProperties:false", () => {
      const compiled = compileRouteSchema(
        route({
          responses: {
            200: z.object({ id: z.string(), name: z.string() }),
            404: z.object({ message: z.string() }),
          },
        }),
      );

      expect(compiled.fastifySchema.response).toBeDefined();
      expect(compiled.fastifySchema.response![200]).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(compiled.fastifySchema.response![404]).toMatchObject({
        type: "object",
        properties: { message: { type: "string" } },
      });
      expect(compiled.needsRuntimeZod.response).toEqual({});
      expect(compiled.needsRuntimeZod.any).toBe(false);
    });

    it("keeps built-in refinements (min/email/int) on the fast path", () => {
      const schema = z.object({
        email: z.string().email(),
        name: z.string().min(2),
        count: z.number().int().min(0),
      });
      expect(schemaNeedsRuntimeZod(schema)).toBe(false);

      const compiled = compileRouteSchema(route({ request: { body: schema } }));
      expect(compiled.needsRuntimeZod.body).toBe(false);
      expect(compiled.fastifySchema.body).toMatchObject({
        properties: { email: { format: "email" } },
      });
    });

    it("handles a route with no schemas at all", () => {
      const compiled = compileRouteSchema(route({}));
      expect(compiled.fastifySchema).toEqual({});
      expect(compiled.needsRuntimeZod.any).toBe(false);
      expect(compiled.runtimeSchemas).toEqual({});
    });
  });

  describe("fallback detection (.refine / .transform / .superRefine)", () => {
    it("flags a .refine() body for runtime Zod and omits it from fastifySchema", () => {
      const body = z
        .object({ password: z.string(), confirm: z.string() })
        .refine((v) => v.password === v.confirm, "passwords must match");

      const compiled = compileRouteSchema(route({ request: { body } }));

      expect(compiled.needsRuntimeZod.body).toBe(true);
      expect(compiled.needsRuntimeZod.any).toBe(true);
      // flagged slot is NOT handed to ajv...
      expect(compiled.fastifySchema.body).toBeUndefined();
      // ...it is retained verbatim for the runtime sync parse instead
      expect(compiled.runtimeSchemas.body).toBe(body);
    });

    it("flags a .transform() body (which also throws in toJSONSchema)", () => {
      const body = z.object({ name: z.string() }).transform((v) => ({
        ...v,
        upper: v.name.toUpperCase(),
      }));

      const compiled = compileRouteSchema(route({ request: { body } }));

      expect(compiled.needsRuntimeZod.body).toBe(true);
      expect(compiled.fastifySchema.body).toBeUndefined();
      expect(compiled.runtimeSchemas.body).toBe(body);
    });

    it("detects a transform nested inside an object property", () => {
      const body = z.object({
        slug: z.string().transform((s) => s.toLowerCase()),
      });
      expect(schemaNeedsRuntimeZod(body)).toBe(true);
    });

    it("detects a refinement nested deep inside the tree", () => {
      const body = z.object({
        outer: z.object({
          scores: z.array(z.number().refine((n) => n >= 0, "non-negative")),
        }),
      });
      expect(schemaNeedsRuntimeZod(body)).toBe(true);
    });

    it("flags .superRefine()", () => {
      const body = z
        .object({ a: z.number(), b: z.number() })
        .superRefine((v, ctx) => {
          if (v.a > v.b) ctx.addIssue({ code: "custom", message: "a>b" });
        });
      expect(schemaNeedsRuntimeZod(body)).toBe(true);
    });

    it("flags only the affected slot, leaving sibling slots on the fast path", () => {
      const compiled = compileRouteSchema(
        route({
          request: {
            params: z.object({ id: z.string() }), // fast
            body: z
              .object({ email: z.string() })
              .refine((v) => v.email.includes("@")), // fallback
          },
          responses: {
            200: z.object({ ok: z.boolean() }), // fast
          },
        }),
      );

      expect(compiled.needsRuntimeZod.params).toBe(false);
      expect(compiled.fastifySchema.params).toBeDefined();
      expect(compiled.needsRuntimeZod.body).toBe(true);
      expect(compiled.fastifySchema.body).toBeUndefined();
      expect(compiled.fastifySchema.response![200]).toBeDefined();
      expect(compiled.needsRuntimeZod.any).toBe(true);
    });

    it("flags a .refine() on a response slot", () => {
      const compiled = compileRouteSchema(
        route({
          responses: {
            200: z.object({ n: z.number() }).refine((v) => v.n > 0),
          },
        }),
      );
      expect(compiled.needsRuntimeZod.response[200]).toBe(true);
      expect(compiled.fastifySchema.response?.[200]).toBeUndefined();
      expect(compiled.runtimeSchemas.response?.[200]).toBeDefined();
    });
  });

  describe("getCompiledSchema caching", () => {
    it("returns a stable, cached result per route object", () => {
      const r = route({ request: { body: z.object({ a: z.string() }) } });
      const first = getCompiledSchema(r);
      const second = getCompiledSchema(r);
      expect(second).toBe(first);
    });

    it("compiles distinct route objects independently", () => {
      const a = getCompiledSchema(route({ request: { body: z.object({ a: z.string() }) } }));
      const b = getCompiledSchema(
        route({ request: { body: z.object({ a: z.string() }).refine(() => true) } }),
      );
      expect(a.needsRuntimeZod.any).toBe(false);
      expect(b.needsRuntimeZod.any).toBe(true);
    });
  });
});
