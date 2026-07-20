/**
 * Middleware Types and Helpers
 */

import type { FrameworkRequest, FrameworkResponse } from "../types/route";

/**
 * The request as seen inside a middleware: the underlying framework request
 * (Fastify's `FastifyRequest`, or Express's `Request` when declared — see
 * {@link FrameworkRequest}) plus `nuralCtx`, the per-request bag Nuraljs
 * accumulates as middleware run.
 *
 * Each middleware/guard on a route may return an object; core merges those
 * returns onto `nuralCtx` (see the adapter's `preValidation` hook) and later
 * exposes them on the handler context. A *downstream* middleware reads what an
 * upstream guard produced — e.g. the `user` an auth guard attached — from
 * `req.nuralCtx`, fully typed. Feed it the upstream contract with
 * {@link InferMiddleware}:
 *
 * ```ts
 * type Auth = InferMiddleware<typeof authMiddleware>; // { user: User }
 * defineMiddleware((req: NuralRequest<Auth>) => {
 *   req.nuralCtx.user; // typed as User
 * });
 * ```
 *
 * `Ctx` defaults to an open bag, so `NuralRequest` with no argument is just the
 * framework request with an untyped `nuralCtx` — enough for `req.headers` etc.
 * with no cast.
 */
export type NuralRequest<
  Ctx extends Record<string, unknown> = Record<string, unknown>,
> = WithNuralCtx<FrameworkRequest, Ctx>;

/**
 * Replace the framework request's `nuralCtx` with the precise context `Ctx`.
 * The Fastify adapter decorates `FastifyRequest` with a loose
 * `nuralCtx: Record<string, unknown> | null` (for its own per-request assign);
 * `Omit`-ing that key before adding `Ctx` back keeps `req.nuralCtx.foo` type-safe
 * instead of widening every access to `unknown`. Distributes over a request
 * union so it stays correct if `FrameworkRequest` is `Request | FastifyRequest`.
 */
type WithNuralCtx<R, Ctx extends Record<string, unknown>> = R extends unknown
  ? Omit<R, "nuralCtx"> & {
      /** Context accumulated by upstream middleware/guards on this route. */
      nuralCtx: Ctx;
    }
  : never;

/**
 * Middleware handler function type
 * Returns data to be merged into route context
 */
export type MiddlewareHandler<Req = unknown, Res = unknown> = (
  req: Req,
  res: Res,
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

/**
 * Define a type-safe middleware.
 *
 * `req` is typed as a {@link NuralRequest} and `res` as the framework response,
 * so `req.headers` and friends work with no cast. To read what an upstream
 * middleware/guard placed on the request, annotate `req` with the upstream
 * contract — both the context type and this middleware's own return type infer
 * from that single call, no explicit type arguments needed:
 *
 * @example
 * ```typescript
 * // No upstream deps — `req` is the framework request, return is inferred.
 * const attachRequestId = defineMiddleware((req) => {
 *   return { requestId: req.headers["x-request-id"] ?? crypto.randomUUID() };
 * });
 *
 * // Depends on an upstream auth guard — annotate `req` with its contract.
 * type Auth = InferMiddleware<typeof authMiddleware>; // { user: { role: string } }
 * const requireAdmin = defineMiddleware((req: NuralRequest<Auth>) => {
 *   const user = req.nuralCtx.user; // typed as { role: string }
 *   if (user.role !== "admin") throw new Error("Forbidden");
 *   return { role: user.role };
 * });
 * ```
 */
export function defineMiddleware<
  Ctx extends Record<string, unknown> = Record<string, unknown>,
  T extends Record<string, unknown> | void = Record<string, unknown> | void,
>(
  fn: (req: NuralRequest<Ctx>, res: FrameworkResponse) => Promise<T> | T,
): (req: any, res: any) => Promise<T> | T {
  // `req`/`res` are richly typed on the `fn` *argument* (authoring DX) but the
  // returned handler widens them so it stays assignable wherever middleware is
  // typed loosely (e.g. consumers' own `req: unknown` guard types). Only the
  // return type `T` is load-bearing downstream — `InferMiddleware` reads it to
  // thread context to later middleware and the handler.
  return fn;
}
