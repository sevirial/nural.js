/**
 * A resolved encryption key used by the binary token engine.
 *
 * `secret` is the **final** 32-byte ChaCha20-Poly1305 key — providers derive it
 * via HKDF-SHA256 (see `deriveKeyMaterial`) at construction, so the engine uses
 * these bytes verbatim as the AEAD key. It is not the raw user secret.
 */
export interface NuraljsAuthKey {
  id: number;
  secret: Buffer;
}

/**
 * Interface for key management providers.
 * All key providers (static, local, cloud) implement this contract.
 */
export interface KeyProvider {
  getPrimaryKey(): Promise<NuraljsAuthKey>;
  getKey(id: number): Promise<NuraljsAuthKey | undefined>;
  /**
   * Releases any background resources (timers, poll loops). Optional — static
   * and local providers hold none; the cloud provider clears its poll timer.
   */
  dispose?(): void;
}

/**
 * Minimal structural logger — satisfied by the core `nuraljs` `Logger`. Kept
 * structural so a provider can be handed any logger (or a silent mock in tests)
 * without depending on a concrete class.
 */
export interface KmsLogger {
  warn(message: string): void;
  error(message: string, trace?: string): void;
}

/**
 * Configuration for the cloud KMS key provider.
 */
export interface CloudProviderOptions {
  /** Fetches the current key versions from your vault. Called on each poll. */
  fetchSecrets(): Promise<Array<{ versionId: number; value: string }>>;
  /** Steady-state poll interval, ms. Default 60_000. */
  pollIntervalMs?: number;
  /** First retry delay after a failed poll, ms (doubles per failure). Default 1_000. */
  backoffInitialMs?: number;
  /** Cap on the retry backoff delay, ms. Default 30_000. */
  backoffMaxMs?: number;
  /**
   * Grace period, ms, during which a key that has disappeared from the vault is
   * still accepted for verification (rotation overlap). Default 300_000 (5 min).
   * Set to 0 to evict rotated-out keys immediately.
   */
  overlapWindowMs?: number;
  /** Logger for poll failures/retries. Defaults to a core `Logger` ("CloudKMS"). */
  logger?: KmsLogger;
}

/**
 * The cloud provider extends the base contract with a lifecycle: an emergency
 * `refreshNow()` (force an immediate refresh after an out-of-band rotation) and
 * a `dispose()` that stops the poll timer.
 */
export interface CloudKeyProvider extends KeyProvider {
  /** Forces an immediate (single-flight) refresh — the emergency-rotation path. */
  refreshNow(): Promise<void>;
  /** Stops the background poll timer. Idempotent. */
  dispose(): void;
}
