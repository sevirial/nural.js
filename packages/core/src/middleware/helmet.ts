/**
 * Helmet Middleware
 * Zero-dependency security headers implementation for Nuraljs
 */

import type { ResolvedHelmetConfig } from "../types/middleware";

/**
 * Security headers to apply to responses
 */
export type SecurityHeaders = Record<string, string>;

/**
 * Generate Content-Security-Policy header value
 */
function buildCspHeader(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(" ")}`)
    .join("; ");
}

/**
 * Generate all security headers based on config
 */
export function getSecurityHeaders(
  config: ResolvedHelmetConfig,
): SecurityHeaders {
  const headers: SecurityHeaders = {};

  // Content-Security-Policy
  if (
    typeof config.contentSecurityPolicy === "object" &&
    config.contentSecurityPolicy.directives
  ) {
    headers["Content-Security-Policy"] = buildCspHeader(
      config.contentSecurityPolicy.directives,
    );
  }

  // Cross-Origin-Embedder-Policy
  if (config.crossOriginEmbedderPolicy) {
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }

  // Cross-Origin-Opener-Policy
  if (config.crossOriginOpenerPolicy) {
    headers["Cross-Origin-Opener-Policy"] =
      config.crossOriginOpenerPolicy.policy;
  }

  // Cross-Origin-Resource-Policy
  if (config.crossOriginResourcePolicy) {
    headers["Cross-Origin-Resource-Policy"] =
      config.crossOriginResourcePolicy.policy;
  }

  // X-DNS-Prefetch-Control
  headers["X-DNS-Prefetch-Control"] = config.dnsPrefetchControl.allow
    ? "on"
    : "off";

  // X-Frame-Options
  headers["X-Frame-Options"] = config.frameguard.action.toUpperCase();

  // Strict-Transport-Security (HSTS)
  if (config.hsts) {
    let hstsValue = `max-age=${config.hsts.maxAge}`;
    if (config.hsts.includeSubDomains) {
      hstsValue += "; includeSubDomains";
    }
    if (config.hsts.preload) {
      hstsValue += "; preload";
    }
    headers["Strict-Transport-Security"] = hstsValue;
  }

  // X-Content-Type-Options
  if (config.noSniff) {
    headers["X-Content-Type-Options"] = "nosniff";
  }

  // X-Permitted-Cross-Domain-Policies
  headers["X-Permitted-Cross-Domain-Policies"] =
    config.permittedCrossDomainPolicies.policy;

  // Referrer-Policy
  headers["Referrer-Policy"] = config.referrerPolicy.policy;

  // X-XSS-Protection (legacy, but some still use it)
  if (config.xssFilter) {
    headers["X-XSS-Protection"] = "1; mode=block";
  } else {
    headers["X-XSS-Protection"] = "0";
  }

  return headers;
}

/**
 * Apply security headers for Express
 */
export function applyHelmetExpress(
  app: any,
  config: ResolvedHelmetConfig,
): void {
  const headers = getSecurityHeaders(config);

  app.use((_req: any, res: any, next: any) => {
    Object.entries(headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    next();
  });
}

/**
 * Apply security headers for Fastify
 */
export function applyHelmetFastify(
  app: any,
  config: ResolvedHelmetConfig,
): void {
  const headers = getSecurityHeaders(config);

  app.addHook("onRequest", async (_request: any, reply: any) => {
    Object.entries(headers).forEach(([key, value]) => {
      reply.header(key, value);
    });
  });
}
