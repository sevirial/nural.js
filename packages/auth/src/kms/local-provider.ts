import { z } from "zod";
import type { KeyProvider, NuraljsAuthKey } from "./types";
import { deriveKeyMaterial } from "./derive";
import { parseProviderConfig } from "./config";
import { createShortSecretWarner, secretSchema } from "./limits";

export interface LocalKeyConfig {
  id: number;
  secret: string;
}

const LocalKeySchema = z.object({
  id: z
    .number()
    .int("id must be an integer")
    .min(0, "id must be non-negative")
    .max(0xffffffff, "id must fit in 32 bits"),
  secret: secretSchema(),
});

const LocalConfigSchema = z
  .array(LocalKeySchema)
  .min(1, "at least one key is required")
  .refine(
    (keys) => new Set(keys.map((k) => k.id)).size === keys.length,
    "key ids must be unique",
  );

/**
 * In-memory key provider supporting multiple keys for zero-downtime rotation.
 *
 * - Accepts an array of `{ id, secret }` entries
 * - The **first** key in the array is treated as the primary (signing) key
 * - Each secret is turned into a 32-byte AEAD key via HKDF-SHA256 (`deriveKeyMaterial`)
 * - Each secret must be ≥ 16 characters and **should** be ≥ 32; a shorter one
 *   warns once, naming the key ids to rotate (see `kms/limits.ts`)
 * - Ideal for testing key rotation, staging environments, or apps that
 *   manage keys via environment variables / config files
 *
 * @example
 * ```ts
 * const auth = createAuth({
 *   strategy: {
 *     schema: UserSchema,
 *     keyProvider: createLocalKeyProvider([
 *       { id: 2, secret: process.env.AUTH_KEY_CURRENT! },
 *       { id: 1, secret: process.env.AUTH_KEY_PREVIOUS! },
 *     ]),
 *   },
 * });
 * ```
 */
export function createLocalKeyProvider(keys: LocalKeyConfig[]): KeyProvider {
  const parsed = parseProviderConfig(
    "createLocalKeyProvider",
    LocalConfigSchema,
    keys,
  );

  // Validation runs once per provider, so this warns once by construction; the
  // ids tell the operator exactly which keys to rotate.
  createShortSecretWarner("createLocalKeyProvider")(
    parsed.map((k) => ({ length: k.secret.length, id: k.id })),
  );

  const keyMap = new Map<number, NuraljsAuthKey>();
  for (const k of parsed) {
    keyMap.set(k.id, { id: k.id, secret: deriveKeyMaterial(k.secret, k.id) });
  }

  const primaryId = parsed[0]!.id;

  return {
    getPrimaryKey: async () => {
      const key = keyMap.get(primaryId);
      if (!key) throw new Error("Local KMS: Primary key resolution failed");
      return key;
    },
    getKey: async (id) => keyMap.get(id),
  };
}
