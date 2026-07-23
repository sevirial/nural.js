/**
 * Auth Routes
 * Authentication endpoints
 */

import { createRoute, z, UnauthorizedException } from "@nuraljs/core";
import { LoginSchema, TokenSchema, UserSchema, ErrorSchema } from "../schemas";
import { userService } from "../services";
import { authMiddleware } from "../middleware";

/**
 * POST /auth/login
 * Authenticate user and get access token
 */
export const loginRoute = createRoute({
  method: "POST",
  path: "/auth/login",
  summary: "Login to get access token",
  description: "Authenticate with email and password to receive a JWT token",
  tags: ["Auth"],
  request: {
    body: LoginSchema,
  },
  responses: {
    200: TokenSchema,
    401: ErrorSchema,
  },
  handler: async ({ body }) => {
    const user = await userService.validateCredentials(
      body.email,
      body.password,
    );

    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    // In production, generate a proper JWT here
    return {
      accessToken: `user:${user.id}`,
      expiresIn: 3600,
    };
  },
});

/**
 * GET /auth/me
 * Get current authenticated user profile
 */
export const meRoute = createRoute({
  method: "GET",
  path: "/auth/me",
  summary: "Get current user profile",
  description: "Returns the profile of the currently authenticated user",
  tags: ["Auth"],
  middleware: [authMiddleware],
  responses: {
    200: UserSchema.omit({ createdAt: true }),
    401: ErrorSchema,
  },
  // Route-specific security
  security: [{ bearerAuth: [] }],
  // Custom OpenAPI overrides (e.g., custom header)
  openapi: {
    parameters: [
      {
        in: "header",
        name: "X-Custom-Header",
        schema: { type: "string" },
        required: false,
        description: "Custom header example",
      },
    ],
  },
  handler: async (ctx) => {
    const { user } = ctx as {
      user: { id: string; email: string; name: string; role: string };
    };
    return user;
  },
});

// Export all auth routes
export const authRoutes = [loginRoute, meRoute];
