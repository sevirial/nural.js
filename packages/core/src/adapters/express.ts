/**
 * Express Adapter
 * Implements ServerAdapter for Express framework
 */

import type { Express, Request, RequestHandler, Response } from "express";
import http from "http";
import Ajv, { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import fastJson from "fast-json-stringify";
import { getCompiledSchema } from "../core/schema-compiler";
import { requireEngine } from "../core/optional-engine";
import type {
  ErrorContext,
  FastifyValidationError,
  ResolvedErrorHandlerConfig,
} from "../types/error";
import {
  DEFAULT_ERROR_HANDLER_CONFIG,
  zodErrorFromValidation,
} from "../types/error";
import type { AnyRouteConfig } from "../types/route";
import type { ServerAdapter, StaticRouteResponse } from "./base";
import { findAvailablePort } from "./find-port";

/**
 * Lazily resolve the Express engine at adapter construction — not at module
 * load. The engine is an (external) peer dependency; deferring the `require`
 * until an app actually selects the Express engine means a Fastify-only
 * consumer never has to install `express`. `require` is native in the CJS build
 * and provided by tsup's `shims` in the ESM build.
 */
type ExpressFactory = (() => Express) & { json: () => RequestHandler };
function loadExpress(): ExpressFactory {
  return requireEngine<ExpressFactory>(
    "express",
    "Nuraljs: the Express engine was selected (framework: 'express') but the 'express' package is not installed. Run `npm install express`.",
  );
}

/**
 * Express adapter implementation
 */
export class ExpressAdapter implements ServerAdapter {
  public app: Express;
  public server: http.Server;
  private errorConfig: ResolvedErrorHandlerConfig;
  /**
   * One Ajv instance for the whole adapter — routes compile their slot schemas
   * into it once at boot (F.4 fast path). Options mirror Fastify 5's defaults so
   * behavior matches the Fastify engine: array coercion + defaults for
   * params/query, `strict:false` to accept every keyword Zod's JSON Schema emits.
   */
  private ajv: Ajv;
  /**
   * A single shared JSON body parser, attached **per route** only to
   * body-carrying methods (T7.6) instead of globally — so GET/HEAD/OPTIONS
   * never pay body-parsing overhead.
   */
  private jsonParser: RequestHandler;

  constructor(errorConfig?: ResolvedErrorHandlerConfig) {
    const express = loadExpress();
    this.app = express();
    this.jsonParser = express.json();
    this.server = http.createServer(this.app);
    this.errorConfig = errorConfig ?? DEFAULT_ERROR_HANDLER_CONFIG;

    this.ajv = new Ajv({
      coerceTypes: "array",
      useDefaults: true,
      removeAdditional: true,
      allErrors: false,
      strict: false,
    });
    addFormats(this.ajv);
  }

  /**
   * Run a compiled ajv validator on a request slot (F.4 fast path). ajv coerces
   * the data in place (string→number for params/query) and fills defaults; on
   * failure we remap its errors into a real `ZodError` via the SAME helper the
   * Fastify path uses, so the 400 body is byte-identical across engines.
   */
  private validateSlot(
    validate: ValidateFunction,
    data: unknown,
    context: string,
  ): unknown {
    if (!validate(data)) {
      const fail = Object.assign(new Error("Request validation failed"), {
        validation: validate.errors ?? [],
        validationContext: context,
      });
      throw zodErrorFromValidation(fail as unknown as FastifyValidationError);
    }
    return data;
  }

  listen(port: number, cb?: (actualPort: number) => void): http.Server {
    // Outside production, behave like `next dev`: move to the next free port if
    // the requested one is taken, and say so.
    if (process.env.NODE_ENV !== "production") {
      findAvailablePort(port).then((freePort) => {
        if (freePort !== port) {
          console.warn(`⚠  Port ${port} is in use — starting on ${freePort} instead.`);
        }
        this.server.listen(freePort, () => cb?.(freePort));
      });
      return this.server;
    }
    return this.server.listen(port, () => cb?.(port));
  }

  use(middleware: RequestHandler): void {
    this.app.use(middleware);
  }

  /**
   * Handle errors using the configured error handler
   */
  private async handleError(
    error: Error,
    req: Request,
    res: Response,
    path?: string,
  ): Promise<void> {
    const ctx: ErrorContext = {
      error,
      request: req,
      response: res,
      path: path ?? req.path,
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
          res.setHeader(key, value);
        });
      }

      // Include stack in development mode
      const body = { ...errorResponse.body };
      if (this.errorConfig.includeStack && error.stack) {
        body.stack = error.stack;
      }

      res.status(errorResponse.status).json(body);
    } catch (handlerError) {
      // Fallback if error handler itself fails
      console.error("[Nuraljs] Error handler failed:", handlerError);
      res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  }

  registerStaticRoute(
    method: "get",
    path: string,
    handler: (req: Request) => Promise<StaticRouteResponse>,
  ): void {
    this.app[method](path, async (req, res) => {
      try {
        const result = await handler(req);
        if (result.type === "html") {
          res.set("Content-Type", "text/html");
          res.send(result.data);
        } else if (result.type === "js") {
          res.set("Content-Type", "application/javascript; charset=utf-8");
          res.send(result.data);
        } else {
          res.json(result.data);
        }
      } catch (err) {
        await this.handleError(err as Error, req, res, path);
      }
    });
  }

  registerRoute(route: AnyRouteConfig): void {
    // ---- Boot-time precompute (runs once per route at registration) ----
    // Reuse the engine-agnostic schema-compiler (Sprint 1): the SAME compiled
    // JSON Schema the Fastify hot path uses. Compilable slots get an ajv
    // validate fn + fast-json-stringify serializer; slots that fell back to
    // runtime Zod keep their Zod schema for a sync `.parse()`.
    const { fastifySchema, needsRuntimeZod, runtimeSchemas } =
      getCompiledSchema(route);

    // Success status code, precomputed here (not per request).
    const responses = route.responses ?? {};
    const successCode = Number(
      Object.keys(responses).find((c) => c.startsWith("2")) ?? "200",
    );

    // T7.1 — compile ajv validators for compilable request slots (flagged slots
    // are omitted from `fastifySchema`, so they stay `undefined` here).
    const validateParams =
      fastifySchema.params && !needsRuntimeZod.params
        ? this.ajv.compile(fastifySchema.params)
        : undefined;
    const validateQuery =
      fastifySchema.querystring && !needsRuntimeZod.query
        ? this.ajv.compile(fastifySchema.querystring)
        : undefined;
    const validateBody =
      fastifySchema.body && !needsRuntimeZod.body
        ? this.ajv.compile(fastifySchema.body)
        : undefined;

    // Runtime-Zod fallback schemas for flagged slots (sync `.parse()`, never
    // `parseAsync` — matches the Fastify adapter's fallback decision).
    const paramsRuntime = needsRuntimeZod.params
      ? runtimeSchemas.params
      : undefined;
    const queryRuntime = needsRuntimeZod.query ? runtimeSchemas.query : undefined;
    const bodyRuntime = needsRuntimeZod.body ? runtimeSchemas.body : undefined;

    // T7.3 — compile a fast-json-stringify serializer per declared status code
    // (skips the output `parseAsync` AND `JSON.stringify`, and strips unlisted
    // fields for EVERY code). A slot flagged for runtime Zod falls back to a
    // sync `.parse()` at send time.
    const stringifyByCode: Record<number, ReturnType<typeof fastJson>> = {};
    for (const [codeStr, respSchema] of Object.entries(fastifySchema.response ?? {})) {
      const code = Number(codeStr);
      if (!needsRuntimeZod.response[code]) {
        stringifyByCode[code] = fastJson(
          respSchema as unknown as Parameters<typeof fastJson>[0],
        );
      }
    }

    const middleware = route.middleware;
    const hasMiddleware = Array.isArray(middleware) && middleware.length > 0;

    const handler: RequestHandler = async (req, res) => {
      try {
        // T7.5 — build the handler context by MUTATING one bag (no per-middleware
        // spread, no final spread), mirroring the Fastify adapter. Middleware
        // results are assigned first; params/query/body/req/res are assigned last
        // so they keep precedence over any same-named middleware keys.
        const ctx: Record<string, unknown> = {};
        if (hasMiddleware) {
          for (const mw of middleware!) {
            const result = await mw(req, res);
            if (result && typeof result === "object") {
              Object.assign(ctx, result);
            }
          }
        }

        // T7.2 — input validation: ajv fast path (sync, coerces in place) →
        // runtime-Zod fallback (sync `.parse()`) → raw pass-through. 0×
        // `parseAsync` on the fast path.
        ctx.params = validateParams
          ? this.validateSlot(validateParams, req.params, "params")
          : paramsRuntime
            ? paramsRuntime.parse(req.params)
            : req.params;
        ctx.query = validateQuery
          ? this.validateSlot(validateQuery, req.query, "querystring")
          : queryRuntime
            ? queryRuntime.parse(req.query)
            : req.query;
        ctx.body = validateBody
          ? this.validateSlot(validateBody, req.body, "body")
          : bodyRuntime
            ? bodyRuntime.parse(req.body)
            : req.body;
        ctx.req = req;
        ctx.res = res;

        // Functional status selection: `status(code)` picks which declared
        // response the returned value is shaped by (defaults to the success code).
        let statusCode = successCode;
        (ctx as { status: (code: number) => void }).status = (code) => {
          statusCode = code;
        };

        // 4. Execute Handler
        const result = await route.handler(ctx);

        // Handler may have responded imperatively via the raw `res`.
        if (res.headersSent) return;

        // T7.3 — response: fast-json-stringify per code (compiled, strips
        // extras) → runtime-Zod fallback (`.parse()`) → Express json.
        if (result === undefined) {
          res.status(statusCode).end();
        } else {
          const stringify = stringifyByCode[statusCode];
          if (stringify) {
            res
              .status(statusCode)
              .set("Content-Type", "application/json")
              .end(stringify(result));
          } else {
            const responseRuntime = needsRuntimeZod.response[statusCode]
              ? runtimeSchemas.response?.[statusCode]
              : undefined;
            res
              .status(statusCode)
              .json(responseRuntime ? responseRuntime.parse(result) : result);
          }
        }
      } catch (err) {
        await this.handleError(err as Error, req, res, route.path);
      }
    };

    // Register route. T7.6 — attach the shared JSON body parser ONLY to
    // body-carrying methods, so GET/HEAD/OPTIONS never pay body-parsing cost
    // (replaces the old global `app.use(express.json())`).
    const path = route.path;
    const bodyMethod =
      route.method === "POST" ||
      route.method === "PUT" ||
      route.method === "PATCH" ||
      route.method === "DELETE" ||
      route.method === "ALL";
    const chain: RequestHandler[] = bodyMethod
      ? [this.jsonParser, handler]
      : [handler];
    switch (route.method) {
      case "GET":
        this.app.get(path, ...chain);
        break;
      case "POST":
        this.app.post(path, ...chain);
        break;
      case "PUT":
        this.app.put(path, ...chain);
        break;
      case "PATCH":
        this.app.patch(path, ...chain);
        break;
      case "DELETE":
        this.app.delete(path, ...chain);
        break;
      case "OPTIONS":
        this.app.options(path, ...chain);
        break;
      case "HEAD":
        this.app.head(path, ...chain);
        break;
      case "ALL":
        this.app.all(path, ...chain);
        break;
    }
  }
}
