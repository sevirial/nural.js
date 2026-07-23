/**
 * Common Schema Definitions
 */

import { z } from "zod";

export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

// Use plain z.number() for OpenAPI compatibility
// Query string parsing is handled by the framework
export const PaginationSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(10),
  offset: z.number().min(0).optional().default(0),
});

export type ErrorResponse = z.infer<typeof ErrorSchema>;
