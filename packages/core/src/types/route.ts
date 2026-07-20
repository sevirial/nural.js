/**
 * Route Types
 * Type definitions for route configuration and handlers
 */

import type { Request, Response } from "express";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { MiddlewareHandler } from "../core/middleware";
import type { HttpMethod } from "./http";

/**
 * Generic Zod type - either a Zod schema or undefined
 */
export type ZodAny = z.ZodTypeAny | undefined;

/**
 * Inference helper: extracts type from Zod schema, returns unknown if undefined
 */
export type InferZ<T extends ZodAny> = T extends z.ZodTypeAny
  ? z.infer<T>
  : unknown;

/* -------------------------------------------------------------------------- */
/*  Framework-aware `req` / `res` typing                                       */
/* -------------------------------------------------------------------------- */
//
// The engine is chosen at runtime in `new Nuraljs({ framework })`, but a runtime
// value can't flow into the *types* of routes defined in other files. So the
// framework is declared once at the type level via module augmentation, and
// every handler's `ctx.req` / `ctx.res` are narrowed to that engine — no
// per-handler casts, and no dependency on the *other* engine's `@types`.

/**
 * Compile-time framework selection. **You normally never touch this.** NuralJS is
 * Fastify-first, so `req` / `res` default to Fastify's types with zero config —
 * a Fastify app needs no declaration at all.
 *
 * Only the *legacy Express* path overrides it, and `@nuraljs/cli` scaffolds that
 * override automatically for Express projects, so it's still hands-off:
 *
 * ```ts
 * declare module "@nuraljs/core" {
 *   interface NuralTypeOptions {
 *     framework: "express";
 *   }
 * }
 * ```
 */
export interface NuralTypeOptions {}

/**
 * The framework driving `req` / `res` types: whatever {@link NuralTypeOptions}
 * declares, otherwise **Fastify** (the default engine — no config needed).
 */
export type ConfiguredFramework = NuralTypeOptions extends {
  framework: infer F extends "express" | "fastify";
}
  ? F
  : "fastify";

/**
 * The concrete request type for a framework. Distributes over the union, so the
 * default (`"express" | "fastify"`) yields `Request | FastifyRequest` while a
 * single declared framework yields exactly that engine's request.
 */
export type FrameworkRequest<
  F extends "express" | "fastify" = ConfiguredFramework,
> = F extends "fastify" ? FastifyRequest : F extends "express" ? Request : never;

/** The concrete response type for a framework (see {@link FrameworkRequest}). */
export type FrameworkResponse<
  F extends "express" | "fastify" = ConfiguredFramework,
> = F extends "fastify" ? FastifyReply : F extends "express" ? Response : never;

/**
 * Distribute a union to its intersection.
 * @example string | number -> string & number
 */
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * The context a middleware contributes: its returned object, with `void`
 * (a middleware that returns nothing) contributing an empty bag.
 */
type ContextOf<M> = M extends (...args: any[]) => infer R
  ? Exclude<Awaited<R>, void> extends infer C
    ? [C] extends [Record<string, unknown>]
      ? C
      : {}
    : {}
  : {};

/**
 * Infer the context contract a middleware — or a tuple of middlewares —
 * places on `req.nuralCtx`. Pass a single middleware for its own return, or a
 * tuple to get the intersection of every middleware's contribution (the shape
 * seen after they've all run).
 *
 * @example
 * ```ts
 * type Auth = InferMiddleware<typeof authMiddleware>;              // { user: User }
 * type Both = InferMiddleware<[typeof authMw, typeof tenantMw]>;   // { user } & { tenant }
 * ```
 */
export type InferMiddleware<M> = M extends readonly unknown[]
  ? UnionToIntersection<{ [K in keyof M]: ContextOf<M[K]> }[number]>
  : ContextOf<M>;

/**
 * Convert an array of middlewares into the intersection of their contributed
 * contexts — what the handler sees merged onto its context.
 * @example [() => {user}, () => {role}] -> {user} & {role}
 */
type MergeMiddlewareTypes<M extends MiddlewareHandler<any, any>[] | undefined> =
  M extends readonly unknown[] ? InferMiddleware<M> : {};

/**
 * Context passed to route handlers
 */
export type RouteContext<
  P extends ZodAny,
  Q extends ZodAny,
  B extends ZodAny,
  M extends MiddlewareHandler<any, any>[] | undefined,
  Services extends Record<string, unknown> = Record<string, unknown>
> = {
  /** Validated path parameters */
  params: InferZ<P>;
  /** Validated query parameters */
  query: InferZ<Q>;
  /** Validated request body */
  body: InferZ<B>;
  /**
   * Raw request object. Typed for the framework declared in
   * {@link NuralTypeOptions} — `FastifyRequest`, `Request` (Express), or their
   * union when no framework is declared.
   */
  req: FrameworkRequest;
  /**
   * Raw response object. Typed for the framework declared in
   * {@link NuralTypeOptions} — `FastifyReply`, `Response` (Express), or their
   * union when no framework is declared.
   */
  res: FrameworkResponse;
  /**
   * Choose which declared status code the value you `return` is sent with.
   * Defaults to the first `2xx` in `responses` (else `200`); the returned body
   * is still shaped by that code's schema. Keeps the functional "return your
   * data" model — no need to touch `res`.
   *
   * @example
   * handler: async ({ status }) => {
   *   if (queued) { status(202); return { message: "queued" }; }
   *   return { id: "123" }; // first 2xx by default
   * }
   */
  status: (code: number) => void;
} & MergeMiddlewareTypes<M> & Services;

/**
 * Route handler function type
 */
export type RouteHandler<
  P extends ZodAny,
  Q extends ZodAny,
  B extends ZodAny,
  R extends ZodAny,
  M extends MiddlewareHandler<any, any>[] | undefined,
  Services extends Record<string, unknown> = Record<string, unknown>
> = (
  ctx: RouteContext<P, Q, B, M, Services>,
) => Promise<InferZ<R> | void> | InferZ<R> | void;

/**
 * Route configuration object
 */
export interface RouteConfig<
  P extends ZodAny = undefined,
  Q extends ZodAny = undefined,
  B extends ZodAny = undefined,
  R extends ZodAny = undefined,
  M extends MiddlewareHandler<any, any>[] | undefined = undefined,
  Services extends Record<string, unknown> = Record<string, unknown>
> {
  /** HTTP method */
  method: HttpMethod;
  /** Route path (supports :param syntax) */
  path: string;
  /** Short summary for documentation */
  summary?: string;
  /** Detailed description for documentation */
  description?: string;
  /** Tags for grouping in documentation */
  tags?: string[];
  /** Middleware to run before handler */
  middleware?: M;
  /** Request validation schemas */
  request?: {
    /** Path parameters schema */
    params?: P;
    /** Query parameters schema */
    query?: Q;
    /** Request body schema */
    body?: B;
  };
  /** Response schemas by status code */
  responses?: Record<number, z.ZodTypeAny>;
  /**
   * OpenAPI Security Requirements
   * @example [{ bearerAuth: [] }]
   */
  security?: Array<Record<string, string[]>>;
  /**
   * OpenAPI Operation overrides
   * Allows full customization of the operation (e.g., custom headers, externalDocs)
   */
  openapi?: Record<string, any>;
  /**
   * Inject services into the route handler
   */
  inject?: Services;
  /** Route handler function */
  handler: RouteHandler<P, Q, B, R, M, Services>;
}

/**
 * Catch-all type for arrays of routes
 */
export type AnyRouteConfig = RouteConfig<any, any, any, any, any, any>;