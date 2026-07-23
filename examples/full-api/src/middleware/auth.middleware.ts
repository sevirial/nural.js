/**
 * Auth Middleware
 * JWT-style authentication and authorization
 */

import {
  defineMiddleware,
  UnauthorizedException,
  ForbiddenException,
} from "@nuraljs/core";
import { userService } from "../services";
import type { Request } from "express";

/**
 * Authenticated user context
 */
export interface AuthContext {
  user: {
    id: string;
    email: string;
    name: string;
    role: "admin" | "user" | "guest";
  };
}

/**
 * Extract token from Authorization header
 */
function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Authentication middleware
 * Validates token and adds user to context
 */
export const authMiddleware = defineMiddleware(async (req) => {
  const token = extractToken(req as Request);

  if (!token) {
    throw new UnauthorizedException("Missing or invalid token");
  }

  // In production, verify JWT here
  // For demo, we use a simple token format: user:{userId}
  if (!token.startsWith("user:")) {
    throw new UnauthorizedException("Invalid token format");
  }

  const userId = token.slice(5);
  const user = await userService.findById(userId);

  if (!user) {
    throw new UnauthorizedException("User not found");
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
});

/**
 * Admin authorization middleware
 * Must be used after authMiddleware
 */
export const adminMiddleware = defineMiddleware(async (req) => {
  const token = extractToken(req as Request);
  if (!token?.startsWith("user:")) {
    throw new ForbiddenException("Admin access required");
  }

  const userId = token.slice(5);
  const user = await userService.findById(userId);

  if (user?.role !== "admin") {
    throw new ForbiddenException("Admin access required");
  }

  return {};
});
