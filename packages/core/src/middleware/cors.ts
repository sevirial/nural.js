/**
 * CORS Middleware
 * Zero-dependency CORS implementation for Nuraljs
 */

import type { ResolvedCorsConfig } from "../types/middleware";

/**
 * CORS headers to apply to responses
 */
export interface CorsHeaders {
  "Access-Control-Allow-Origin": string;
  "Access-Control-Allow-Methods"?: string;
  "Access-Control-Allow-Headers"?: string;
  "Access-Control-Allow-Credentials"?: string;
  "Access-Control-Expose-Headers"?: string;
  "Access-Control-Max-Age"?: string;
  Vary?: string;
}

/**
 * Check if origin is allowed based on config
 */
function isOriginAllowed(
  origin: string | undefined,
  config: ResolvedCorsConfig,
): string | false {
  if (!origin) return false;

  const { origin: allowedOrigin } = config;

  // Allow all origins
  if (allowedOrigin === true || allowedOrigin === "*") {
    return config.credentials ? origin : "*";
  }

  // Single origin string
  if (typeof allowedOrigin === "string") {
    return origin === allowedOrigin ? origin : false;
  }

  // Array of origins
  if (Array.isArray(allowedOrigin)) {
    return allowedOrigin.includes(origin) ? origin : false;
  }

  // Function check
  if (typeof allowedOrigin === "function") {
    return allowedOrigin(origin) ? origin : false;
  }

  return false;
}

/**
 * The config-derived portion of the CORS header set — everything that does NOT
 * depend on the per-request origin. Computed once at boot (mirrors Helmet's
 * boot-time `getSecurityHeaders`) so the per-request hook never re-runs the
 * `.join(", ")` / `String(...)` work.
 */
export interface PrecomputedCorsHeaders {
  /** `Access-Control-Allow-Credentials` value, or null when disabled */
  credentials: string | null;
  /** `Access-Control-Expose-Headers` value, or null when none */
  exposedHeaders: string | null;
  /** `Access-Control-Allow-Methods` value (preflight only) */
  methods: string;
  /** `Access-Control-Allow-Headers` value (preflight only) */
  allowedHeaders: string;
  /** `Access-Control-Max-Age` value (preflight only) */
  maxAge: string;
}

/**
 * Precompute the static CORS header strings from config. Call ONCE at boot.
 */
export function precomputeCorsHeaders(
  config: ResolvedCorsConfig,
): PrecomputedCorsHeaders {
  return {
    credentials: config.credentials ? "true" : null,
    exposedHeaders:
      config.exposedHeaders.length > 0
        ? config.exposedHeaders.join(", ")
        : null,
    methods: config.methods.join(", "),
    allowedHeaders: config.allowedHeaders.join(", "),
    maxAge: String(config.maxAge),
  };
}

/**
 * Assemble the CORS headers for a request from the precomputed static set plus
 * the per-request origin decision. Only the origin/`Vary` pair is computed here;
 * everything else is read straight from {@link PrecomputedCorsHeaders}.
 */
function buildCorsHeaders(
  requestOrigin: string | undefined,
  config: ResolvedCorsConfig,
  precomputed: PrecomputedCorsHeaders,
  isPreflight: boolean,
): CorsHeaders | null {
  const allowedOrigin = isOriginAllowed(requestOrigin, config);

  if (!allowedOrigin) {
    return null;
  }

  const headers: CorsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
  };

  // Add Vary header when origin is dynamic
  if (allowedOrigin !== "*") {
    headers["Vary"] = "Origin";
  }

  // Credentials
  if (precomputed.credentials) {
    headers["Access-Control-Allow-Credentials"] = precomputed.credentials;
  }

  // Exposed headers
  if (precomputed.exposedHeaders) {
    headers["Access-Control-Expose-Headers"] = precomputed.exposedHeaders;
  }

  // Preflight-specific headers
  if (isPreflight) {
    headers["Access-Control-Allow-Methods"] = precomputed.methods;
    headers["Access-Control-Allow-Headers"] = precomputed.allowedHeaders;
    headers["Access-Control-Max-Age"] = precomputed.maxAge;
  }

  return headers;
}

/**
 * Generate CORS headers for a request.
 *
 * Standalone helper (used in tests and by consumers) — precomputes the static
 * set on each call. The adapter appliers below hoist that precompute to boot.
 */
export function getCorsHeaders(
  requestOrigin: string | undefined,
  config: ResolvedCorsConfig,
  isPreflight: boolean = false,
): CorsHeaders | null {
  return buildCorsHeaders(
    requestOrigin,
    config,
    precomputeCorsHeaders(config),
    isPreflight,
  );
}

/**
 * Handle CORS for Express
 */
export function applyCorsExpress(app: any, config: ResolvedCorsConfig): void {
  // Precompute the static header set once at boot (mirrors Helmet).
  const precomputed = precomputeCorsHeaders(config);

  // Add CORS headers to all responses (including preflight)
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    const isPreflight = req.method === "OPTIONS";
    const headers = buildCorsHeaders(origin, config, precomputed, isPreflight);

    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        if (value) res.setHeader(key, value);
      });
    }

    // Handle preflight response
    if (isPreflight) {
      if (config.preflightContinue) {
        next();
      } else {
        res.status(config.optionsSuccessStatus).end();
      }
      return;
    }

    next();
  });
}

/**
 * Handle CORS for Fastify
 */
export function applyCorsFastify(app: any, config: ResolvedCorsConfig): void {
  // Precompute the static header set once at boot (mirrors Helmet).
  const precomputed = precomputeCorsHeaders(config);

  // Add hook for all requests
  app.addHook("onRequest", async (request: any, reply: any) => {
    const origin = request.headers.origin;
    const isPreflight = request.method === "OPTIONS";
    const headers = buildCorsHeaders(origin, config, precomputed, isPreflight);

    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        if (value) reply.header(key, value);
      });
    }

    // Handle preflight
    if (isPreflight && !config.preflightContinue) {
      reply.status(config.optionsSuccessStatus).send();
      return;
    }
  });
}
