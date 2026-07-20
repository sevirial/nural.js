import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { createCloudKeyProvider } from "./cloud-provider";
import type { CloudProviderOptions } from "./types";
import { createBinaryTokenEngine } from "../token/binary-token-engine";

// ≥ 32 chars (SECRET_LENGTH_RECOMMENDED), so these fixtures don't trip the
// short-secret deprecation warning — that path has its own spec below.
const LONG = (tag: string) => `${tag}_secret_that_is_at_least_32_chars!`;

const makeLogger = () => ({
  warn: vi.fn<(message: string) => void>(),
  error: vi.fn<(message: string, trace?: string) => void>(),
});

describe("createCloudKeyProvider", () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    logger = makeLogger();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("lazily loads keys on first read; the highest versionId is primary", async () => {
    const fetchSecrets = vi.fn().mockResolvedValue([
      { versionId: 1, value: LONG("v1") },
      { versionId: 3, value: LONG("v3") },
      { versionId: 2, value: LONG("v2") },
    ]);
    const provider = createCloudKeyProvider({ fetchSecrets, logger });

    expect((await provider.getPrimaryKey()).id).toBe(3);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);

    // Served from cache — no second fetch.
    expect((await provider.getKey(1))?.id).toBe(1);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect((await provider.getKey(3))?.secret).toHaveLength(32);

    provider.dispose();
  });

  it("de-dups concurrent cold reads into a single refresh (single-flight)", async () => {
    let release!: (v: Array<{ versionId: number; value: string }>) => void;
    const fetchSecrets = vi.fn(
      () =>
        new Promise<Array<{ versionId: number; value: string }>>((r) => {
          release = r;
        }),
    );
    const provider = createCloudKeyProvider({ fetchSecrets, logger });

    const a = provider.getPrimaryKey();
    const b = provider.getKey(2);
    // Both callers observed the empty cache and shared one in-flight fetch.
    expect(fetchSecrets).toHaveBeenCalledTimes(1);

    release([{ versionId: 2, value: LONG("v2") }]);
    const [primary, other] = await Promise.all([a, b]);

    expect(primary.id).toBe(2);
    expect(other?.id).toBe(2);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);

    provider.dispose();
  });

  it("logs and retries a failed poll with exponential backoff (never silent)", async () => {
    // Math.random -> 0 makes the equal-jitter delay deterministic: floor(ceiling/2).
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchSecrets = vi.fn().mockRejectedValue(new Error("vault down"));
    const provider = createCloudKeyProvider({
      fetchSecrets,
      logger,
      pollIntervalMs: 60_000,
      backoffInitialMs: 1_000,
      backoffMaxMs: 30_000,
    });

    // First scheduled poll fails.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSecrets).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/refresh failed \(attempt 1\)/);

    // Backoff attempt 1: ceiling min(30000, 1000*1)=1000 -> delay 500.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchSecrets).toHaveBeenCalledTimes(2);

    // Attempt 2: ceiling 2000 -> delay 1000.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSecrets).toHaveBeenCalledTimes(3);

    // Attempt 3: ceiling 4000 -> delay 2000.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSecrets).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledTimes(4);

    // No secret material is ever put in the log line.
    for (const call of logger.warn.mock.calls) {
      expect(call[0]).not.toContain("secret");
    }

    provider.dispose();
  });

  it("resets the backoff after a recovery", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchSecrets = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue([{ versionId: 1, value: LONG("v1") }]);
    const provider = createCloudKeyProvider({
      fetchSecrets,
      logger,
      pollIntervalMs: 10_000,
      backoffInitialMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(10_000); // poll #1 fails -> backoff 500
    expect(logger.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500); // poll #2 succeeds -> back to steady interval
    expect(fetchSecrets).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000); // next poll is a full interval away
    expect(fetchSecrets).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1); // no new failures

    provider.dispose();
  });

  it("dispose() stops the poll timer (no leak)", async () => {
    const fetchSecrets = vi.fn().mockRejectedValue(new Error("down"));
    const provider = createCloudKeyProvider({
      fetchSecrets,
      logger,
      pollIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const callsBefore = fetchSecrets.mock.calls.length;
    expect(callsBefore).toBe(1);

    provider.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchSecrets).toHaveBeenCalledTimes(callsBefore); // no further polls

    provider.dispose(); // idempotent
  });

  it("keeps a rotated-out key verifiable during the overlap window, then evicts it", async () => {
    const fetchSecrets = vi
      .fn()
      .mockResolvedValue([{ versionId: 3, value: LONG("v3") }]);
    // First load carries both keys.
    fetchSecrets.mockResolvedValueOnce([
      { versionId: 3, value: LONG("v3") },
      { versionId: 2, value: LONG("v2") },
    ]);

    const provider = createCloudKeyProvider({
      fetchSecrets,
      logger,
      overlapWindowMs: 10_000,
    });

    await provider.getPrimaryKey(); // loads {3, 2}; primary = 3
    expect((await provider.getKey(2))?.id).toBe(2);

    // Vault drops key 2. Within grace it is still accepted for verification.
    await provider.refreshNow();
    expect((await provider.getKey(2))?.id).toBe(2);

    // Past the grace window: evicted defensively even without a refresh.
    vi.setSystemTime(20_000);
    expect(await provider.getKey(2)).toBeUndefined();

    // A subsequent refresh prunes it from the cache entirely; primary unaffected.
    await provider.refreshNow();
    expect(await provider.getKey(2)).toBeUndefined();
    expect((await provider.getPrimaryKey()).id).toBe(3);

    provider.dispose();
  });

  it("refreshNow() forces an immediate pickup of a newly-rotated primary", async () => {
    const fetchSecrets = vi
      .fn()
      .mockResolvedValue([{ versionId: 1, value: LONG("v1") }]);
    const provider = createCloudKeyProvider({ fetchSecrets, logger });

    expect((await provider.getPrimaryKey()).id).toBe(1);

    // Operator rotates in the vault out-of-band.
    fetchSecrets.mockResolvedValue([
      { versionId: 2, value: LONG("v2") },
      { versionId: 1, value: LONG("v1") },
    ]);
    await provider.refreshNow();

    expect((await provider.getPrimaryKey()).id).toBe(2);

    provider.dispose();
  });

  it("propagates a cold-read failure and validates the vault response", async () => {
    const empty = createCloudKeyProvider({
      fetchSecrets: vi.fn().mockResolvedValue([]),
      logger,
    });
    await expect(empty.getPrimaryKey()).rejects.toThrow(/vault returned no keys/);
    empty.dispose();

    const malformed = createCloudKeyProvider({
      fetchSecrets: vi.fn().mockResolvedValue([{ versionId: 1, value: "short" }]),
      logger,
    });
    await expect(malformed.getPrimaryKey()).rejects.toThrow(/16 characters/);
    malformed.dispose();
  });

  it("rejects an invalid config (fetchSecrets not a function)", () => {
    expect(() =>
      createCloudKeyProvider({
        fetchSecrets: "nope",
      } as unknown as CloudProviderOptions),
    ).toThrow(/fetchSecrets must be a function/);
  });

  it("signs and verifies a token end-to-end through the engine", async () => {
    const schema = z.object({ id: z.string() });
    const provider = createCloudKeyProvider({
      fetchSecrets: vi
        .fn()
        .mockResolvedValue([{ versionId: 5, value: LONG("cloud") }]),
      logger,
    });
    const engine = createBinaryTokenEngine({
      schema,
      keyProvider: provider,
      expiresInSeconds: 60,
    });

    const token = await engine.sign({ id: "u1" });
    expect((await engine.verify(token)).id).toBe("u1");

    provider.dispose();
  });
});
