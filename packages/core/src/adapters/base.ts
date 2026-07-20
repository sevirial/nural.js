/**
 * Server Adapter Interface
 * Defines the contract for framework adapters
 */

import type { Express, RequestHandler } from "express";
import type {
  FastifyInstance,
  FastifyPluginCallback,
  RawServerDefault,
} from "fastify";
import type { AnyRouteConfig } from "../types/route";
import http from "http";

/**
 * Response type for static routes (docs, spec)
 */
export interface StaticRouteResponse {
  type: "json" | "html";
  data: unknown;
}

/**
 * Server adapter interface
 * Implemented by Express and Fastify adapters
 */
export interface ServerAdapter {
  /** Underlying framework app instance */
  app: Express | FastifyInstance;

  server: http.Server | RawServerDefault;

  /** Start listening on port; `cb` receives the port actually bound. */
  listen(port: number, cb?: (actualPort: number) => void): http.Server | RawServerDefault;

  /** Register a route with validation and response mapping */
  registerRoute(route: AnyRouteConfig): void;

  /** Register a static route (for docs) */
  registerStaticRoute(
    method: "get",
    path: string,
    handler: (req: unknown) => Promise<StaticRouteResponse>,
  ): void;

  /** Apply global middleware */
  use(middleware: RequestHandler | FastifyPluginCallback): void;
}
