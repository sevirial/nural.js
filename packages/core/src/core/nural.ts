/**
 * Nuraljs Framework
 * Main application class that orchestrates adapters and documentation
 */

import { Server } from "http";
import type { ServerAdapter } from "../adapters/base";
import { ExpressAdapter } from "../adapters/express";
import { FastifyAdapter } from "../adapters/fastify";
import { DocumentationGenerator } from "../docs/generator";
import { applyCorsExpress, applyCorsFastify } from "../middleware/cors";
import { applyHelmetExpress, applyHelmetFastify } from "../middleware/helmet";
import { applyHttpLoggerFastify, httpLogger } from "../middleware/http-logger";
import type { NuraljsConfig, ResolvedDocsConfig } from "../types/config";
import { resolveDocsConfig } from "../types/config";
import type { ResolvedErrorHandlerConfig } from "../types/error";
import { resolveErrorHandlerConfig } from "../types/error";
import type {
  ResolvedCorsConfig,
  ResolvedHelmetConfig,
} from "../types/middleware";
import { resolveCorsConfig, resolveHelmetConfig } from "../types/middleware";
import type { AnyRouteConfig } from "../types/route";
import { Logger } from "./logger";
import { ModuleConfig, ProviderMap } from "./module";
import type { NuraljsProvider } from "./provider";

/**
 * Nuraljs - The intelligent, schema-first REST framework
 *
 * @example
 * ```typescript
 * const app = new Nuraljs({
 *   framework: 'express',
 *   docs: true,
 *   cors: true,
 *   helmet: true,
 *   errorHandler: true,
 * });
 * app.register([userRoute, healthRoute]);
 * app.start(3000);
 * ```
 */
export class Nuraljs {
  private adapter: ServerAdapter;
  private docsGenerator: DocumentationGenerator;
  private docsConfig: ResolvedDocsConfig;
  private corsConfig: ResolvedCorsConfig | null;
  private helmetConfig: ResolvedHelmetConfig | null;
  private errorHandlerConfig: ResolvedErrorHandlerConfig;
  private isExpress: boolean;
  public logger: Logger;

  /**
   * Every route registered with the app, in registration order and with final
   * (prefix-joined) paths. Boot-time introspection only — used by tooling such
   * as `nural routes` and `getRoutes()`; not read on the request hot path.
   */
  private routes: AnyRouteConfig[] = [];

  /** Lifecycle providers registered via {@link registerProvider}. */
  private providers: NuraljsProvider<unknown>[] = [];

  /** Guards against attaching the shutdown teardown hooks more than once. */
  private shutdownHooksAttached = false;

  constructor(config: NuraljsConfig = {}) {
    this.docsConfig = resolveDocsConfig(config.docs);
    this.corsConfig = resolveCorsConfig(config.cors);
    this.helmetConfig = resolveHelmetConfig(config.helmet);
    this.errorHandlerConfig = resolveErrorHandlerConfig(config.errorHandler);
    this.docsGenerator = new DocumentationGenerator(this.docsConfig);

    // Initialize System Logger
    this.logger = new Logger("Nuraljs");

    // Select adapter based on framework config
    this.isExpress = config.framework !== "fastify";
    if (this.isExpress) {
      this.adapter = new ExpressAdapter(this.errorHandlerConfig);
    } else {
      this.adapter = new FastifyAdapter(this.errorHandlerConfig);
    }

    // Register HTTP Logger Middleware.
    // Fastify uses a native `onResponse` hook (no per-request `new Promise` or
    // `finish` listener — the default hot path stays allocation-free); Express
    // keeps the legacy `use()`-wrapped middleware.
    if (config.logger?.enabled !== false) {
      const loggerOptions = {
        showUserAgent: config.logger?.showUserAgent,
        showTime: config.logger?.showTime ?? true,
      };
      if (this.isExpress) {
        this.adapter.use(httpLogger(loggerOptions));
      } else {
        applyHttpLoggerFastify(this.adapter.app, loggerOptions);
      }
    }

    // Apply built-in middleware
    this.applyBuiltInMiddleware();
  }

  get server() {
    return this.adapter.server;
  }

  /**
   * Apply CORS and Helmet middleware based on config
   */
  private applyBuiltInMiddleware(): void {
    const app = this.adapter.app;

    if (this.isExpress) {
      // Apply Helmet first (security headers)
      if (this.helmetConfig) {
        applyHelmetExpress(app, this.helmetConfig);
      }
      // Apply CORS
      if (this.corsConfig) {
        applyCorsExpress(app, this.corsConfig);
      }
    } else {
      // Fastify
      if (this.helmetConfig) {
        applyHelmetFastify(app, this.helmetConfig);
      }
      if (this.corsConfig) {
        applyCorsFastify(app, this.corsConfig);
      }
    }
  }

  /**
   * Register routes with the application
   */
  register(routes: AnyRouteConfig[]): void {
    routes.forEach((route) => {
      this.routes.push(route);
      this.adapter.registerRoute(route);
      if (this.docsConfig.enabled) {
        this.docsGenerator.addRoute(route);
      }
    });
  }

  /**
   * Register a module containing multiple routes with shared configuration
   * @param module The module configuration to register
   */
  registerModule(module: ModuleConfig): void {
    const { 
      prefix = "", 
      middleware = [], 
      tags = [], 
      security = [], 
      providers: moduleProviders = {},
      routes 
    } = module;

    // Safety Check: Don't let users overwrite core properties
    const reservedKeys = ['req', 'res', 'body', 'query', 'params', 'next', 'status'];
    Object.keys(moduleProviders).forEach(key => {
      if (reservedKeys.includes(key)) {
        throw new Error(`Dependency Injection Error: Provider name "${key}" is reserved. Rename it.`);
      }
    });

    routes.forEach((route) => {
      const originalHandler = route.handler;
      const routeProviders = route.inject || {};

      // Hoist the DI merge to boot: route defaults + module overrides are static,
      // so merge them ONCE here (module providers override route defaults — good
      // for mocking). Per request we just `Object.assign` this frozen bag onto
      // the existing context — no per-request spread, no new object.
      const mergedProviders = { ...routeProviders, ...moduleProviders };

      const wrappedHandler = async (ctx: any) => {
        Object.assign(ctx, mergedProviders);
        return originalHandler(ctx);
      };

      const hydratedRoute = {
        ...route,
        path: this.joinPaths(prefix, route.path),
        middleware: [...middleware, ...(route.middleware || [])],
        tags: [...tags, ...(route.tags || [])],
        security: route.security ? route.security : security,
        handler: wrappedHandler
      };

      this.registerSingleRoute(hydratedRoute);
    });
  }

  /**
   * Register a single route with the adapter and documentation generator
   * @param route The route configuration to register
   */
  private registerSingleRoute(route: AnyRouteConfig): void {
    this.routes.push(route);
    this.adapter.registerRoute(route);
    if (this.docsConfig.enabled) {
      this.docsGenerator.addRoute(route);
    }
  }

  /**
   * Return every registered route (with final, prefix-joined paths). Read-only
   * boot-time introspection for tooling — e.g. `nural routes`.
   */
  getRoutes(): AnyRouteConfig[] {
    return this.routes;
  }

  /**
   * Generate and return the OpenAPI specification for the registered routes.
   * Used by `nural docs` to emit a static spec without booting the server.
   */
  getOpenApiSpec(): ReturnType<DocumentationGenerator["generateSpec"]> {
    return this.docsGenerator.generateSpec();
  }

  /**
   * Register a lifecycle provider: initialize its instance now and dispose it
   * on graceful shutdown. Returns the initialized instance.
   *
   * @example
   * ```typescript
   * await app.registerProvider(redisProvider);
   * ```
   */
  async registerProvider<T>(provider: NuraljsProvider<T>): Promise<T> {
    await provider.init();
    this.providers.push(provider as NuraljsProvider<unknown>);
    this.attachShutdownHooks();
    return provider.getInstance();
  }

  /**
   * Dispose all registered providers in reverse (LIFO) order — safer when later
   * providers depend on earlier ones.
   */
  private async destroyProviders(): Promise<void> {
    for (const provider of [...this.providers].reverse()) {
      try {
        await provider.destroy();
      } catch (error) {
        this.logger.error(
          `Error disconnecting provider ${provider.name}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    this.providers = [];
  }

  /**
   * Attach process signal handlers (once) so providers are torn down cleanly on
   * SIGINT/SIGTERM.
   */
  private attachShutdownHooks(): void {
    if (this.shutdownHooksAttached) return;
    this.shutdownHooksAttached = true;

    const shutdown = (signal: NodeJS.Signals) => {
      void this.destroyProviders().finally(() => {
        process.kill(process.pid, signal);
      });
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  /**
   * Start the server
   */
  start(port: number): Server {
    if (this.docsConfig.enabled) {
      this.setupDocs();
    }

    return this.adapter.listen(port, (actualPort) => {
      console.log(`🚀 Nuraljs Server running on port ${actualPort}`);
      if (this.docsConfig.enabled) {
        console.log(
          `📚 Docs available at http://localhost:${actualPort}${this.docsConfig.path}`,
        );
      }
      if (this.corsConfig) {
        console.log(`🔓 CORS enabled`);
      }
      if (this.helmetConfig) {
        console.log(`🛡️  Helmet security headers enabled`);
      }
    });
  }

  private joinPaths(prefix: string, path: string): string {
    // Tolerate an empty/omitted segment rather than crashing: a route may
    // legitimately declare no path (`path: ""`) to mount at the module prefix
    // root. Coercing to "" first avoids `.replace` on `undefined`, which used
    // to throw a TypeError and take the server down at startup.
    const cleanPrefix = (prefix ?? "").replace(/\/+$/, ""); // Remove trailing slash
    const cleanPath = (path ?? "").replace(/^\/+/, ""); // Remove leading slash

    if (!cleanPath) return cleanPrefix || "/";
    return `${cleanPrefix}/${cleanPath}`;
  }

  /**
   * Setup documentation routes
   */
  private setupDocs(): void {
    const specPath = `${this.docsConfig.path}/openapi.json`;

    this.adapter.registerStaticRoute("get", specPath, async () => {
      return { type: "json", data: this.docsGenerator.generateSpec() };
    });

    this.adapter.registerStaticRoute("get", this.docsConfig.path, async () => {
      const html =
        this.docsConfig.ui === "swagger"
          ? this.docsGenerator.getSwaggerHtml(specPath)
          : this.docsGenerator.getScalarHtml(specPath);

      return {
        type: "html",
        data: html,
      };
    });
  }
}
