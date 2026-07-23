/**
 * Auth Schema Definitions
 */

import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const TokenSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type TokenResponse = z.infer<typeof TokenSchema>;
