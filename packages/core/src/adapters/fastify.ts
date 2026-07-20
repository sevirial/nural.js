/**
 * Fastify Adapter
 * Implements ServerAdapter for Fastify framework
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HTTPMethods,
  RawServerDefault,
} from "fastify";
import { getCompiledSchema } from "../core/schema-compiler";
import { requireEngine } from "../core/optional-engine";
import type { ErrorContext, ResolvedErrorHandlerConfig } from "../types/error";
import {
  DEFAULT_ERROR_HANDLER_CONFIG,
  isValidationError,
  zodErrorFromValidation,
} from "../types/error";
import type { AnyRouteConfig } from "../types/route";
import type { ServerAdapter, StaticRouteResponse } from "./base";
import { findAvailablePort } from "./find-port";

/**
 * Per-request context bag stashed on the Fastify request by the middleware
 * `preValidation` hook. Decorated once at boot (`app.decorateRequest`) and
 * populated per request without spreads — see {@link FastifyAdapter.registerRoute}.
 */
declare module "fastify" {
  interface FastifyRequest {
    nuralCtx: Record<string, unknown> | null;
  }
}

/**
 * Lazily resolve the Fastify engine at adapter construction — not at module
 * load. The engine is an (external) peer dependency; deferring the `require`
 * until an app actually selects `framework: "fastify"` means an Express-only
 * consumer never has to install `fastify`. `require` is native in the CJS build
 * and provided by tsup's `shims` in the ESM build.
 */
type FastifyFactory = (opts?: Record<string, unknown>) => FastifyInstance;
function loadFastify(): FastifyFactory {
  return requireEngine<FastifyFactory>(
    "fastify",
    "Nuraljs: the Fastify engine was selected (framework: 'fastify') but the 'fastify' package is not installed. Run `npm install fastify`.",
  );
}

/**
 * Fastify adapter implementation
 */
export class FastifyAdapter implements ServerAdapter {
  public app: FastifyInstance;
  private errorConfig: ResolvedErrorHandlerConfig;

  get server() {
    return this.app.server;
  }

  constructor(errorConfig?: ResolvedErrorHandlerConfig) {
    // `strictSchema: false` lets ajv IGNORE (rather than throw on) non-validation
    // keywords in a compiled schema. Our schemas are generated from Zod, so the
    // only unknown keywords that ever appear are intentional OpenAPI annotations
    // authored via `.meta()`/`.openapi()` — e.g. `example`, `x-*` extensions —
    // which the same schema carries for the docs. Without this, ajv's strict mode
    // fails the whole route build with `unknown keyword: "example"`. Validation
    // results and 400 error shapes are unaffected (unknown keywords are simply
    // not validated, per JSON Schema); no user typo is masked, since no one hand-
    // writes these validation keywords.
    this.app = loadFastify()({ ajv: { customOptions: { strictSchema: false } } });
    this.errorConfig = errorConfig ?? DEFAULT_ERROR_HANDLER_CONFIG;

    // Decorate the request once at boot with the middleware context bag. It's a
    // reference type, so it's declared `null` here and assigned a fresh object
    // per request in the middleware hook (Fastify's guidance for object
    // decorators — a shared default object would leak state across requests).
    this.app.decorateRequest("nuralCtx", null);

    // Route all thrown errors through the existing handler. The fast-path
    // handler no longer wraps its body in try/catch — middleware now runs in a
    // `preValidation` hook (outside any handler try/catch), so errors surface
    // here instead. This preserves the previous error bodies for auth (401),
    // HttpException, and the runtime-Zod fallback's ZodError branch.
    this.app.setErrorHandler((error: Error, req, reply) => {
      // ajv validation failures carry `.validation`. Remap them into a real
      // `ZodError` so they flow through the SAME `defaultErrorHandler` branch
      // the pre-rewrite runtime-Zod path used — producing an identical 400 body
      // (`{ error: "VALIDATION_ERROR", message: "Request validation failed",
      // details: [...] }`, plus `stack` in non-prod). HttpException / auth (401)
      // and every other error pass through untouched.
      const err = isValidationError(error)
        ? zodErrorFromValidation(error)
        : error;
      return this.handleError(err, req, reply);
    });
  }

  listen(port: number, cb?: (actualPort: number) => void): RawServerDefault {
    const bind = (p: number) => {
      this.app.listen({ port: p }, (err) => {
        if (err) {
          console.error(err);
          process.exit(1);
        }
        if (cb) cb(p);
      });
    };

    // Outside production, behave like `next dev`: if the requested port is
    // taken, move to the next free one and say so (instead of silently
    // co-existing on a different interface, or crashing).
    if (process.env.NODE_ENV !== "production") {
      findAvailablePort(port).then((freePort) => {
        if (freePort !== port) {
          console.warn(`⚠  Port ${port} is in use — starting on ${freePort} instead.`);
        }
        bind(freePort);
      });
    } else {
      bind(port);
    }

    return this.app.server;
  }

  use(middleware: any): void {
    // Check if middleware is a standard function (req, res, next)
    if (typeof middleware === "function") {
      this.app.addHook("onRequest", async (req, reply) => {
        return new Promise<void>((resolve, reject) => {
          const next = (err?: Error) => {
            if (err) reject(err);
            else resolve();
          };

          // Call the middleware with Fastify objects
          // Note: Some Express middleware might expect 'res' to be http.ServerResponse
          // We pass 'reply' which is the Fastify wrapper.
          // Our internal httpLogger now handles 'reply.raw' so it's safe.
          try {
            const result = middleware(req, reply, next);
            if (result && typeof result.then === "function") {
              result.catch(reject);
            }
          } catch (err) {
            reject(err);
          }
        });
      });
    } else {
      // Fallback for Fastify plugins
      this.app.register(middleware);
    }
  }

  /**
   * Handle errors using the configured error handler
   */
  private async handleError(
    error: Error,
    req: FastifyRequest,
    reply: FastifyReply,
    path?: string,
  ): Promise<void> {
    const ctx: ErrorContext = {
      error,
      request: req,
      response: reply,
      path: path ?? req.url,
      method: req.method,
    };

    // Log error if enabled
    if (this.errorConfig.logErrors) {
      this.errorConfig.logger(error, ctx);
    }

    try {
      // Get error response from handler
      const errorResponse = await this.errorConfig.handler(ctx);

      // Set headers if provided
      if (errorResponse.headers) {
        Object.entries(errorResponse.headers).forEach(([key, value]) => {
          reply.header(key, value);
        });
      }

      // Include stack in development mode
      const body = { ...errorResponse.body };
      if (this.errorConfig.includeStack && error.stack) {
        body.stack = error.stack;
      }

      reply.status(errorResponse.status).send(body);
    } catch (handlerError) {
      // Fallback if error handler itself fails
      console.error("[Nuraljs] Error handler failed:", handlerError);
      reply.status(500).send({ error: "INTERNAL_SERVER_ERROR" });
    }
  }

  registerStaticRoute(
    method: "get",
    path: string,
    handler: (req: unknown) => Promise<StaticRouteResponse>,
  ): void {
    this.app.get(path, async (req, reply) => {
      try {
        const result = await handler(req);
        if (result.type === "html") {
          reply.type("text/html").send(result.data);
        } else {
          reply.send(result.data);
        }
      } catch (err) {
        await this.handleError(err as Error, req, reply, path);
      }
    });
  }

  registerRoute(route: AnyRouteConfig): void {
    const url = route.path;

    // ---- Boot-time precompute (runs once per route at registration) ----

    // Compiled JSON Schema + per-slot runtime-Zod fallback flags (Sprint 1).
    // ajv validates the compiled slots per request; Zod runs 0× on the fast path.
    const { fastifySchema, needsRuntimeZod, runtimeSchemas } =
      getCompiledSchema(route);

    // Success status code: first 2xx response, else 200. Precomputed here so the
    // per-request handler never re-scans `responses` (was the old `.find(...)`).
    const responses = route.responses ?? {};
    const successCode = Number(
      Object.keys(responses).find((c) => c.startsWith("2")) ?? "200",
    );

    // Runtime-Zod fallback schemas for the flagged slots (undefined on the fast
    // path). Resolved once here; the handler just checks for presence and runs a
    // **sync** `.parse()` — never `parseAsync`, to avoid a per-request microtask.
    const paramsRuntime = needsRuntimeZod.params
      ? runtimeSchemas.params
      : undefined;
    const queryRuntime = needsRuntimeZod.query
      ? runtimeSchemas.query
      : undefined;
    const bodyRuntime = needsRuntimeZod.body ? runtimeSchemas.body : undefined;

    const middleware = route.middleware;
    const hasMiddleware = Array.isArray(middleware) && middleware.length > 0;

    // ---- Middleware → preValidation hook (runs BEFORE ajv validation) ----
    // Fastify's lifecycle runs `preValidation` ahead of schema validation, so an
    // auth middleware that throws yields 401 *before* a body-validation 400 —
    // preserving Nuraljs's auth-before-validation ordering. Each middleware's
    // returned object is assigned onto a single per-request bag on `req` (no
    // per-middleware spreads, no `new Promise` wrapper).
    const preValidation = hasMiddleware
      ? async (req: FastifyRequest, reply: FastifyReply) => {
          const bag: Record<string, unknown> = {};
          req.nuralCtx = bag;
          for (const mw of middleware!) {
            const result = await mw(req, reply);
            if (result && typeof result === "object") {
              Object.assign(bag, result);
            }
          }
        }
      : undefined;

    // ---- Handler (fast path: 0× Zod) ----
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      // Build the handler context by MUTATING the middleware bag rather than
      // spreading it — one object, zero copies. Fast-path slots read the values
      // ajv already validated/coerced onto `req`; flagged slots fall back to a
      // sync `.parse()` of the raw value.
      const ctx = hasMiddleware
        ? (req.nuralCtx as Record<string, unknown>)
        : ({} as Record<string, unknown>);

      ctx.params = paramsRuntime ? paramsRuntime.parse(req.params) : req.params;
      ctx.query = queryRuntime ? queryRuntime.parse(req.query) : req.query;
      ctx.body = bodyRuntime ? bodyRuntime.parse(req.body) : req.body;
      ctx.req = req;
      ctx.res = reply;

      // Functional status selection: `status(code)` picks which declared
      // response the returned value is shaped by. Defaults to the boot-computed
      // success code, so the common single-status route pays nothing extra.
      let statusCode = successCode;
      (ctx as { status: (code: number) => void }).status = (code) => {
        statusCode = code;
      };

      const result = await route.handler(ctx as never);

      // A handler may still respond imperatively via the raw `res`/reply
      // (legacy escape hatch); if it already sent, don't double-send.
      if (reply.sent) return;

      // Response: Fastify's `schema.response[statusCode]` serializes from the
      // compiled JSON Schema and strips unlisted fields ("no data leaks") for
      // EVERY declared code. A slot flagged for runtime Zod is parsed sync.
      if (result === undefined) {
        reply.status(statusCode).send();
      } else {
        const responseRuntime = needsRuntimeZod.response[statusCode]
          ? runtimeSchemas.response?.[statusCode]
          : undefined;
        reply.status(statusCode).send(responseRuntime ? responseRuntime.parse(result) : result);
      }
    };

    this.app.route({
      method: route.method as HTTPMethods,
      url,
      schema: fastifySchema as object,
      ...(preValidation ? { preValidation } : {}),
      handler,
    });
  }
}
