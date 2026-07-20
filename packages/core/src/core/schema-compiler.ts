/**
 * Boot-Time Schema Compiler
 *
 * The core of the "compile-away Zod" rewrite. Pre-rewrite, the Fastify adapter
 * ran interpreted Zod (`parseAsync`) on params/query/body **and** the response,
 * once per request. This module moves that work to boot: each route's Zod
 * schemas are converted to JSON Schema **once** at registration so Fastify's
 * compiled `ajv` (input validation) and `fast-json-stringify` (response
 * serialization) can do the per-request work instead — with Zod executing 0×
 * per request on compilable routes.
 *
 * Not everything JSON Schema can express, though. `.transform()` /
 * `.refine()` / `.superRefine()` / custom checks encode arbitrary JS predicates
 * that ajv can't represent. For any request/response slot that contains one, we
 * flag `needsRuntimeZod` and keep the original Zod schema in `runtimeSchemas`;
 * the adapter (Sprint 2) runs a **sync** `schema.parse()` for just that slot and
 * skips ajv there, leaving every other slot on the fast path.
 *
 * Detection is two-pronged, because Zod 4's `z.toJSONSchema` is inconsistent
 * about signalling the two cases:
 *   - `.transform()` **throws** ("Transforms cannot be represented in JSON
 *     Schema").
 *   - `.refine()` / `.superRefine()` / custom checks **compile silently** —
 *     the predicate is simply dropped, so ajv would happily accept input the
 *     refinement should reject.
 * So we first introspect the schema tree for those constructs, and treat a
 * `toJSONSchema` throw as a backstop for any unrepresentable node the walk
 * didn't anticipate.
 */

import { z } from "zod";
import type { AnyRouteConfig } from "../types/route";

/** A compiled JSON Schema object (draft-07), as consumed by Fastify. */
export type JsonSchema = Record<string, unknown>;

/**
 * The `schema` object handed to `app.route({ schema })`. Keys mirror Fastify's
 * expectations: request `query` becomes `querystring`; responses are keyed by
 * numeric status code. A slot is present only when it compiled to JSON Schema —
 * slots that fell back to runtime Zod are omitted here (they live in
 * `runtimeSchemas`) so ajv never double-validates them.
 */
export interface FastifySchema {
  params?: JsonSchema;
  querystring?: JsonSchema;
  body?: JsonSchema;
  response?: Record<number, JsonSchema>;
}

/**
 * Per-slot flags marking which slots must fall back to runtime Zod. The adapter
 * checks these to decide, per slot, whether to read ajv-validated data (fast
 * path) or run `runtimeSchemas[slot].parse(...)` (fallback path). `any` is a
 * convenience roll-up so the hot path can skip the fallback branch entirely.
 */
export interface NeedsRuntimeZod {
  params: boolean;
  query: boolean;
  body: boolean;
  response: Record<number, boolean>;
  /** True if any request slot or any response code needs runtime Zod. */
  any: boolean;
}

/**
 * The original Zod schemas for slots flagged `needsRuntimeZod`. Only flagged
 * slots appear here; compilable slots are absent (their JSON Schema is in
 * `FastifySchema`). The adapter runs these with **sync** `.parse()` — never
 * `parseAsync` — to avoid a per-request microtask hop.
 */
export interface RuntimeSchemas {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response?: Record<number, z.ZodTypeAny>;
}

/** The full result of compiling one route's schemas at boot. */
export interface CompiledRouteSchema {
  fastifySchema: FastifySchema;
  needsRuntimeZod: NeedsRuntimeZod;
  runtimeSchemas: RuntimeSchemas;
}

/**
 * Walks a Zod schema tree looking for constructs that JSON Schema / ajv cannot
 * represent — i.e. anything that forces the runtime-Zod fallback:
 *   - a `transform` node (`.transform()`, and the transform half of a pipe), and
 *   - a `custom` check (`.refine()` / `.superRefine()` / `z.custom()` — these
 *     all surface as a check whose `def.check === "custom"`).
 *
 * Built-in refinements (`.min()`, `.email()`, `.int()`, …) carry a non-`custom`
 * check kind (`min_length`, `string_format`, `number_format`, …) and stay on
 * the fast path. The walk is generic over Zod 4's `_zod.def` node shape rather
 * than enumerating every node type, so it is resilient across Zod's many
 * wrappers (optional/nullable/default/array/union/pipe/lazy/…). A `seen` guard
 * makes recursive (`z.lazy`) schemas terminate.
 */
export function schemaNeedsRuntimeZod(schema: z.ZodTypeAny): boolean {
  const seen = new Set<object>();

  const walkValue = (val: unknown): boolean => {
    if (!val || typeof val !== "object") return false;
    if (seen.has(val as object)) return false;
    // A Zod schema node carries `_zod`; recurse into it as a node.
    if ("_zod" in (val as Record<string, unknown>)) return walkNode(val);
    seen.add(val as object);
    if (Array.isArray(val)) {
      for (const el of val) if (walkValue(el)) return true;
      return false;
    }
    // A plain container (e.g. an object schema's `shape`): recurse its values.
    for (const child of Object.values(val as Record<string, unknown>)) {
      if (walkValue(child)) return true;
    }
    return false;
  };

  const walkNode = (node: unknown): boolean => {
    if (!node || typeof node !== "object" || seen.has(node)) return false;
    seen.add(node);

    const def = (node as { _zod?: { def?: Record<string, unknown> } })._zod?.def;
    if (!def) return false;

    // Transform nodes are unrepresentable outright.
    if (def.type === "transform") return true;

    // Custom checks (refine / superRefine / z.custom) are unrepresentable.
    const checks = def.checks;
    if (Array.isArray(checks)) {
      for (const check of checks) {
        const checkKind = (
          check as { _zod?: { def?: { check?: unknown } } }
        )?._zod?.def?.check;
        if (checkKind === "custom") return true;
      }
    }

    // Recurse into every child the def references (innerType, element, shape,
    // options, in/out, left/right, valueType, …), skipping the checks array
    // handled above.
    for (const [key, val] of Object.entries(def)) {
      if (key === "checks") continue;
      if (walkValue(val)) return true;
    }

    // `z.lazy` hides its child behind a getter rather than a static def field.
    if (typeof (def as { getter?: unknown }).getter === "function") {
      try {
        if (walkNode((def as { getter: () => unknown }).getter())) return true;
      } catch {
        // A getter that throws can't be introspected; err toward the fallback.
        return true;
      }
    }

    return false;
  };

  return walkNode(schema);
}

/**
 * Compiles a single slot's Zod schema to JSON Schema, or reports that it needs
 * the runtime-Zod fallback. `io` selects Zod's input vs output view: request
 * slots use `"input"` (what the client sends, pre-transform/coercion) and
 * responses use `"output"` (the serialized shape; also yields
 * `additionalProperties: false`, which lets `fast-json-stringify` strip
 * unlisted fields — preserving the "no accidental data leaks" behavior).
 */
function compileSlot(
  schema: z.ZodTypeAny,
  io: "input" | "output",
): { json?: JsonSchema; needsRuntime: boolean } {
  if (schemaNeedsRuntimeZod(schema)) return { needsRuntime: true };
  try {
    const json = z.toJSONSchema(schema, {
      target: "draft-7",
      io,
    }) as JsonSchema;
    // Strip the meta `$schema` pointer: Fastify's ajv already runs at draft-07,
    // and an embedded `$schema` only invites meta-schema resolution.
    delete json.$schema;
    return { json, needsRuntime: false };
  } catch {
    // Backstop: an unrepresentable node the introspection walk didn't catch.
    return { needsRuntime: true };
  }
}

/**
 * Compiles all of a route's request/response Zod schemas to JSON Schema at boot,
 * flagging any slot that must fall back to runtime Zod. Pure: does not mutate
 * the route. See {@link getCompiledSchema} for the cached, per-route entry point
 * the adapter uses.
 */
export function compileRouteSchema(route: AnyRouteConfig): CompiledRouteSchema {
  const fastifySchema: FastifySchema = {};
  const runtimeSchemas: RuntimeSchemas = {};
  const needsRuntimeZod: NeedsRuntimeZod = {
    params: false,
    query: false,
    body: false,
    response: {},
    any: false,
  };

  const request = route.request ?? {};

  if (request.params) {
    const r = compileSlot(request.params, "input");
    if (r.needsRuntime) {
      needsRuntimeZod.params = true;
      runtimeSchemas.params = request.params;
    } else {
      fastifySchema.params = r.json;
    }
  }

  if (request.query) {
    const r = compileSlot(request.query, "input");
    if (r.needsRuntime) {
      needsRuntimeZod.query = true;
      runtimeSchemas.query = request.query;
    } else {
      // Fastify names the query slot `querystring`.
      fastifySchema.querystring = r.json;
    }
  }

  if (request.body) {
    const r = compileSlot(request.body, "input");
    if (r.needsRuntime) {
      needsRuntimeZod.body = true;
      runtimeSchemas.body = request.body;
    } else {
      fastifySchema.body = r.json;
    }
  }

  if (route.responses) {
    for (const [codeStr, schema] of Object.entries(route.responses)) {
      const code = Number(codeStr);
      const r = compileSlot(schema as z.ZodTypeAny, "output");
      if (r.needsRuntime) {
        needsRuntimeZod.response[code] = true;
        (runtimeSchemas.response ??= {})[code] = schema as z.ZodTypeAny;
      } else {
        (fastifySchema.response ??= {})[code] = r.json!;
      }
    }
  }

  needsRuntimeZod.any =
    needsRuntimeZod.params ||
    needsRuntimeZod.query ||
    needsRuntimeZod.body ||
    Object.values(needsRuntimeZod.response).some(Boolean);

  return { fastifySchema, needsRuntimeZod, runtimeSchemas };
}

/**
 * Cache of compiled schemas keyed by the route object, so a route is compiled
 * exactly once (at registration) and never per request. A `WeakMap` keeps this
 * non-invasive — no extra field on `RouteConfig`, and entries are collected with
 * their routes. The adapter should call this once per route at boot and hold the
 * result in its handler closure.
 */
const cache = new WeakMap<AnyRouteConfig, CompiledRouteSchema>();

/**
 * Returns the route's {@link CompiledRouteSchema}, compiling and caching it on
 * first call. Idempotent per route object.
 */
export function getCompiledSchema(route: AnyRouteConfig): CompiledRouteSchema {
  let compiled = cache.get(route);
  if (!compiled) {
    compiled = compileRouteSchema(route);
    cache.set(route, compiled);
  }
  return compiled;
}
