/**
 * User Schema Definitions
 * Shared validation schemas for user-related operations
 */

import { z } from "zod";

// Base user schema (what gets stored)
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(2).max(100),
  role: z.enum(["admin", "user", "guest"]),
  createdAt: z.string().describe("ISO 8601 datetime"),
});

// Create user input
export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(100),
  password: z.string().min(8),
  role: z.enum(["admin", "user", "guest"]).optional().default("user"),
});

// Update user input
export const UpdateUserSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  role: z.enum(["admin", "user", "guest"]).optional(),
});

// Type exports
export type User = z.infer<typeof UserSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
