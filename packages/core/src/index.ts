/**
 * Nuraljs
 * The intelligent, schema-first REST framework for Node.js
 *
 * @packageDocumentation
 */

import { z } from "zod";
import { extendZodWithOpenApi } from "./core/openapi-compat";

// Initialize the `.openapi()` authoring shim on Zod's prototype (side effect).
// Zod 4 native: `.openapi()` now forwards to `.meta()`.
extendZodWithOpenApi(z);

// Core exports
export { Nuraljs } from "./core";
export { createRoute, createModule, defineMiddleware, createBuilder } from "./core";
export { defineProvider, defineExceptionFilter } from "./core";
export type {
  ProviderConfig,
  NuraljsProvider,
  ExceptionFilterHandler,
  MiddlewareHandler,
  NuralRequest,
} from "./core";
export { Logger } from "./core/logger";
export type { LoggerConfig } from "./core/logger";
export * from "./core/exceptions";

// Type exports
export type {
  HttpMethod,
  HttpStatusCode,
  NuraljsConfig,
  DocsConfig,
  CorsConfig,
  HelmetConfig,
  ErrorHandler,
  ErrorHandlerConfig,
  ErrorContext,
  RouteConfig,
  RouteContext,
  RouteHandler,
  InferMiddleware,
  AnyRouteConfig,
  NuralTypeOptions,
  ConfiguredFramework,
  FrameworkRequest,
  FrameworkResponse,
} from "./types";

// Re-export Zod for convenience. `Schema` is the documented alias; `z` is the
// raw name the examples/consumers author against — both point at the same Zod.
export { z as Schema, z } from "zod";
export { extendZodWithOpenApi } from "./core/openapi-compat";
