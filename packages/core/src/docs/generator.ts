/**
 * Documentation Generator
 * Generates OpenAPI spec and serves documentation UI
 *
 * Native generation (Sprint 4): the OpenAPI document is built directly from each
 * route's Zod schemas via Zod 4's `z.toJSONSchema(s, { target: "openapi-3.0" })`
 * — the same converter the boot-time schema compiler uses — instead of the
 * former `@asteasolutions/zod-to-openapi` (`OpenAPIRegistry` +
 * `OpenApiGeneratorV3`). Path/query object schemas are split into OpenAPI
 * `parameters`; bodies become a JSON `requestBody`; `responses` map by status
 * code. `:param` → `{param}` conversion, `security`, `tags`, and user
 * `openapi`/`.meta()` overrides are preserved. Scalar/Swagger HTML is unchanged.
 */

import { z } from "zod";
import { getCompiledSchema } from "../core/schema-compiler";
import type { AnyRouteConfig } from "../types/route";
import type { ResolvedDocsConfig } from "../types/config";

/** A JSON Schema object as embedded in the OpenAPI document. */
type JsonSchema = Record<string, unknown>;

/**
 * Zod 4's `.email()`/`.uuid()`/`.url()`/… emit BOTH a `format` and the concrete
 * validation `pattern` (regex) into the JSON Schema. In the docs UI (Scalar)
 * the raw regex is shown in preference to `format`, so an `email` field renders
 * as a wall of regex instead of a clean "email" hint. The `format` already
 * carries the semantic (and drives Scalar's label + example generation), so the
 * derived `pattern` is redundant noise here — strip it wherever a `format` is
 * present. Recurses through the standard JSON Schema containers so nested and
 * array/union members are cleaned too. Request validation is unaffected: ajv
 * validates from the separately-compiled schema, not this docs view.
 */
function stripRedundantPatterns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripRedundantPatterns(item);
    return;
  }
  if (!node || typeof node !== "object") return;

  const obj = node as JsonSchema;
  if (typeof obj.format === "string" && "pattern" in obj) {
    delete obj.pattern;
  }

  // Recurse into every nested value — covers `properties`/`patternProperties`
  // maps, `items`/`allOf`/`anyOf`/`oneOf` schemas, and any other container Zod
  // emits — without needing to enumerate JSON Schema keywords.
  for (const value of Object.values(obj)) stripRedundantPatterns(value);
}

/** An OpenAPI parameter object (path/query). */
interface OpenApiParameter {
  name: string;
  in: "path" | "query";
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

/**
 * Generates OpenAPI documentation from registered routes
 */
export class DocumentationGenerator {
  private routes: AnyRouteConfig[] = [];
  private config: ResolvedDocsConfig;

  constructor(config: ResolvedDocsConfig) {
    this.config = config;
  }

  /**
   * Register a route for documentation. Routes are collected and turned into
   * OpenAPI paths lazily in {@link generateSpec}, so the spec always reflects
   * every registered route regardless of call order.
   */
  addRoute(route: AnyRouteConfig): void {
    this.routes.push(route);
  }

  /**
   * Convert a Zod schema to an OpenAPI-3.0 JSON Schema. `io` selects the input
   * (request, pre-transform) vs output (response) view — matching the schema
   * compiler. `mayNeedRuntime` is Sprint 1's per-slot fallback flag: when it's
   * `false` the slot is already proven fully representable, so we convert
   * directly; when `true` the slot holds a `.refine()` (dropped silently — fine
   * for docs) or a `.transform()` (throws — fall back to a permissive `{}` so
   * docs generation never crashes on an otherwise-valid route).
   */
  private toOpenApiSchema(
    schema: z.ZodTypeAny,
    io: "input" | "output",
    mayNeedRuntime: boolean,
  ): JsonSchema {
    const convert = (): JsonSchema => {
      const json = z.toJSONSchema(schema, {
        target: "openapi-3.0",
        io,
        // Inline reused subschemas rather than emitting `$defs`, which would be
        // `$ref`s OpenAPI can't resolve (it uses `#/components/schemas/...`).
        reused: "inline",
      }) as JsonSchema;
      // Zod stamps a draft `$schema` pointer; OpenAPI documents don't carry one.
      delete json.$schema;
      // Drop the regex `pattern` Zod 4 emits alongside a string `format`
      // (email/uuid/url/…) so the docs UI shows the clean format, not the regex.
      stripRedundantPatterns(json);
      return json;
    };

    if (!mayNeedRuntime) return convert();
    try {
      return convert();
    } catch {
      return {};
    }
  }

  /**
   * Split a Zod object schema into OpenAPI parameter objects for a given
   * location. Path parameters are always `required` per the OpenAPI spec; query
   * parameters follow the schema's `required` list. A per-property `description`
   * (e.g. from `.meta()`) is lifted onto the parameter.
   */
  private paramsToParameters(
    schema: z.ZodTypeAny | undefined,
    location: "path" | "query",
    mayNeedRuntime: boolean,
  ): OpenApiParameter[] {
    if (!schema) return [];

    const json = this.toOpenApiSchema(schema, "input", mayNeedRuntime);
    const properties = (json.properties as Record<string, JsonSchema>) ?? {};
    const required = new Set((json.required as string[]) ?? []);

    return Object.entries(properties).map(([name, propSchema]) => {
      const { description, ...rest } = propSchema;
      return {
        name,
        in: location,
        required: location === "path" ? true : required.has(name),
        ...(typeof description === "string" ? { description } : {}),
        schema: rest,
      };
    });
  }

  /**
   * Build the OpenAPI operation object for one route.
   */
  private buildOperation(route: AnyRouteConfig): Record<string, unknown> {
    // Reuse Sprint 1's compiled analysis so docs and the runtime hot path share
    // one representability pass per route (cached in a WeakMap). The draft-07
    // JSON itself is NOT reused verbatim — OpenAPI-3.0 and draft-07 diverge on
    // nullable (`nullable:true` vs `anyOf:[…,{type:null}]`), so reusing it would
    // drift from the previous `zod-to-openapi` 3.0 output. We reuse the flags.
    const { needsRuntimeZod } = getCompiledSchema(route);

    const parameters: OpenApiParameter[] = [
      ...this.paramsToParameters(
        route.request?.params,
        "path",
        needsRuntimeZod.params,
      ),
      ...this.paramsToParameters(
        route.request?.query,
        "query",
        needsRuntimeZod.query,
      ),
    ];

    const requestBody = route.request?.body
      ? {
          content: {
            "application/json": {
              schema: this.toOpenApiSchema(
                route.request.body,
                "input",
                needsRuntimeZod.body,
              ),
            },
          },
        }
      : undefined;

    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(route.responses ?? {})) {
      const zodSchema = schema as z.ZodTypeAny;
      // A response's `.meta({ description })` becomes the (required) OpenAPI
      // response description; otherwise a generic "Response".
      const meta = (
        zodSchema as unknown as { meta?: () => { description?: string } }
      ).meta?.();
      responses[status] = {
        description: meta?.description ?? "Response",
        content: {
          "application/json": {
            schema: this.toOpenApiSchema(
              zodSchema,
              "output",
              needsRuntimeZod.response[Number(status)] ?? false,
            ),
          },
        },
      };
    }

    return {
      summary: route.summary || "No summary",
      ...(route.description ? { description: route.description } : {}),
      ...(route.tags ? { tags: route.tags } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses,
      ...(route.security ? { security: route.security } : {}),
      // User operation-level overrides win (custom headers, externalDocs, …).
      ...route.openapi,
    };
  }

  /**
   * Generate the OpenAPI specification document
   */
  generateSpec(): object {
    // Build paths from every registered route.
    const paths: Record<string, Record<string, unknown>> = {};
    for (const route of this.routes) {
      // Convert Express path "/users/:id" to OpenAPI path "/users/{id}".
      const openApiPath = route.path.replace(/:([a-zA-Z]+)/g, "{$1}");
      const method = route.method.toLowerCase();
      (paths[openApiPath] ??= {})[method] = this.buildOperation(route);
    }

    const info = {
      title: this.config.openApi.info?.title ?? "Nuraljs API",
      version: this.config.openApi.info?.version ?? "1.0.0",
      description: this.config.openApi.info?.description,
      termsOfService: this.config.openApi.info?.termsOfService,
      contact: this.config.openApi.info?.contact?.name
        ? {
            name: this.config.openApi.info.contact.name,
            email: this.config.openApi.info.contact.email,
            url: this.config.openApi.info.contact.url,
          }
        : undefined,
      license: this.config.openApi.info?.license?.name
        ? {
            name: this.config.openApi.info.license.name,
            url: this.config.openApi.info.license.url,
          }
        : undefined,
    };

    return {
      openapi: "3.0.0",
      info,
      servers: this.config.openApi.servers,
      paths,
      // Components (incl. `securitySchemes` that route `security` references)
      // come straight from the user's config — there is no external registry.
      components: {
        ...this.config.openApi.components,
        ...(this.config.openApi.components?.securitySchemes
          ? { securitySchemes: this.config.openApi.components.securitySchemes }
          : {}),
      },
      ...(this.config.openApi.security
        ? { security: this.config.openApi.security }
        : {}),
      ...(this.config.openApi.tags ? { tags: this.config.openApi.tags } : {}),
      ...(this.config.openApi.externalDocs
        ? { externalDocs: this.config.openApi.externalDocs }
        : {}),
    };
  }

  /**
   * Get Scalar API documentation HTML
   *
   * The Scalar script is pinned to a specific version and loaded with a
   * Subresource Integrity (SRI) hash so that any CDN-side tampering is
   * detected and blocked by the browser.
   */
  getScalarHtml(specUrl: string): string {
    const scalarConfig = JSON.stringify(this.config.scalar || {});
    // Pinned: @scalar/api-reference@1.25.67
    const SCALAR_SRC = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.67/dist/browser/standalone.min.js";
    const SCALAR_SRI = "sha384-tfGQqpB6aWsF5OlgqoJ/9opwQKZU6VJ1y9Gzn277ZDgRV1ViHDmCrPYa7GrBjJxG";
    return `
      <!doctype html>
      <html>
        <head>
          <title>${this.config.openApi.info?.title ?? "Nuraljs API"} - API Reference</title>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <style>body { margin: 0; }</style>
        </head>
        <body>
          <script
            id="api-reference"
            data-url="${specUrl}"
            data-configuration='${scalarConfig}'
            src="${SCALAR_SRC}"
            integrity="${SCALAR_SRI}"
            crossorigin="anonymous"
          ></script>
        </body>
      </html>
    `;
  }

  /**
   * Get Swagger UI HTML
   *
   * All CDN assets are pinned to specific versions and loaded with
   * Subresource Integrity (SRI) hashes so that any CDN-side tampering
   * is detected and blocked by the browser.
   */
  getSwaggerHtml(specUrl: string): string {
    const title = this.config.openApi.info?.title ?? "Nuraljs API";
    const swaggerOptions = JSON.stringify(this.config.swagger.options || {});

    // Pinned: swagger-ui 4.15.5
    const SWAGGER_BASE = "https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/4.15.5";
    const SWAGGER_CSS_SRI       = "sha384-J8qHJAHNGogw4AZvlpfgrv8amL76NFTgIWACyfNLuqq02AVOVWKXGh8dcqtv7RFF";
    const SWAGGER_BUNDLE_SRI    = "sha384-GJoyyEnbeIyINXWDkEzUHpPPCZPcP2KrAg83c6DGAkTPr2tDHQ59DuqMRwAwsJwV";
    const SWAGGER_STANDALONE_SRI = "sha384-LPIWB4adMa/c1eVa/Jc8ShfB3GG4sxupb/nSFLbjiIhnM78eY2zgZImCSGhpdBJA";

    let themeUrl = `${SWAGGER_BASE}/swagger-ui.min.css`;
    let themeSri = SWAGGER_CSS_SRI;

    if (this.config.swagger.theme === "outline") {
      // outline theme uses a different version; no pinned SRI available — omit integrity
      themeUrl = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css";
      themeSri = "";
    } else if (this.config.swagger.theme === "no-theme") {
      themeUrl = "";
      themeSri = "";
    }

    const theme = themeUrl
      ? `<link rel="stylesheet" href="${themeUrl}"${themeSri ? ` integrity="${themeSri}" crossorigin="anonymous"` : ""} />`
      : "";

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>${title} - Swagger UI</title>
        ${theme}
        <style>
          html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
          *, *:before, *:after { box-sizing: inherit; }
          body { margin: 0; background: #fafafa; }
        </style>
      </head>
      <body>
        <div id="swagger-ui"></div>
        <script src="${SWAGGER_BASE}/swagger-ui-bundle.js" integrity="${SWAGGER_BUNDLE_SRI}" crossorigin="anonymous"></script>
        <script src="${SWAGGER_BASE}/swagger-ui-standalone-preset.js" integrity="${SWAGGER_STANDALONE_SRI}" crossorigin="anonymous"></script>
        <script>
        window.onload = function() {
          const ui = SwaggerUIBundle({
            url: "${specUrl}",
            dom_id: '#swagger-ui',
            deepLinking: true,
            presets: [
              SwaggerUIBundle.presets.apis,
              SwaggerUIStandalonePreset
            ],
            plugins: [
              SwaggerUIBundle.plugins.DownloadUrl
            ],
            layout: "StandaloneLayout",
            ...${swaggerOptions}
          })
          window.ui = ui
        }
        </script>
      </body>
      </html>
    `;
  }
}
