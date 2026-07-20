// ──────────────────────────────────────────────────────────────────
// Provider secret-length floor + deprecation window (Sprint SF3 — audit L5).
//
// Strategy under test is **warn-then-enforce**: < 16 is still a hard reject,
// 16–31 warns exactly once per provider and keeps working, ≥ 32 is silent. The
// warning must name no secret bytes, and must not repeat on a provider that
// re-validates on a schedule (the cloud provider polls its vault).
// ──────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MIN_SECRET_LENGTH_HARD,
  SECRET_LENGTH_RECOMMENDED,
  SHORT_SECRET_WARNING_CODE,
} from "./limits";
import { createStaticKeyProvider } from "./static-provider";
import { createLocalKeyProvider } from "./local-provider";
import { createCloudKeyProvider } from "./cloud-provider";
import type { KmsLogger } from "./types";

/** A secret of exactly `n` characters, with a recognizable marker to hunt for in logs. */
const secretOf = (n: number, marker = "S"): string => marker.repeat(n);

const RECOMMENDED = secretOf(SECRET_LENGTH_RECOMMENDED, "R"); // 32 — silent
const DEPRECATED = secretOf(20, "D"); // 16–31 — warns
const TOO_SHORT = secretOf(MIN_SECRET_LENGTH_HARD - 1, "X"); // 15 — rejected

describe("kms/limits — the constants (SF3.2)", () => {
  it("keeps the hard floor at 16 and recommends 32", () => {
    expect(MIN_SECRET_LENGTH_HARD).toBe(16);
    expect(SECRET_LENGTH_RECOMMENDED).toBe(32);
  });
});

describe("createStaticKeyProvider — secret length (SF3.3, SF3.5)", () => {
  let emitWarning: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  });
  afterEach(() => emitWarning.mockRestore());

  it("rejects a secret under the hard floor", () => {
    expect(() => createStaticKeyProvider(TOO_SHORT)).toThrow(
      /at least 16 characters/,
    );
    expect(emitWarning).not.toHaveBeenCalled(); // rejected, not merely warned
  });

  it("accepts a >= 32-char secret silently", () => {
    expect(() => createStaticKeyProvider(RECOMMENDED)).not.toThrow();
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("accepts a 16-31 char secret but warns once, as a DeprecationWarning", () => {
    const provider = createStaticKeyProvider(DEPRECATED);
    expect(provider).toBeTruthy(); // still works — warn, don't break

    expect(emitWarning).toHaveBeenCalledTimes(1);
    const [message, options] = emitWarning.mock.calls[0]!;
    expect(options).toMatchObject({
      type: "DeprecationWarning",
      code: SHORT_SECRET_WARNING_CODE,
    });
    expect(String(message)).toMatch(/shorter than 32 characters/);
    expect(String(message)).toMatch(/next major/); // states the timeline
  });

  it("the warning carries NO secret bytes (SF3.4)", () => {
    createStaticKeyProvider(secretOf(20, "D"));
    const message = String(emitWarning.mock.calls[0]![0]);

    expect(message).not.toContain("DD"); // no fragment of the secret
    expect(message).not.toContain(DEPRECATED);
    // Only the length *category* is named — not the measured length itself.
    expect(message).not.toMatch(/\b20\b/);
  });

  it("warns once PER PROVIDER — a second provider warns again", () => {
    createStaticKeyProvider(DEPRECATED);
    createStaticKeyProvider(DEPRECATED);
    expect(emitWarning).toHaveBeenCalledTimes(2);
  });

  it("a >= 32-char secret still signs and verifies (round-trip unaffected)", async () => {
    const provider = createStaticKeyProvider(RECOMMENDED);
    const key = await provider.getPrimaryKey();
    expect(key.secret).toHaveLength(32); // HKDF always yields a 32-byte AEAD key
    expect(await provider.getKey(key.id)).toEqual(key);
  });
});

describe("createLocalKeyProvider — secret length (SF3.3)", () => {
  let emitWarning: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  });
  afterEach(() => emitWarning.mockRestore());

  it("rejects a key under the hard floor", () => {
    expect(() => createLocalKeyProvider([{ id: 1, secret: TOO_SHORT }])).toThrow(
      /at least 16 characters/,
    );
  });

  it("is silent when every key is >= 32", () => {
    createLocalKeyProvider([
      { id: 2, secret: secretOf(40, "A") },
      { id: 1, secret: RECOMMENDED },
    ]);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it("warns once naming the key ids to rotate — and only the short ones", () => {
    createLocalKeyProvider([
      { id: 2, secret: RECOMMENDED }, // fine
      { id: 7, secret: DEPRECATED }, // short
    ]);

    expect(emitWarning).toHaveBeenCalledTimes(1);
    const message = String(emitWarning.mock.calls[0]![0]);
    expect(message).toMatch(/1 of 2 secrets are shorter than 32/);
    expect(message).toMatch(/key id: 7/); // the id an operator must act on
    expect(message).not.toContain(DEPRECATED); // still no secret bytes
  });

  it("names every short key when several are short", () => {
    createLocalKeyProvider([
      { id: 3, secret: DEPRECATED },
      { id: 4, secret: DEPRECATED },
    ]);
    expect(String(emitWarning.mock.calls[0]![0])).toMatch(/key ids: 3, 4/);
  });
});

describe("createCloudKeyProvider — secret length (SF3.3)", () => {
  const logger: KmsLogger = { warn: vi.fn(), error: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("rejects a vault value under the hard floor", async () => {
    const provider = createCloudKeyProvider({
      fetchSecrets: vi.fn().mockResolvedValue([{ versionId: 1, value: TOO_SHORT }]),
      logger,
    });
    await expect(provider.getPrimaryKey()).rejects.toThrow(/at least 16 characters/);
    provider.dispose();
  });

  it("is silent when the vault serves >= 32-char values", async () => {
    const provider = createCloudKeyProvider({
      fetchSecrets: vi.fn().mockResolvedValue([{ versionId: 1, value: RECOMMENDED }]),
      logger,
    });
    await provider.getPrimaryKey();
    expect(logger.warn).not.toHaveBeenCalled();
    provider.dispose();
  });

  it("warns through the provider logger for a short vault value", async () => {
    const provider = createCloudKeyProvider({
      fetchSecrets: vi.fn().mockResolvedValue([{ versionId: 5, value: DEPRECATED }]),
      logger,
    });
    await provider.getPrimaryKey();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(message).toMatch(/Cloud KMS/);
    expect(message).toMatch(/shorter than 32 characters/);
    expect(message).toMatch(/key id: 5/);
    expect(message).not.toContain(DEPRECATED); // no secret bytes

    provider.dispose();
  });

  it("warns ONCE per provider, not once per poll (SF3.3)", async () => {
    // The cloud provider re-validates the vault response on every refresh — the
    // one place a naive per-parse warning would repeat forever.
    const fetchSecrets = vi.fn().mockResolvedValue([{ versionId: 1, value: DEPRECATED }]);
    const provider = createCloudKeyProvider({ fetchSecrets, logger, pollIntervalMs: 1_000 });

    await provider.getPrimaryKey();
    await provider.refreshNow();
    await vi.advanceTimersByTimeAsync(3_500); // several poll cycles

    expect(fetchSecrets.mock.calls.length).toBeGreaterThan(2); // it really re-validated
    expect(logger.warn).toHaveBeenCalledTimes(1); // …and still warned once

    provider.dispose();
  });
});
