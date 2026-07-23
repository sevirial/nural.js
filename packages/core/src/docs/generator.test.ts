/**
 * Documentation Generator Tests (Sprint 4)
 *
 * Exercise the native OpenAPI generation that replaced
 * `@asteasolutions/zod-to-openapi`: `:param`→`{param}` paths, params/query →
 * OpenAPI `parameters`, body → `requestBody`, responses by status code, and
 * preservation of `security`, `tags`, `.meta()`, and user `openapi` overrides.
 * A final case serves the spec + UI over HTTP through the real Fastify adapter
 * to confirm `/docs` and `/docs/openapi.json` still generate.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { DocumentationGenerator } from "./generator";
import { FastifyAdapter } from "../adapters/fastify";
import { resolveDocsConfig } from "../types/config";
import { resolveErrorHandlerConfig } from "../types/error";
import type { AnyRouteConfig } from "../types/route";

const route = (cfg: Partial<AnyRouteConfig>): AnyRouteConfig =>
  ({
    method: "GET",
    path: "/x",
    handler: () => undefined,
    ...cfg,
  }) as AnyRouteConfig;

const gen = (routes: AnyRouteConfig[], docs: object = {}) => {
  const g = new DocumentationGenerator(resolveDocsConfig({ ...docs } as never));
  routes.forEach((r) => g.addRoute(r));
  return g.generateSpec() as any;
};

describe("DocumentationGenerator (native OpenAPI)", () => {
  it("emits an OpenAPI 3.0 document with info + servers", () => {
    const spec = gen([], {
      openApi: { info: { title: "My API", version: "2.0.0" } },
    });
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toBe("My API");
    expect(spec.info.version).toBe("2.0.0");
    expect(spec.servers).toBeDefined();
  });

  it("converts :param to {param} in the path", () => {
    const spec = gen([
      route({ method: "GET", path: "/users/:id/posts/:postId" }),
    ]);
    expect(spec.paths["/users/{id}/posts/{postId}"]).toBeDefined();
    expect(spec.paths["/users/{id}/posts/{postId}"].get).toBeDefined();
  });

  it("splits params/query into OpenAPI parameters with correct `in`/`required`", () => {
    const spec = gen([
      route({
        method: "GET",
        path: "/users/:id",
        request: {
          params: z.object({ id: z.string() }),
          query: z.object({ page: z.number().int(), q: z.string().optional() }),
        },
      }),
    ]);

    const params = spec.paths["/users/{id}"].get.parameters as any[];
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));

    expect(byName.id.in).toBe("path");
    expect(byName.id.required).toBe(true); // path params always required
    expect(byName.id.schema.type).toBe("string");

    expect(byName.page.in).toBe("query");
    expect(byName.page.required).toBe(true);
    expect(byName.q.in).toBe("query");
    expect(byName.q.required).toBe(false); // optional query param
  });

  it("emits a JSON requestBody for the body schema", () => {
    const spec = gen([
      route({
        method: "POST",
        path: "/users",
        request: { body: z.object({ name: z.string(), age: z.number() }) },
      }),
    ]);

    const schema =
      spec.paths["/users"].post.requestBody.content["application/json"].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.name.type).toBe("string");
    expect(schema.required).toContain("name");
  });

  it("strips Zod 4's redundant `pattern` from string formats, keeping `format`", () => {
    const spec = gen([
      route({
        method: "POST",
        path: "/login",
        request: {
          body: z.object({
            email: z.string().email().meta({ example: "user@example.com" }),
            id: z.string().uuid(),
            tags: z.array(z.string().url()), // nested inside an array
          }),
        },
      }),
    ]);

    const props =
      spec.paths["/login"].post.requestBody.content["application/json"].schema
        .properties;

    // `format` survives (drives the clean Scalar label + example generation)…
    expect(props.email.format).toBe("email");
    expect(props.id.format).toBe("uuid");
    expect(props.tags.items.format).toBe("uri");

    // …but the noisy derived regex is gone at every level.
    expect(props.email).not.toHaveProperty("pattern");
    expect(props.id).not.toHaveProperty("pattern");
    expect(props.tags.items).not.toHaveProperty("pattern");

    // A user-supplied example still flows through untouched.
    expect(props.email.example).toBe("user@example.com");
  });

  it("keeps a `pattern` that is NOT backed by a format (a plain .regex())", () => {
    const spec = gen([
      route({
        method: "POST",
        path: "/code",
        request: { body: z.object({ code: z.string().regex(/^[A-Z]{3}$/) }) },
      }),
    ]);

    const props =
      spec.paths["/code"].post.requestBody.content["application/json"].schema
        .properties;
    expect(props.code.pattern).toBeDefined(); // no format ⇒ pattern is the constraint
  });

  it("maps responses by status code with schema + description from .meta()", () => {
    const spec = gen([
      route({
        method: "GET",
        path: "/u",
        responses: {
          200: z.object({ id: z.string() }).meta({ description: "The user" }),
          404: z.object({ message: z.string() }),
        },
      }),
    ]);

    const responses = spec.paths["/u"].get.responses;
    expect(responses["200"].description).toBe("The user");
    expect(
      responses["200"].content["application/json"].schema.properties.id.type,
    ).toBe("string");
    expect(responses["404"].description).toBe("Response"); // default
  });

  it("uses OpenAPI-3.0 nullable representation (not draft-07 anyOf)", () => {
    const spec = gen([
      route({
        method: "POST",
        path: "/n",
        request: { body: z.object({ bio: z.string().nullable() }) },
      }),
    ]);
    const schema =
      spec.paths["/n"].post.requestBody.content["application/json"].schema;
    expect(schema.properties.bio.nullable).toBe(true);
    expect(schema.properties.bio).not.toHaveProperty("anyOf");
    expect(schema).not.toHaveProperty("$schema");
  });

  it("preserves route security and tags on the operation", () => {
    const spec = gen([
      route({
        method: "GET",
        path: "/secure",
        tags: ["admin"],
        security: [{ bearerAuth: [] }],
      }),
    ]);
    const op = spec.paths["/secure"].get;
    expect(op.tags).toEqual(["admin"]);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
  });

  it("merges user openapi operation overrides (overrides win)", () => {
    const spec = gen([
      route({
        method: "GET",
        path: "/o",
        summary: "original",
        openapi: { summary: "overridden", operationId: "customOp" },
      }),
    ]);
    const op = spec.paths["/o"].get;
    expect(op.summary).toBe("overridden");
    expect(op.operationId).toBe("customOp");
  });

  it("carries user components.securitySchemes into the spec", () => {
    const spec = gen([], {
      openApi: {
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer" },
          },
        },
      },
    });
    expect(spec.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
    });
  });

  it("does not crash on a .transform() body (input-side shape is representable)", () => {
    const spec = gen([
      route({
        method: "POST",
        path: "/t",
        request: {
          body: z.object({ name: z.string() }).transform((v) => v),
        },
      }),
    ]);
    // A transform's INPUT view (what the client sends) is representable, so docs
    // show the pre-transform shape rather than crashing.
    const schema =
      spec.paths["/t"].post.requestBody.content["application/json"].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.name.type).toBe("string");
  });

  it("falls back to a permissive schema for an unrepresentable response transform", () => {
    const spec = gen([
      route({
        method: "GET",
        path: "/tr",
        // Output-side transform throws in toJSONSchema → degrades to `{}` so
        // docs generation never crashes on an otherwise-valid route.
        responses: {
          200: z.object({ name: z.string() }).transform((v) => ({
            up: v.name.toUpperCase(),
          })),
        },
      }),
    ]);
    const schema =
      spec.paths["/tr"].get.responses["200"].content["application/json"].schema;
    expect(schema).toEqual({});
  });

  it("keeps a .refine() route representable (predicate dropped, shape intact)", () => {
    const spec = gen([
      route({
        method: "POST",
        path: "/r",
        request: {
          body: z
            .object({ a: z.string(), b: z.string() })
            .refine((v) => v.a === v.b),
        },
      }),
    ]);
    const schema =
      spec.paths["/r"].post.requestBody.content["application/json"].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.a.type).toBe("string");
  });

  describe("HTML output unchanged", () => {
    it("Scalar HTML embeds the spec URL + self-hosted (non-CDN) bundle", () => {
      const g = new DocumentationGenerator(resolveDocsConfig({} as never));
      const html = g.getScalarHtml("/docs/openapi.json", "/docs/scalar.js");
      expect(html).toContain('data-url="/docs/openapi.json"');
      expect(html).toContain('src="/docs/scalar.js"');
      // Self-hosted: no third-party CDN reference.
      expect(html).not.toContain("cdn.jsdelivr.net");
    });

    it("getScalarBundle returns the self-contained standalone bundle", () => {
      const g = new DocumentationGenerator(resolveDocsConfig({} as never));
      const bundle = g.getScalarBundle();
      expect(bundle.length).toBeGreaterThan(1000);
      // The self-hosted IIFE must not reach back out to the CDN at runtime.
      expect(bundle).not.toContain("cdn.jsdelivr.net");
    });

    it("Swagger HTML embeds the spec URL + Swagger bundle", () => {
      const g = new DocumentationGenerator(resolveDocsConfig({} as never));
      const html = g.getSwaggerHtml("/docs/openapi.json");
      expect(html).toContain('url: "/docs/openapi.json"');
      expect(html).toContain("swagger-ui-bundle.js");
    });
  });

  it("serves /docs + /docs/openapi.json over HTTP via the Fastify adapter", async () => {
    // Mirror `nural.ts:setupDocs` against the real adapter, then inject.
    const g = new DocumentationGenerator(
      resolveDocsConfig({
        openApi: { info: { title: "Live API", version: "9.9.9" } },
      } as never),
    );
    g.addRoute(
      route({
        method: "GET",
        path: "/users/:id",
        request: { params: z.object({ id: z.string() }) },
        responses: { 200: z.object({ id: z.string() }) },
      }),
    );

    const adapter = new FastifyAdapter(
      resolveErrorHandlerConfig({ logErrors: false }),
    );
    const specPath = "/docs/openapi.json";
    adapter.registerStaticRoute("get", specPath, async () => ({
      type: "json",
      data: g.generateSpec(),
    }));
    adapter.registerStaticRoute("get", "/docs/scalar.js", async () => ({
      type: "js",
      data: g.getScalarBundle(),
    }));
    adapter.registerStaticRoute("get", "/docs", async () => ({
      type: "html",
      data: g.getScalarHtml(specPath, "/docs/scalar.js"),
    }));

    const jsonRes = await adapter.app.inject({ method: "GET", url: specPath });
    expect(jsonRes.statusCode).toBe(200);
    const spec = jsonRes.json();
    expect(spec.openapi).toBe("3.0.0");
    expect(spec.info.title).toBe("Live API");
    expect(spec.paths["/users/{id}"].get.parameters[0].name).toBe("id");

    const htmlRes = await adapter.app.inject({ method: "GET", url: "/docs" });
    expect(htmlRes.statusCode).toBe(200);
    expect(htmlRes.headers["content-type"]).toContain("text/html");
    expect(htmlRes.body).toContain('src="/docs/scalar.js"');
    expect(htmlRes.body).not.toContain("cdn.jsdelivr.net");

    // The self-hosted bundle is served same-origin as JavaScript.
    const jsRes = await adapter.app.inject({
      method: "GET",
      url: "/docs/scalar.js",
    });
    expect(jsRes.statusCode).toBe(200);
    expect(jsRes.headers["content-type"]).toContain("application/javascript");
    expect(jsRes.body.length).toBeGreaterThan(1000);
  });
});
