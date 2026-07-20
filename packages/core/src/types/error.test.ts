/**
 * Error Handler Tests
 */

import { describe, it, expect, vi } from "vitest";
import { ZodError, z } from "zod";
import {
  defaultErrorHandler,
  resolveErrorHandlerConfig,
  DEFAULT_ERROR_HANDLER_CONFIG,
} from "./error";
import type { ErrorContext } from "./error";

describe("Error Handler", () => {
  const mockContext = (error: Error): ErrorContext => ({
    error,
    request: {} as any,
    response: {} as any,
    path: "/test",
    method: "GET",
  });

  describe("defaultErrorHandler", () => {
    it("should return 400 for ZodError", async () => {
      const schema = z.object({ name: z.string() });
      let zodError: ZodError;
      try {
        schema.parse({ name: 123 });
      } catch (e) {
        zodError = e as ZodError;
      }

      const response = await defaultErrorHandler(mockContext(zodError!));
      expect(response.status).toBe(400);
      expect(response.body.error).toBe("VALIDATION_ERROR");
    });

    it("should return 401 for unauthorized errors", async () => {
      const error = new Error("Unauthorized access");
      const response = await defaultErrorHandler(mockContext(error));
      expect(response.status).toBe(401);
      expect(response.body.error).toBe("UNAUTHORIZED");
    });

    it("should return 403 for forbidden errors", async () => {
      const error = new Error("Access forbidden");
      const response = await defaultErrorHandler(mockContext(error));
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("FORBIDDEN");
    });

    it("should return 404 for not found errors", async () => {
      const error = new Error("User not found");
      const response = await defaultErrorHandler(mockContext(error));
      expect(response.status).toBe(404);
      expect(response.body.error).toBe("NOT_FOUND");
    });

    it("should return 500 for generic errors", async () => {
      const error = new Error("Something broke");
      const response = await defaultErrorHandler(mockContext(error));
      expect(response.status).toBe(500);
      expect(response.body.error).toBe("INTERNAL_SERVER_ERROR");
    });

    it("should use custom status from error", async () => {
      const error = new Error("Rate limited") as Error & { status: number };
      error.status = 429;
      const response = await defaultErrorHandler(mockContext(error));
      expect(response.status).toBe(429);
    });
  });

  describe("resolveErrorHandlerConfig", () => {
    it("should return defaults for true", () => {
      const config = resolveErrorHandlerConfig(true);
      expect(config.handler).toBe(DEFAULT_ERROR_HANDLER_CONFIG.handler);
      expect(config.logErrors).toBe(true);
    });

    it("should return defaults for undefined", () => {
      const config = resolveErrorHandlerConfig(undefined);
      expect(config.handler).toBe(DEFAULT_ERROR_HANDLER_CONFIG.handler);
    });

    it("should disable logging for false", () => {
      const config = resolveErrorHandlerConfig(false);
      expect(config.logErrors).toBe(false);
    });

    it("should use custom function when provided", () => {
      const customHandler = vi.fn(() => ({ status: 418, body: { tea: true } }));
      const config = resolveErrorHandlerConfig(customHandler);
      expect(config.handler).toBe(customHandler);
    });

    it("should merge config object with defaults", () => {
      const customLogger = vi.fn();
      const config = resolveErrorHandlerConfig({
        logger: customLogger,
        includeStack: false,
      });

      expect(config.logger).toBe(customLogger);
      expect(config.includeStack).toBe(false);
      expect(config.handler).toBe(DEFAULT_ERROR_HANDLER_CONFIG.handler);
    });
  });
});
