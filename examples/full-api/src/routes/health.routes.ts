/**
 * Health Routes
 * System health and status endpoints
 */

import { createRoute, z } from "@nuraljs/core";

/**
 * GET /health
 * System health check
 */
export const healthRoute = createRoute({
  method: "GET",
  path: "/health",
  summary: "Health check",
  description: "Check if the API is running",
  tags: ["System"],
  responses: {
    200: z.object({
      status: z.string(),
      timestamp: z.string(),
      uptime: z.number(),
    }),
  },
  handler: async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }),
});

// Export all health routes
export const healthRoutes = [healthRoute];
