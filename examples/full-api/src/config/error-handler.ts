/**
 * Custom Error Handler
 * Production-grade error handling with logging
 */

import type { ErrorHandler } from "@nuraljs/core";
import { HttpException } from "@nuraljs/core";

/**
 * Custom error handler with categorization and logging
 */
export const errorHandler: ErrorHandler = async (ctx) => {
  const { error, method, path } = ctx;

  // Log error (in production, send to Sentry/DataDog/etc)
  console.error(`[ERROR] ${method} ${path}: ${error.message}`);

  // Zod validation errors
  if (error.name === "ZodError") {
    return {
      status: 400,
      body: {
        error: "Validation Error",
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

  // Authentication errors
  if (error.message.includes("Unauthorized")) {
    return {
      status: 401,
      body: {
        error: "Unauthorized",
        message: error.message.replace("Unauthorized: ", ""),
      },
    };
  }

  // Authorization errors
  if (error.message.includes("Forbidden")) {
    return {
      status: 403,
      body: {
        error: "Forbidden",
        message: error.message.replace("Forbidden: ", ""),
      },
    };
  }

  // Not found errors
  if (error.message.toLowerCase().includes("not found")) {
    return {
      status: 404,
      body: {
        error: "Not Found",
        message: error.message,
      },
    };
  }

  // Bad request errors
  if (
    error.message.includes("already registered") ||
    error.message.includes("already exists")
  ) {
    return {
      status: 400,
      body: {
        error: "Bad Request",
        message: error.message,
      },
    };
  }

  // Default: Internal Server Error
  return {
    status: 500,
    body: {
      error: "Internal Server Error",
      message:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred"
          : error.message,
    },
  };
};
