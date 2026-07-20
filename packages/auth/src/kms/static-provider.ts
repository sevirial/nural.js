import type { KeyProvider, NuraljsAuthKey } from "./types";
import { deriveKeyMaterial } from "./derive";
import { parseProviderConfig } from "./config";
import { createShortSecretWarner, secretSchema } from "./limits";

/** Static provider uses a fixed key id of `1` (no rotation). */
const STATIC_KEY_ID = 1;

const StaticSecretSchema = secretSchema();

/**
 * The simplest key provider — a single secret string from `.env` or config.
 *
 * - Derives a 32-byte AEAD key from the secret via HKDF-SHA256 (`deriveKeyMaterial`)
 * - Uses a fixed key ID of `1` (no rotation)
 * - Perfect for prototypes, small projects, and single-server deployments
 *
 * The secret must be at least {@link MIN_SECRET_LENGTH_HARD} characters, and
 * **should** be at least {@link SECRET_LENGTH_RECOMMENDED} — a shorter one warns
 * once and will be rejected next major (see `kms/limits.ts`).
 *
 * @example
 * ```ts
 * const auth = createAuth({
 *   strategy: {
 *     schema: UserSchema,
 *     keyProvider: createStaticKeyProvider(process.env.AUTH_SECRET!),
 *   },
 * });
 * ```
 */
export function createStaticKeyProvider(secret: string): KeyProvider {
  const parsed = parseProviderConfig(
    "createStaticKeyProvider",
    StaticSecretSchema,
    secret,
  );

  // Validation runs once per provider, so this warns once by construction.
  createShortSecretWarner("createStaticKeyProvider")([{ length: parsed.length }]);

  const key: NuraljsAuthKey = {
    id: STATIC_KEY_ID,
    secret: deriveKeyMaterial(parsed, STATIC_KEY_ID),
  };

  return {
    getPrimaryKey: async () => key,
    getKey: async (id) => (id === STATIC_KEY_ID ? key : undefined),
  };
}
