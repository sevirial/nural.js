/**
 * Unified Exception System
 * NestJS-style HTTP exceptions for standardized error handling
 */

export interface HttpErrorResponse {
  statusCode: number;
  message: string;
  error?: string;
  timestamp?: string;
  path?: string;
  details?: unknown;
}

/**
 * Base HTTP Exception Class
 */
export class HttpException extends Error {
  public readonly statusCode: number;
  public readonly error: string;
  public readonly details?: unknown;

  constructor(
    response: string | Record<string, any>,
    statusCode: number,
    details?: unknown,
  ) {
    const message =
      typeof response === "string" ? response : JSON.stringify(response);
    super(message);
    this.statusCode = statusCode;
    this.error = this.getStatusName(statusCode);
    this.details = details;

    // Maintain prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public getResponse(): HttpErrorResponse {
    return {
      statusCode: this.statusCode,
      message: this.message,
      error: this.error,
      timestamp: new Date().toISOString(),
      details: this.details,
    };
  }

  private getStatusName(code: number): string {
    // Machine-readable error codes in CONSTANT_CASE (matching the standard HTTP
    // status constant names). The human-readable text lives in `message`; this
    // `error` field is a stable code callers can branch on.
    const names: Record<number, string> = {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      402: "PAYMENT_REQUIRED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      405: "METHOD_NOT_ALLOWED",
      406: "NOT_ACCEPTABLE",
      408: "REQUEST_TIMEOUT",
      409: "CONFLICT",
      410: "GONE",
      412: "PRECONDITION_FAILED",
      413: "PAYLOAD_TOO_LARGE",
      415: "UNSUPPORTED_MEDIA_TYPE",
      418: "IM_A_TEAPOT",
      422: "UNPROCESSABLE_ENTITY",
      429: "TOO_MANY_REQUESTS",
      500: "INTERNAL_SERVER_ERROR",
      501: "NOT_IMPLEMENTED",
      502: "BAD_GATEWAY",
      503: "SERVICE_UNAVAILABLE",
      504: "GATEWAY_TIMEOUT",
    };
    return names[code] || "ERROR";
  }
}

/**
 * Normalizes arbitrary text (a status phrase, an `Error.name`) into a
 * CONSTANT_CASE error code — e.g. `"Not Found"` → `"NOT_FOUND"`,
 * `"ValidationError"` → `"VALIDATION_ERROR"`. Splits camelCase boundaries and
 * collapses any run of non-alphanumeric characters into a single underscore.
 */
export function toErrorCode(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

// --- Factory Classes for Common Exceptions ---

export class BadRequestException extends HttpException {
  constructor(message = "Bad Request", details?: unknown) {
    super(message, 400, details);
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = "Unauthorized", details?: unknown) {
    super(message, 401, details);
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = "Forbidden", details?: unknown) {
    super(message, 403, details);
  }
}

export class NotFoundException extends HttpException {
  constructor(message = "Not Found", details?: unknown) {
    super(message, 404, details);
  }
}

export class ConflictException extends HttpException {
  constructor(message = "Conflict", details?: unknown) {
    super(message, 409, details);
  }
}

export class GoneException extends HttpException {
  constructor(message = "Gone", details?: unknown) {
    super(message, 410, details);
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message = "Payload Too Large", details?: unknown) {
    super(message, 413, details);
  }
}

export class UnsupportedMediaTypeException extends HttpException {
  constructor(message = "Unsupported Media Type", details?: unknown) {
    super(message, 415, details);
  }
}

export class UnprocessableEntityException extends HttpException {
  constructor(message = "Unprocessable Entity", details?: unknown) {
    super(message, 422, details);
  }
}

export class InternalServerErrorException extends HttpException {
  constructor(message = "Internal Server Error", details?: unknown) {
    super(message, 500, details);
  }
}

export class NotImplementedException extends HttpException {
  constructor(message = "Not Implemented", details?: unknown) {
    super(message, 501, details);
  }
}

export class BadGatewayException extends HttpException {
  constructor(message = "Bad Gateway", details?: unknown) {
    super(message, 502, details);
  }
}

export class ServiceUnavailableException extends HttpException {
  constructor(message = "Service Unavailable", details?: unknown) {
    super(message, 503, details);
  }
}

export class GatewayTimeoutException extends HttpException {
  constructor(message = "Gateway Timeout", details?: unknown) {
    super(message, 504, details);
  }
}

/**
 * Custom Exception for specific use cases
 */
export class CustomException extends HttpException {
  constructor(message: string, statusCode: number, details?: unknown) {
    super(message, statusCode, details);
  }
}
