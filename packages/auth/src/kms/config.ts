import type { z } from "zod";
import { parseAuthConfig } from "../config";

/**
 * Validates a provider config against a Zod schema, throwing a typed
 * {@link import("../errors").AuthConfigError} prefixed with the provider name
 * instead of a raw `ZodError`. Thin alias over {@link parseAuthConfig} — kept as
 * a named export so the KMS providers' import sites are unchanged.
 *
 * Zod issue messages never include the parsed input value (only the failing
 * path + a description), so a rejected secret never lands in the error text.
 */
export function parseProviderConfig<T extends z.ZodTypeAny>(
  label: string,
  schema: T,
  value: unknown,
): z.infer<T> {
  return parseAuthConfig(label, schema, value);
}
