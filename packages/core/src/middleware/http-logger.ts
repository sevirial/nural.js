/**
 * HTTP Logger Middleware
 * Logs incoming requests with duration and status
 */

import { Logger } from "../core/logger";

// Method Colors
const methodColors: Record<string, string> = {
  GET: "\x1b[32m", // Green
  POST: "\x1b[33m", // Yellow
  PUT: "\x1b[34m", // Blue
  DELETE: "\x1b[31m", // Red
  PATCH: "\x1b[35m", // Magenta
  OPTIONS: "\x1b[90m", // Gray
  HEAD: "\x1b[90m", // Gray
};

const resetColor = "\x1b[0m";

export interface HttpLoggerOptions {
  /** Show user agent in logs */
  showUserAgent?: boolean;
  /** Show request duration in logs */
  showTime?: boolean;
  /** Custom logger context name */
  context?: string;
}

/**
 * Format and emit a single request log line. Shared by the Express middleware
 * (below) and the Fastify `onResponse` hook (see {@link applyHttpLoggerFastify})
 * so both paths produce byte-identical output.
 */
function logRequest(
  logger: Logger,
  options: HttpLoggerOptions,
  method: string,
  url: string,
  status: number,
  duration: number,
  userAgent: string,
): void {
  const methodColor = methodColors[method] || resetColor;
  const coloredMethod = `${methodColor}${method}${resetColor}`;

  let logMessage = `${coloredMethod} ${url} ${status}`;

  if (options.showTime !== false) {
    logMessage += ` +${duration}ms`;
  }

  if (options.showUserAgent) {
    logMessage += ` - ${userAgent}`;
  }

  // Color code based on status
  if (status >= 500) logger.error(logMessage);
  else if (status >= 400) logger.warn(logMessage);
  else logger.log(logMessage);
}

/**
 * Creates an HTTP logger middleware (Express/legacy path).
 *
 * Attaches a per-request `finish` listener to time the response. On Fastify this
 * is routed through the adapter's `use()` — which wraps it in a `new Promise` —
 * so the default Fastify hot path uses {@link applyHttpLoggerFastify} instead,
 * a native `onResponse` hook with no per-request allocation.
 */
export const httpLogger = (options: HttpLoggerOptions = {}) => {
  const logger = new Logger(options.context || "Router");

  return (req: any, res: any, next?: () => void) => {
    const start = Date.now();

    // Handle both Express (res) and Fastify (res.raw)
    const rawRes = res.raw || res;

    // Hook into the 'finish' event (Standard Node.js Stream Event)
    rawRes.on("finish", () => {
      const { method, url, headers } = req;
      const duration = Date.now() - start;
      const status = rawRes.statusCode;
      const userAgent = headers ? headers["user-agent"] || "-" : "-";

      logRequest(logger, options, method, url, status, duration, userAgent);
    });

    if (next) {
      next();
    }
  };
};

/**
 * Registers the HTTP logger on a Fastify instance using a native `onResponse`
 * hook. Fastify manages the response lifecycle, so — unlike the Express
 * middleware routed through `adapter.use()` — there is **no per-request
 * `new Promise` wrapper and no manually-attached `finish` listener** on the hot
 * path. Timing comes from Fastify's own `reply.elapsedTime` (ms since the
 * request was received).
 */
export function applyHttpLoggerFastify(
  app: any,
  options: HttpLoggerOptions = {},
): void {
  const logger = new Logger(options.context || "Router");

  app.addHook("onResponse", async (req: any, reply: any) => {
    const duration = Math.round(reply.elapsedTime);
    const status = reply.statusCode;
    const userAgent = req.headers
      ? req.headers["user-agent"] || "-"
      : "-";

    logRequest(logger, options, req.method, req.url, status, duration, userAgent);
  });
}
