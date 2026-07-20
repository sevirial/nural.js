/**
 * Route Helper
 */

import type { MiddlewareHandler } from "./middleware";
import type { ZodAny, RouteConfig } from "../types/route";

type CombinedMiddleware<
  Base extends MiddlewareHandler<any, any>[],
  Local extends MiddlewareHandler<any, any>[] | undefined
> = [...Base, ...(Local extends MiddlewareHandler<any, any>[] ? Local : [])];

/**
 * Create a type-safe route configuration
 *
 * @example
 * ```typescript
 * const userRoute = createRoute({
 *   method: 'GET',
 *   path: '/users/:id',
 *   summary: 'Get User by ID',
 *   request: { params: z.object({ id: z.string() }) },
 *   responses: { 200: z.object({ id: z.string(), name: z.string() }) },
 *   handler: async ({ params }) => {
 *     return { id: params.id, name: 'Chetan' };
 *   }
 * });
 * ```
 */
export function createRoute<
  P extends ZodAny = undefined,
  Q extends ZodAny = undefined,
  B extends ZodAny = undefined,
  R extends ZodAny = undefined,
  M extends MiddlewareHandler<any, any>[] | undefined = undefined,
  InjectedServices extends Record<string, unknown> = {}
>(config: RouteConfig<P, Q, B, R, M, InjectedServices> & { inject?: InjectedServices }): RouteConfig<P, Q, B, R, M, InjectedServices> {
  return config;
}


/**
 * Route Builder Interface
 */
export interface RouteBuilder<
  BaseM extends MiddlewareHandler<any, any>[]
> {
  <
    P extends ZodAny = undefined,
    Q extends ZodAny = undefined,
    B extends ZodAny = undefined,
    R extends ZodAny = undefined,
    M extends MiddlewareHandler<any, any>[] | undefined = undefined,
    InjectedServices extends Record<string, unknown> = {}
  >(
    // 🪄 The Magic Fix:
    // We ask for a RouteConfig typed with the *COMBINED* middleware (Base + Local).
    config: Omit<RouteConfig<P, Q, B, R, CombinedMiddleware<BaseM, M>, InjectedServices>, "middleware"> & {
      middleware?: M; // User only provides local middleware
    }
  ): RouteConfig<P, Q, B, R, CombinedMiddleware<BaseM, M>, InjectedServices>;
}

/**
 * The Builder Factory
 */
export function createBuilder<
  BaseM extends MiddlewareHandler<any, any>[],
>(baseMiddleware: BaseM): RouteBuilder<BaseM> {

  const builder = <
    P extends ZodAny = undefined,
    Q extends ZodAny = undefined,
    B extends ZodAny = undefined,
    R extends ZodAny = undefined,
    M extends MiddlewareHandler<any, any>[] | undefined = undefined,
    InjectedServices extends Record<string, unknown> = {}
  >(
    config: Omit<RouteConfig<P, Q, B, R, CombinedMiddleware<BaseM, M>, InjectedServices>, "middleware"> & {
      middleware?: M;
    }
  ): RouteConfig<P, Q, B, R, CombinedMiddleware<BaseM, M>, InjectedServices> => {

    // 1. Merge the middleware arrays at runtime
    const localMiddleware = (config.middleware || []) as MiddlewareHandler<any, any>[];
    const combinedMiddleware = [...baseMiddleware, ...localMiddleware];

    // 2. Return the full config object
    return {
      ...config,
      middleware: combinedMiddleware,
    } as unknown as RouteConfig<P, Q, B, R, CombinedMiddleware<BaseM, M>, InjectedServices>;
  };

  return builder as RouteBuilder<BaseM>;
}