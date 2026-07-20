import type { z } from "zod";
import { AuthConfigError } from "./errors";

/**
 * Validates a value against a Zod schema, throwing a single typed
 * {@link AuthConfigError} (extends core `HttpException`, code
 * `auth_config_invalid`) prefixed with `label` instead of a raw `ZodError`.
 *
 * Zod issue messages describe the failing *path* and constraint — they never
 * include the parsed input value — so a rejected secret/key never lands in the
 * error text. Used by every `createX` factory to validate its config at
 * construction (Sprint 6, T6.4).
 */
export function parseAuthConfig<T extends z.ZodTypeAny>(
  label: string,
  schema: T,
  value: unknown,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new AuthConfigError(`${label}: ${detail}`);
  }
  return result.data;
}
