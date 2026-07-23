/**
 * User Routes
 * CRUD endpoints for user management
 */

import {
  createRoute,
  z,
  NotFoundException,
  ForbiddenException,
} from "@nuraljs/core";
import {
  UserSchema,
  CreateUserSchema,
  UpdateUserSchema,
  ErrorSchema,
  PaginationSchema,
} from "../schemas";
import { userService } from "../services";
import { authMiddleware, adminMiddleware } from "../middleware";
import type { AuthContext } from "../middleware";

/**
 * GET /users
 * List all users (Admin only)
 */
export const listUsersRoute = createRoute({
  method: "GET",
  path: "/users",
  summary: "List all users",
  description: "Get paginated list of all users. Requires admin role.",
  tags: ["Users"],
  middleware: [authMiddleware, adminMiddleware],
  request: {
    query: PaginationSchema,
  },
  responses: {
    200: z.object({
      data: z.array(UserSchema),
      total: z.number(),
      limit: z.number(),
      offset: z.number(),
    }),
    401: ErrorSchema,
    403: ErrorSchema,
  },
  handler: async ({ query }) => {
    const result = await userService.findAll(query.limit, query.offset);
    return {
      ...result,
      limit: query.limit,
      offset: query.offset,
    };
  },
});

/**
 * GET /users/:id
 * Get user by ID
 */
export const getUserRoute = createRoute({
  method: "GET",
  path: "/users/:id",
  summary: "Get user by ID",
  description: "Retrieve a single user by their UUID",
  tags: ["Users"],
  middleware: [authMiddleware],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: UserSchema,
    404: ErrorSchema,
  },
  handler: async ({ params }) => {
    const user = await userService.findById(params.id);

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return user;
  },
});

/**
 * POST /users
 * Create new user (Admin only)
 */
export const createUserRoute = createRoute({
  method: "POST",
  path: "/users",
  summary: "Create new user",
  description: "Create a new user account. Requires admin role.",
  tags: ["Users"],
  middleware: [authMiddleware, adminMiddleware],
  request: {
    body: CreateUserSchema,
  },
  responses: {
    201: UserSchema,
    400: ErrorSchema,
  },
  handler: async ({ body }) => {
    return await userService.create(body);
  },
});

/**
 * PATCH /users/:id
 * Update existing user
 */
export const updateUserRoute = createRoute({
  method: "PATCH",
  path: "/users/:id",
  summary: "Update user",
  description:
    "Update user details. Users can only update themselves unless admin.",
  tags: ["Users"],
  middleware: [authMiddleware],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
    body: UpdateUserSchema,
  },
  responses: {
    200: UserSchema,
    403: ErrorSchema,
    404: ErrorSchema,
  },
  handler: async (ctx) => {
    const { params, body } = ctx;
    const currentUser = (ctx as any).user as AuthContext["user"];

    // Only admins can update other users
    if (params.id !== currentUser.id && currentUser.role !== "admin") {
      throw new ForbiddenException("Cannot update other users");
    }

    // Only admins can change roles
    if (body.role && currentUser.role !== "admin") {
      throw new ForbiddenException("Cannot change role");
    }

    const updated = await userService.update(params.id, body);
    if (!updated) {
      throw new NotFoundException("User not found");
    }

    return updated;
  },
});

/**
 * DELETE /users/:id
 * Delete user (Admin only)
 */
export const deleteUserRoute = createRoute({
  method: "DELETE",
  path: "/users/:id",
  summary: "Delete user",
  description: "Permanently delete a user. Requires admin role.",
  tags: ["Users"],
  middleware: [authMiddleware, adminMiddleware],
  request: {
    params: z.object({
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: z.object({ success: z.boolean() }),
    404: ErrorSchema,
  },
  handler: async ({ params }) => {
    const deleted = await userService.delete(params.id);
    if (!deleted) {
      throw new NotFoundException("User not found");
    }
    return { success: true };
  },
});

// Export all user routes
export const userRoutes = [
  listUsersRoute,
  getUserRoute,
  createUserRoute,
  updateUserRoute,
  deleteUserRoute,
];
