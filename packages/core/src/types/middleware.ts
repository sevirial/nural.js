/**
 * Middleware Configuration Types
 * Types for CORS and Helmet middleware configuration
 */

/**
 * CORS configuration options
 */
export interface CorsConfig {
  /**
   * Allowed origins
   * - `true` or `'*'` allows all origins
   * - String for single origin
   * - Array for multiple origins
   * - Function for dynamic origin check
   */
  origin?: boolean | string | string[] | ((origin: string) => boolean);

  /** Allowed HTTP methods */
  methods?: string[];

  /** Allowed headers */
  allowedHeaders?: string[];

  /** Headers exposed to client */
  exposedHeaders?: string[];

  /** Allow credentials (cookies, authorization headers) */
  credentials?: boolean;

  /** Preflight cache max age in seconds */
  maxAge?: number;

  /** Pass preflight response to next handler */
  preflightContinue?: boolean;

  /** Success status code for OPTIONS requests */
  optionsSuccessStatus?: number;
}

/**
 * Resolved CORS configuration with defaults applied
 */
export interface ResolvedCorsConfig {
  origin: boolean | string | string[] | ((origin: string) => boolean);
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  credentials: boolean;
  maxAge: number;
  preflightContinue: boolean;
  optionsSuccessStatus: number;
}

/**
 * Default CORS configuration
 */
export const DEFAULT_CORS_CONFIG: ResolvedCorsConfig = {
  origin: "*",
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: [],
  credentials: false,
  maxAge: 86400, // 24 hours
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

/**
 * Helmet configuration options
 */
export interface HelmetConfig {
  /** Content-Security-Policy header */
  contentSecurityPolicy?: boolean | { directives?: Record<string, string[]> };

  /** Cross-Origin-Embedder-Policy header */
  crossOriginEmbedderPolicy?: boolean;

  /** Cross-Origin-Opener-Policy header */
  crossOriginOpenerPolicy?: boolean | { policy?: string };

  /** Cross-Origin-Resource-Policy header */
  crossOriginResourcePolicy?: boolean | { policy?: string };

  /** X-DNS-Prefetch-Control header */
  dnsPrefetchControl?: boolean | { allow?: boolean };

  /** X-Frame-Options header */
  frameguard?: boolean | { action?: "deny" | "sameorigin" };

  /** Strict-Transport-Security header */
  hsts?:
    | boolean
    | { maxAge?: number; includeSubDomains?: boolean; preload?: boolean };

  /** X-Content-Type-Options header */
  noSniff?: boolean;

  /** X-Permitted-Cross-Domain-Policies header */
  permittedCrossDomainPolicies?: boolean | { policy?: string };

  /** Referrer-Policy header */
  referrerPolicy?: boolean | { policy?: string | string[] };

  /** X-XSS-Protection header (legacy) */
  xssFilter?: boolean;
}

/**
 * Resolved Helmet configuration
 */
export interface ResolvedHelmetConfig {
  contentSecurityPolicy: boolean | { directives: Record<string, string[]> };
  crossOriginEmbedderPolicy: boolean;
  crossOriginOpenerPolicy: { policy: string };
  crossOriginResourcePolicy: { policy: string };
  dnsPrefetchControl: { allow: boolean };
  frameguard: { action: "deny" | "sameorigin" };
  hsts: { maxAge: number; includeSubDomains: boolean; preload: boolean };
  noSniff: boolean;
  permittedCrossDomainPolicies: { policy: string };
  referrerPolicy: { policy: string };
  xssFilter: boolean;
}

/**
 * Default Helmet configuration
 */
export const DEFAULT_HELMET_CONFIG: ResolvedHelmetConfig = {
  contentSecurityPolicy: false, // Disabled by default (can break apps)
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: "sameorigin" },
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: false }, // 180 days
  noSniff: true,
  permittedCrossDomainPolicies: { policy: "none" },
  referrerPolicy: { policy: "no-referrer" },
  xssFilter: false, // Deprecated, browsers ignore it
};

/**
 * Fail closed on the dangerous CORS misconfiguration `credentials: true` +
 * wildcard `origin` (`true` or `"*"`). Because browsers reject a literal
 * `Access-Control-Allow-Origin: *` alongside credentials, the middleware would
 * otherwise reflect the *arbitrary* request `Origin` — which lets ANY website
 * make credentialed cross-origin requests and read the authenticated response
 * (cross-origin account/data theft). When credentials are enabled the app must
 * name its allowed origins explicitly (string | string[] | function).
 */
function assertSafeCorsConfig(resolved: ResolvedCorsConfig): void {
  const wildcardOrigin = resolved.origin === true || resolved.origin === "*";
  if (resolved.credentials && wildcardOrigin) {
    throw new Error(
      "Nuraljs CORS: `credentials: true` cannot be combined with a wildcard `origin` " +
        '(`true` or "*") — it would reflect any Origin while allowing credentials, ' +
        "letting any site read authenticated responses. Specify explicit allowed " +
        "origins (a string, string[], or an (origin) => boolean function) when credentials are enabled.",
    );
  }
}

/**
 * Resolve CORS config from user input
 */
export function resolveCorsConfig(
  cors?: boolean | CorsConfig,
): ResolvedCorsConfig | null {
  if (cors === false || cors === undefined) {
    return null;
  }

  if (cors === true) {
    return DEFAULT_CORS_CONFIG;
  }

  const resolved: ResolvedCorsConfig = {
    origin: cors.origin ?? DEFAULT_CORS_CONFIG.origin,
    methods: cors.methods ?? DEFAULT_CORS_CONFIG.methods,
    allowedHeaders: cors.allowedHeaders ?? DEFAULT_CORS_CONFIG.allowedHeaders,
    exposedHeaders: cors.exposedHeaders ?? DEFAULT_CORS_CONFIG.exposedHeaders,
    credentials: cors.credentials ?? DEFAULT_CORS_CONFIG.credentials,
    maxAge: cors.maxAge ?? DEFAULT_CORS_CONFIG.maxAge,
    preflightContinue:
      cors.preflightContinue ?? DEFAULT_CORS_CONFIG.preflightContinue,
    optionsSuccessStatus:
      cors.optionsSuccessStatus ?? DEFAULT_CORS_CONFIG.optionsSuccessStatus,
  };
  assertSafeCorsConfig(resolved);
  return resolved;
}

/**
 * Resolve Helmet config from user input
 */
export function resolveHelmetConfig(
  helmet?: boolean | HelmetConfig,
): ResolvedHelmetConfig | null {
  if (helmet === false || helmet === undefined) {
    return null;
  }

  if (helmet === true) {
    return DEFAULT_HELMET_CONFIG;
  }

  return {
    contentSecurityPolicy:
      typeof helmet.contentSecurityPolicy === "object"
        ? { directives: helmet.contentSecurityPolicy.directives ?? {} }
        : (helmet.contentSecurityPolicy ??
          DEFAULT_HELMET_CONFIG.contentSecurityPolicy),
    crossOriginEmbedderPolicy:
      helmet.crossOriginEmbedderPolicy ??
      DEFAULT_HELMET_CONFIG.crossOriginEmbedderPolicy,
    crossOriginOpenerPolicy:
      typeof helmet.crossOriginOpenerPolicy === "object"
        ? (helmet.crossOriginOpenerPolicy as { policy: string })
        : DEFAULT_HELMET_CONFIG.crossOriginOpenerPolicy,
    crossOriginResourcePolicy:
      typeof helmet.crossOriginResourcePolicy === "object"
        ? (helmet.crossOriginResourcePolicy as { policy: string })
        : DEFAULT_HELMET_CONFIG.crossOriginResourcePolicy,
    dnsPrefetchControl:
      typeof helmet.dnsPrefetchControl === "object"
        ? (helmet.dnsPrefetchControl as { allow: boolean })
        : DEFAULT_HELMET_CONFIG.dnsPrefetchControl,
    frameguard:
      typeof helmet.frameguard === "object"
        ? (helmet.frameguard as { action: "deny" | "sameorigin" })
        : DEFAULT_HELMET_CONFIG.frameguard,
    hsts:
      typeof helmet.hsts === "object"
        ? { ...DEFAULT_HELMET_CONFIG.hsts, ...helmet.hsts }
        : DEFAULT_HELMET_CONFIG.hsts,
    noSniff: helmet.noSniff ?? DEFAULT_HELMET_CONFIG.noSniff,
    permittedCrossDomainPolicies:
      typeof helmet.permittedCrossDomainPolicies === "object"
        ? (helmet.permittedCrossDomainPolicies as { policy: string })
        : DEFAULT_HELMET_CONFIG.permittedCrossDomainPolicies,
    referrerPolicy:
      typeof helmet.referrerPolicy === "object"
        ? (helmet.referrerPolicy as { policy: string })
        : DEFAULT_HELMET_CONFIG.referrerPolicy,
    xssFilter: helmet.xssFilter ?? DEFAULT_HELMET_CONFIG.xssFilter,
  };
}
