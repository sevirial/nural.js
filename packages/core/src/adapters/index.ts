/**
 * Adapters Module
 * Re-exports all server adapters
 */

export type { ServerAdapter, StaticRouteResponse } from "./base";
export { ExpressAdapter } from "./express";
export { FastifyAdapter } from "./fastify";
