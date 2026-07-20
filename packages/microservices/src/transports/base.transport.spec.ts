import { describe, it, expect, vi } from "vitest";
import {
  BaseTransport,
  type BaseTransportOptions,
  type ConnectionState,
  loadOptionalDep,
  parseTransportOptions,
} from "./base.transport";
import { z } from "zod";

// A concrete BaseTransport for exercising the shared lifecycle without a broker.
class FakeTransport extends BaseTransport {
  public openCalls = 0;
  public teardownCalls = 0;
  /** Fail `openConnection` while `openCalls <= failUntil`. */
  public failUntil = 0;

  constructor(opts: BaseTransportOptions = {}) {
    super("Fake", { logger: { log() {}, warn() {}, error() {} }, ...opts });
  }

  protected async openConnection(): Promise<void> {
    this.openCalls += 1;
    if (this.openCalls <= this.failUntil) throw new Error("open failed");
  }

  protected async teardown(): Promise<void> {
    this.teardownCalls += 1;
  }

  // Expose protected surface for testing.
  public drop(err?: unknown): void {
    this.handleDisconnect(err);
  }
  public track<T>(p: Promise<T>): Promise<T> {
    return this.trackInflight(p);
  }
  public delay(attempt: number): number {
    return this.backoffDelay(attempt);
  }
  public get state_(): ConnectionState {
    return this.connectionState;
  }
}

const instantSleep = { sleep: async () => {} };

describe("BaseTransport — backoff policy (exp + equal jitter)", () => {
  it("with zero jitter returns the lower bound d/2", () => {
    const t = new FakeTransport({
      random: () => 0,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    expect(t.delay(1)).toBe(50); // ceiling 100 → half 50
    expect(t.delay(2)).toBe(100); // ceiling 200 → half 100
    expect(t.delay(3)).toBe(200); // ceiling 400 → half 200
    expect(t.delay(5)).toBe(500); // ceiling capped at 1000 → half 500
  });

  it("keeps the jittered delay within [d/2, d]", () => {
    const t = new FakeTransport({
      random: () => 0.999,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    for (const attempt of [1, 2, 3, 4, 5]) {
      const ceiling = Math.min(1000, 100 * 2 ** (attempt - 1));
      const d = t.delay(attempt);
      expect(d).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
      expect(d).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe("BaseTransport — connect", () => {
  it("connects on the first try", async () => {
    const t = new FakeTransport(instantSleep);
    await t.connect();
    expect(t.openCalls).toBe(1);
    expect(t.state_).toBe("connected");
  });

  it("retries with backoff until it succeeds", async () => {
    const sleeps: number[] = [];
    const t = new FakeTransport({
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    t.failUntil = 2; // opens 1 & 2 fail, 3 succeeds
    await t.connect();
    expect(t.openCalls).toBe(3);
    expect(t.state_).toBe("connected");
    expect(sleeps).toEqual([50, 100]);
  });

  it("gives up after maxRetries and lands back in idle", async () => {
    const t = new FakeTransport({
      ...instantSleep,
      reconnect: { maxRetries: 2, initialDelayMs: 1 },
    });
    t.failUntil = Number.POSITIVE_INFINITY;
    await expect(t.connect()).rejects.toThrow(/connect failed after 2 retries/);
    expect(t.openCalls).toBe(3); // 1 initial + 2 retries
    expect(t.state_).toBe("idle");
  });

  it("is idempotent when already connected", async () => {
    const t = new FakeTransport(instantSleep);
    await t.connect();
    await t.connect();
    expect(t.openCalls).toBe(1);
  });
});

describe("BaseTransport — reconnect after an unexpected drop", () => {
  it("re-establishes the connection with backoff", async () => {
    const sleeps: number[] = [];
    const t = new FakeTransport({
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    await t.connect(); // openCalls = 1, connected

    // Next two reopen attempts fail, third succeeds.
    t.failUntil = t.openCalls + 2;
    t.drop(new Error("connection reset"));

    await vi.waitFor(() => expect(t.state_).toBe("connected"));
    expect(t.openCalls).toBe(4); // 1 + (2 failed + 1 ok)
    expect(sleeps).toEqual([50, 100]);
  });

  it("ignores drops while closing", async () => {
    const t = new FakeTransport(instantSleep);
    await t.connect();
    const closing = t.close();
    t.drop(); // must not trigger a reconnect
    await closing;
    expect(t.state_).toBe("closed");
    expect(t.openCalls).toBe(1);
  });
});

describe("BaseTransport — graceful close drains then tears down", () => {
  it("waits for in-flight operations before teardown", async () => {
    const t = new FakeTransport(instantSleep);
    await t.connect();

    let resolveOp!: () => void;
    t.track(new Promise<void>((res) => (resolveOp = res)));

    let closed = false;
    const closing = t.close().then(() => {
      closed = true;
    });

    // Parked on drain: not torn down yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(t.teardownCalls).toBe(0);
    expect(closed).toBe(false);

    resolveOp();
    await closing;
    expect(t.teardownCalls).toBe(1);
    expect(t.state_).toBe("closed");
  });

  it("bounds the drain by drainTimeoutMs and still closes", async () => {
    const t = new FakeTransport({ ...instantSleep, drainTimeoutMs: 20 });
    await t.connect();
    t.track(new Promise<void>(() => {})); // never settles
    await t.close();
    expect(t.teardownCalls).toBe(1);
    expect(t.state_).toBe("closed");
  });

  it("is idempotent", async () => {
    const t = new FakeTransport(instantSleep);
    await t.connect();
    await t.close();
    await t.close();
    expect(t.teardownCalls).toBe(1);
  });

  it("closes cleanly even if never connected", async () => {
    const t = new FakeTransport(instantSleep);
    await t.close();
    expect(t.teardownCalls).toBe(1);
    expect(t.state_).toBe("closed");
  });
});

describe("loadOptionalDep", () => {
  it("throws a clear, actionable error when the dep is missing", async () => {
    await expect(
      loadOptionalDep("nonexistent-broker-xyz-123", "redis"),
    ).rejects.toThrow(/optional peer dependency "nonexistent-broker-xyz-123"/);
  });

  it("loads an installed module", async () => {
    const mod = await loadOptionalDep<typeof import("node:path")>("node:path", "x");
    expect(typeof mod.join).toBe("function");
  });
});

describe("parseTransportOptions", () => {
  it("returns validated options", () => {
    const schema = z.object({ host: z.string() });
    expect(parseTransportOptions("X", schema, { host: "h" })).toEqual({ host: "h" });
  });

  it("throws a prefixed error on bad options", () => {
    const schema = z.object({ host: z.string() });
    expect(() => parseTransportOptions("X", schema, { host: 1 })).toThrow(/X: invalid options/);
  });
});
