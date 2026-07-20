import { z } from "zod";
import type {
  CloudKeyProvider,
  CloudProviderOptions,
  KmsLogger,
  NuraljsAuthKey,
} from "./types";
import { deriveKeyMaterial } from "./derive";
import { parseProviderConfig } from "./config";
import { createShortSecretWarner, secretSchema } from "./limits";

/**
 * Minimal default logger — writes poll failures to stderr so they are never
 * silent, without pulling the core `Logger` (and its Fastify barrel) into this
 * low-level KMS module. Pass `options.logger` (e.g. a `nuraljs` `Logger`) to route
 * these through your app's structured logging.
 */
const defaultLogger: KmsLogger = {
  warn: (message) => process.stderr.write(`[CloudKMS] WARN ${message}\n`),
  error: (message, trace) => {
    process.stderr.write(`[CloudKMS] ERROR ${message}\n`);
    if (trace) process.stderr.write(`${trace}\n`);
  },
};

// ──────────────────────────────────────────────────────────────────
// Config validation
// ──────────────────────────────────────────────────────────────────

const CloudConfigSchema = z.object({
  fetchSecrets: z.custom<CloudProviderOptions["fetchSecrets"]>(
    (v) => typeof v === "function",
    "fetchSecrets must be a function",
  ),
  pollIntervalMs: z.number().int().positive().optional(),
  backoffInitialMs: z.number().int().positive().optional(),
  backoffMaxMs: z.number().int().positive().optional(),
  overlapWindowMs: z.number().int().nonnegative().optional(),
  logger: z
    .custom<KmsLogger>((v) => {
      if (typeof v !== "object" || v === null) return false;
      const l = v as Partial<KmsLogger>;
      return typeof l.warn === "function" && typeof l.error === "function";
    }, "logger must implement warn() and error()")
    .optional(),
});

/** Validates the shape the vault hands back — external input, so schema-checked. */
const VaultSecretsSchema = z
  .array(
    z.object({
      versionId: z
        .number()
        .int("versionId must be an integer")
        .min(0, "versionId must be non-negative")
        .max(0xffffffff, "versionId must fit in 32 bits"),
      value: secretSchema("key value"),
    }),
  )
  .min(1, "vault returned no keys");

// ──────────────────────────────────────────────────────────────────
// Backoff
// ──────────────────────────────────────────────────────────────────

/**
 * Exponential backoff with equal jitter: the delay for failure `n` is drawn from
 * `[d/2, d]` where `d = min(max, initial * 2^(n-1))`. Jitter spreads retries so
 * a fleet of servers doesn't stampede a recovering vault in lockstep.
 */
function backoffDelay(attempt: number, initialMs: number, maxMs: number): number {
  const ceiling = Math.min(maxMs, initialMs * 2 ** (attempt - 1));
  const half = Math.floor(ceiling / 2);
  return half + Math.floor(Math.random() * (ceiling - half + 1));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A cached key remembers when it was retired (dropped from the vault) so the
// overlap window can evict it once the grace period elapses.
interface CachedKey extends NuraljsAuthKey {
  retiredAt?: number;
}

/**
 * Production key provider that auto-polls a remote key vault (AWS KMS,
 * GCP Secret Manager, HashiCorp Vault, etc.) for key rotation.
 *
 * - Calls `fetchSecrets()` to retrieve key versions; caches them in memory
 * - Derives each 32-byte AEAD key via HKDF-SHA256 (`deriveKeyMaterial`)
 * - Warns **once** (via `logger`) if the vault serves a key value under 32
 *   characters — deprecated, and rejected next major (see `kms/limits.ts`)
 * - The highest `versionId` is always the primary signing key
 * - Polls on `pollIntervalMs`; a failed poll is **logged and retried with
 *   exponential backoff** (never silently swallowed)
 * - Concurrent cold reads share a **single in-flight** refresh (no thundering herd)
 * - Cache + primary id are swapped **atomically** (no torn intermediate state)
 * - A key that disappears from the vault stays verifiable for `overlapWindowMs`
 *   (**rotation overlap**), then is evicted
 * - `refreshNow()` forces an immediate refresh (emergency rotation);
 *   `dispose()` stops the poll timer
 *
 * @example
 * ```ts
 * const kms = createCloudKeyProvider({
 *   fetchSecrets: () => fetchFromAWSSecretsManager(),
 *   pollIntervalMs: 60_000,
 * });
 * // ...later, on shutdown:
 * kms.dispose();
 * ```
 */
export function createCloudKeyProvider(
  options: CloudProviderOptions,
): CloudKeyProvider {
  const cfg = parseProviderConfig(
    "createCloudKeyProvider",
    CloudConfigSchema,
    options,
  );

  const fetchSecrets = cfg.fetchSecrets;
  const pollIntervalMs = cfg.pollIntervalMs ?? 60_000;
  const backoffInitialMs = cfg.backoffInitialMs ?? 1_000;
  const backoffMaxMs = cfg.backoffMaxMs ?? 30_000;
  const overlapWindowMs = cfg.overlapWindowMs ?? 300_000;
  const logger: KmsLogger = cfg.logger ?? defaultLogger;

  let cachedKeys = new Map<number, CachedKey>();
  let primaryKeyId = 0;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let consecutiveFailures = 0;

  // Built once per provider and latching after its first warning — `doRefresh`
  // re-validates the vault response on every poll, so a per-parse warning would
  // otherwise repeat forever. Routed through the provider's logger.
  const warnShortSecrets = createShortSecretWarner("Cloud KMS", logger);

  // ── Refresh (atomic swap; carries over rotated-out keys within the grace window)
  const doRefresh = async (): Promise<void> => {
    const secrets = parseProviderConfig(
      "Cloud KMS vault response",
      VaultSecretsSchema,
      await fetchSecrets(),
    );

    warnShortSecrets(secrets.map((s) => ({ length: s.value.length, id: s.versionId })));

    const sorted = [...secrets].sort((a, b) => b.versionId - a.versionId);
    const newPrimaryId = sorted[0]!.versionId;
    const now = Date.now();

    const newCache = new Map<number, CachedKey>();
    for (const s of sorted) {
      newCache.set(s.versionId, {
        id: s.versionId,
        secret: deriveKeyMaterial(s.value, s.versionId),
      });
    }

    // Rotation overlap: a key that vanished from the vault is retained (marked
    // retired) until its grace period elapses, so tokens signed just before
    // rotation still verify. Keys still present shed any prior retirement.
    for (const [id, old] of cachedKeys) {
      if (newCache.has(id)) continue;
      const retiredAt = old.retiredAt ?? now;
      if (now - retiredAt <= overlapWindowMs) {
        newCache.set(id, { id: old.id, secret: old.secret, retiredAt });
      }
    }

    // Single synchronous swap — no reader ever sees a primary id that is not
    // yet backed by a cache entry.
    cachedKeys = newCache;
    primaryKeyId = newPrimaryId;
  };

  // ── Single-flight: concurrent callers share one in-flight refresh.
  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = doRefresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  // ── Self-scheduling poll loop with backoff on failure.
  const scheduleNext = (delayMs: number): void => {
    if (disposed) return;
    timer = setTimeout(runPoll, delayMs);
    // Don't keep the event loop alive just for key polling.
    if (typeof timer.unref === "function") timer.unref();
  };

  const runPoll = (): void => {
    refresh().then(
      () => {
        consecutiveFailures = 0;
        scheduleNext(pollIntervalMs);
      },
      (err: unknown) => {
        consecutiveFailures += 1;
        const delay = backoffDelay(
          consecutiveFailures,
          backoffInitialMs,
          backoffMaxMs,
        );
        logger.warn(
          `Cloud KMS: key refresh failed (attempt ${consecutiveFailures}), ` +
            `retrying in ${delay}ms — ${errorMessage(err)}`,
        );
        scheduleNext(delay);
      },
    );
  };

  scheduleNext(pollIntervalMs);

  const ensureLoaded = async (): Promise<void> => {
    if (cachedKeys.size === 0) await refresh();
  };

  const live = (key: CachedKey | undefined): NuraljsAuthKey | undefined => {
    if (!key) return undefined;
    // Defensive: evict a retired key whose grace expired between refreshes.
    if (key.retiredAt !== undefined && Date.now() - key.retiredAt > overlapWindowMs) {
      return undefined;
    }
    return { id: key.id, secret: key.secret };
  };

  return {
    getPrimaryKey: async () => {
      await ensureLoaded();
      const key = live(cachedKeys.get(primaryKeyId));
      if (!key) throw new Error("Cloud KMS: primary key resolution failed");
      return key;
    },
    getKey: async (id) => {
      await ensureLoaded();
      return live(cachedKeys.get(id));
    },
    refreshNow: () => refresh(),
    dispose: () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
