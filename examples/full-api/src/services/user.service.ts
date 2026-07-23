/**
 * User Service
 * Business logic for user operations
 */

import type { User, CreateUserInput, UpdateUserInput } from "../schemas";
import { ConflictException } from "@nuraljs/core";

// In-memory store (replace with database in production)
const users: Map<string, User & { password: string }> = new Map([
  [
    "550e8400-e29b-41d4-a716-446655440001",
    {
      id: "550e8400-e29b-41d4-a716-446655440001",
      email: "admin@example.com",
      name: "Admin User",
      password: "admin123",
      role: "admin",
      createdAt: new Date().toISOString(),
    },
  ],
]);

export class UserService {
  async findAll(limit: number, offset: number) {
    const allUsers = Array.from(users.values());
    const paged = allUsers.slice(offset, offset + limit);

    return {
      data: paged.map(({ password, ...u }) => u),
      total: allUsers.length,
    };
  }

  async findById(id: string): Promise<User | null> {
    const user = users.get(id);
    if (!user) return null;

    const { password, ...safeUser } = user;
    return safeUser;
  }

  async findByEmail(email: string) {
    return Array.from(users.values()).find((u) => u.email === email) ?? null;
  }

  async create(input: CreateUserInput): Promise<User> {
    const existing = await this.findByEmail(input.email);
    if (existing) {
      throw new ConflictException("Email already registered");
    }

    const id = crypto.randomUUID();
    const newUser = {
      id,
      email: input.email,
      name: input.name,
      password: input.password,
      role: input.role,
      createdAt: new Date().toISOString(),
    };

    users.set(id, newUser);

    const { password, ...safeUser } = newUser;
    return safeUser;
  }

  async update(id: string, input: UpdateUserInput): Promise<User | null> {
    const user = users.get(id);
    if (!user) return null;

    const updated = { ...user, ...input };
    users.set(id, updated);

    const { password, ...safeUser } = updated;
    return safeUser;
  }

  async delete(id: string): Promise<boolean> {
    return users.delete(id);
  }

  async validateCredentials(
    email: string,
    password: string,
  ): Promise<User | null> {
    const user = await this.findByEmail(email);
    if (!user || user.password !== password) return null;

    const { password: _, ...safeUser } = user;
    return safeUser;
  }
}

// Singleton instance
export const userService = new UserService();
