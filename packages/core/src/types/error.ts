/**
 * Error Types and Handler
 * Types for global error handling
 */

import type { Request, Response } from "express";
import type { FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { HttpException, toErrorCode } from "../core/exceptions";

/**
 * Error context passed to error handlers
 */
export interface ErrorContext {
  /** The error that occurred */
  error: Error;
  /** HTTP request (Express or Fastify) */
  request: Request | FastifyRequest;
  /** HTTP response (Express or Fastify) */
  response: Response | FastifyReply;
  /** Route path that errored */
  path?: string;
  /** HTTP method */
  method?: string;
}

/**
 * Error response returned by error handlers
 */
export interface ErrorResponse {
  /** HTTP status code */
  status: number;
  /** Response body */
  body: Record<string, unknown>;
  /** Optional headers to set */
  headers?: Record<string, string>;
}

/**
 * Global error handler function type
 */
export type ErrorHandler = (
  ctx: ErrorContext,
) => ErrorResponse | Promise<ErrorResponse>;

/**
 * Error handler configuration
 */
export interface ErrorHandlerConfig {
  /** Custom error handler function */
  handler?: ErrorHandler;
  /** Include stack trace in development */
  includeStack?: boolean;
  /** Log errors to console */
  logErrors?: boolean;
  /** Custom error logger */
  logger?: (error: Error, ctx: ErrorContext) => void;
}

/**
 * Resolved error handler config with defaults
 */
export interface ResolvedErrorHandlerConfig {
  handler: ErrorHandler;
  includeStack: boolean;
  logErrors: boolean;
  logger: (error: Error, ctx: ErrorContext) => void;
}

/**
 * Default error logger
 */
const defaultLogger = (error: Error, ctx: ErrorContext) => {
  console.error(`[Nuraljs Error] ${ctx.method} ${ctx.path}:`, error.message);
  if (error.stack) {
    console.error(error.stack);
  }
};

/**
 * Default error handler - converts errors to HTTP responses
 */
export const defaultErrorHandler: ErrorHandler = (ctx) => {
  const { error } = ctx;

  // Zod validation error
  if (error.name === "ZodError" && "issues" in error) {
    return {
      status: 400,
      body: {
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: (error as any).issues,
      },
    };
  }

  // Unified Exception Handling
  if (error instanceof HttpException) {
    const response = error.getResponse();
    return {
      status: response.statusCode,
      body: response as unknown as Record<string, unknown>,
    };
  }

  // Custom HTTP error (has status property) - Legacy support
  if ("status" in error && typeof (error as any).status === "number") {
    return {
      status: (error as any).status,
      body: {
        error: error.name ? toErrorCode(error.name) : "ERROR",
        message: error.message,
      },
    };
  }

  // Auth errors
  if (
    error.message.toLowerCase().includes("unauthorized") ||
    error.message.toLowerCase().includes("authentication")
  ) {
    return {
      status: 401,
      body: {
        error: "UNAUTHORIZED",
        message: error.message,
      },
    };
  }

  if (
    error.message.toLowerCase().includes("forbidden") ||
    error.message.toLowerCase().includes("permission")
  ) {
    return {
      status: 403,
      body: {
        error: "FORBIDDEN",
        message: error.message,
      },
    };
  }

  if (error.message.toLowerCase().includes("not found")) {
    return {
      status: 404,
      body: {
        error: "NOT_FOUND",
        message: error.message,
      },
    };
  }

  // Default: Internal Server Error
  return {
    status: 500,
    body: {
      error: "INTERNAL_SERVER_ERROR",
      message:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred"
          : error.message,
    },
  };
};

/* -------------------------------------------------------------------------- */
/*  ajv / Fastify validation-error → ZodError parity (Sprint 3)               */
/* -------------------------------------------------------------------------- */
//
// On the fast path, ajv (not Zod) validates params/query/body, so a validation
// failure surfaces as a Fastify validation error rather than a `ZodError`. To
// keep the 400 body identical to the pre-rewrite runtime-Zod path, we map the
// ajv error back into a real `ZodError` and let it flow through the exact same
// `defaultErrorHandler` branch above (`error.name === "ZodError"`). This also
// hands custom error handlers a genuine `ZodError` (`instanceof` holds), as the
// old `parseAsync` path did.

/** A single ajv error object as attached to `error.validation` by Fastify. */
interface AjvValidationError {
  keyword: string;
  instancePath: string;
  schemaPath: string;
  params: Record<string, unknown>;
  message?: string;
}

/** A Fastify validation error (carries the ajv `.validation` array). */
export interface FastifyValidationError extends Error {
  validation: AjvValidationError[];
  /** Which request slot failed: "body" | "querystring" | "params" | "headers". */
  validationContext?: string;
}

/**
 * Type guard: a thrown error is a Fastify/ajv schema-validation failure.
 */
export function isValidationError(
  error: unknown,
): error is FastifyValidationError {
  return (
    error instanceof Error &&
    Array.isArray((error as FastifyValidationError).validation)
  );
}

/**
 * Parse an ajv JSON-Pointer `instancePath` (e.g. `/address/city`, `/tags/0`)
 * into a Zod-style path array, unescaping the `~1`→`/` and `~0`→`~` tokens and
 * coercing numeric segments to numbers (array indices), matching how Zod emits
 * paths per slot.
 */
function instancePathToZodPath(instancePath: string): (string | number)[] {
  if (!instancePath) return [];
  return instancePath
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      const key = seg.replace(/~1/g, "/").replace(/~0/g, "~");
      return /^\d+$/.test(key) ? Number(key) : key;
    });
}

/**
 * Map one ajv error into a Zod-4-shaped issue object. ajv and Zod describe
 * failures differently, so this is a best-effort structural mapping onto Zod's
 * issue `code`s; `path`/`message` are carried faithfully.
 */
function ajvErrorToZodIssue(err: AjvValidationError): Record<string, unknown> {
  const path = instancePathToZodPath(err.instancePath);
  const params = err.params ?? {};
  const message = err.message ?? "Invalid input";

  switch (err.keyword) {
    case "required": {
      // A missing key: Zod models this as `invalid_type` on the key's path.
      if (typeof params.missingProperty === "string") {
        path.push(params.missingProperty);
      }
      return { code: "invalid_type", path, message };
    }
    case "type":
      return { code: "invalid_type", expected: params.type, path, message };
    case "enum":
    case "const":
      return { code: "invalid_value", path, message };
    case "pattern":
    case "format":
      return { code: "invalid_format", format: params.format, path, message };
    case "minimum":
    case "exclusiveMinimum":
    case "minLength":
    case "minItems":
    case "minProperties":
      return { code: "too_small", path, message };
    case "maximum":
    case "exclusiveMaximum":
    case "maxLength":
    case "maxItems":
    case "maxProperties":
      return { code: "too_big", path, message };
    case "multipleOf":
      return { code: "not_multiple_of", path, message };
    case "additionalProperties":
      return {
        code: "unrecognized_keys",
        keys:
          typeof params.additionalProperty === "string"
            ? [params.additionalProperty]
            : [],
        path,
        message,
      };
    default:
      return { code: "custom", path, message };
  }
}

/**
 * Convert a Fastify/ajv validation failure into a real `ZodError`, so it emits
 * the same 400 body as the pre-rewrite runtime-Zod path (`details` = issues).
 * The ajv error's stack is carried over so non-prod `includeStack` still yields
 * a `stack` field (content is inherently non-deterministic; presence matches).
 */
export function zodErrorFromValidation(
  error: FastifyValidationError,
): ZodError {
  const issues = error.validation.map(ajvErrorToZodIssue);
  const zodError = new ZodError(issues as never);
  if (error.stack) zodError.stack = error.stack;
  return zodError;
}

/**
 * Default error handler config
 */
export const DEFAULT_ERROR_HANDLER_CONFIG: ResolvedErrorHandlerConfig = {
  handler: defaultErrorHandler,
  includeStack: process.env.NODE_ENV !== "production",
  logErrors: true,
  logger: defaultLogger,
};

/**
 * Resolve error handler config from user input
 */
export function resolveErrorHandlerConfig(
  config?: boolean | ErrorHandler | ErrorHandlerConfig,
): ResolvedErrorHandlerConfig {
  // Disabled
  if (config === false) {
    return {
      ...DEFAULT_ERROR_HANDLER_CONFIG,
      logErrors: false,
    };
  }

  // Default config
  if (config === true || config === undefined) {
    return DEFAULT_ERROR_HANDLER_CONFIG;
  }

  // Function only
  if (typeof config === "function") {
    return {
      ...DEFAULT_ERROR_HANDLER_CONFIG,
      handler: config,
    };
  }

  // Full config object
  return {
    handler: config.handler ?? DEFAULT_ERROR_HANDLER_CONFIG.handler,
    includeStack:
      config.includeStack ?? DEFAULT_ERROR_HANDLER_CONFIG.includeStack,
    logErrors: config.logErrors ?? DEFAULT_ERROR_HANDLER_CONFIG.logErrors,
    logger: config.logger ?? DEFAULT_ERROR_HANDLER_CONFIG.logger,
  };
}
