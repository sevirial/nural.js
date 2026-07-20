import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

// ── In-memory ioredis pub/sub mock (same hub used by the reliability specs). ──
const hub = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeRedis {
    private readonly listeners = new Map<string, Listener[]>();
    private readonly channels = new Set<string>();
    static subs = new Map<string, Set<FakeRedis>>();

    constructor(_options?: unknown) {}

    on(event: string, cb: Listener): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners.get(event) ?? []) cb(...args);
    }
    async connect(): Promise<void> {}
    async subscribe(...channels: string[]): Promise<number> {
      for (const ch of channels) {
        this.channels.add(ch);
        const set = FakeRedis.subs.get(ch) ?? new Set<FakeRedis>();
        set.add(this);
        FakeRedis.subs.set(ch, set);
      }
      return channels.length;
    }
    async unsubscribe(ch: string): Promise<void> {
      this.channels.delete(ch);
      FakeRedis.subs.get(ch)?.delete(this);
    }
    async publish(channel: string, message: string): Promise<number> {
      const set = FakeRedis.subs.get(channel);
      if (!set) return 0;
      for (const client of set) void Promise.resolve().then(() => client.emit("message", channel, message));
      return set.size;
    }
    async quit(): Promise<"OK"> {
      for (const ch of this.channels) FakeRedis.subs.get(ch)?.delete(this);
      this.channels.clear();
      return "OK";
    }
  }

  return { FakeRedis, reset: () => FakeRedis.subs.clear() };
});

vi.mock("ioredis", () => ({ default: hub.FakeRedis, Redis: hub.FakeRedis }));

import { RedisTransport } from "./transports/redis.transport";
import { createMicroservice } from "./server/microservice.builder";
import { createRpcClient } from "./client/rpc-client";
import { defineContract } from "./contracts/contract-builder";
import { NoopTelemetry, TELEMETRY_NAMES, type Span, type SpanKind, type Telemetry } from "./telemetry";
import type { RpcContext } from "./server/rpc-context";

const silent = { log() {}, warn() {}, error() {} };
const opts = () => ({ host: "localhost", port: 6379, logger: silent, rpcTimeoutMs: 2000 });

const doubler = defineContract({
  topic: "math.double",
  request: z.object({ n: z.number() }),
  response: z.object({ result: z.number() }),
});

/** A telemetry sink that records every call so a test can assert on it. */
class RecordingTelemetry implements Telemetry {
  spans: { name: string; kind: SpanKind; ended: boolean; errored: boolean }[] = [];
  latencies: { name: string; ms: number }[] = [];
  inflight: { name: string; delta: number }[] = [];
  counters: { name: string; attributes?: Record<string, string> }[] = [];
  /** If set, a `client`-kind span injects this into the carrier (simulates trace injection). */
  constructor(private readonly injectTrace?: { key: string; value: string }) {}

  startSpan(name: string, kind: SpanKind, carrier: Record<string, string>): Span {
    const rec = { name, kind, ended: false, errored: false };
    this.spans.push(rec);
    if (kind === "client" && this.injectTrace) carrier[this.injectTrace.key] = this.injectTrace.value;
    return {
      setError: () => {
        rec.errored = true;
      },
      end: () => {
        rec.ended = true;
      },
    };
  }
  recordLatency(name: string, ms: number): void {
    this.latencies.push({ name, ms });
  }
  recordInFlight(name: string, delta: number): void {
    this.inflight.push({ name, delta });
  }
  incrementCounter(name: string, attributes?: Record<string, string>): void {
    this.counters.push({ name, attributes });
  }
}

beforeEach(() => hub.reset());

describe("Sprint 10 — telemetry fires when configured (T10.2)", () => {
  it("a successful RPC records client + server spans, latency, and in-flight on both sides", async () => {
    const serverTel = new RecordingTelemetry();
    const clientTel = new RecordingTelemetry();

    const service = createMicroservice({
      transport: new RedisTransport(opts()),
      telemetry: serverTel,
    }).handler(doubler, async ({ request }) => ({ result: request.n * 2 }));
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()), telemetry: clientTel });
    await client.connect();

    expect(await client.send(doubler, { n: 21 })).toEqual({ result: 42 });

    // Client side.
    const clientSpan = clientTel.spans.find((s) => s.name === TELEMETRY_NAMES.clientSpan);
    expect(clientSpan).toMatchObject({ kind: "client", ended: true, errored: false });
    expect(clientTel.latencies.some((l) => l.name === TELEMETRY_NAMES.clientLatency)).toBe(true);
    expect(clientTel.inflight.filter((i) => i.name === TELEMETRY_NAMES.clientInFlight)).toEqual([
      { name: TELEMETRY_NAMES.clientInFlight, delta: 1 },
      { name: TELEMETRY_NAMES.clientInFlight, delta: -1 },
    ]);
    expect(clientTel.counters.some((c) => c.name === TELEMETRY_NAMES.clientErrors)).toBe(false);

    // Server side.
    const serverSpan = serverTel.spans.find((s) => s.name === TELEMETRY_NAMES.serverSpan);
    expect(serverSpan).toMatchObject({ kind: "server", ended: true, errored: false });
    expect(serverTel.latencies.some((l) => l.name === TELEMETRY_NAMES.serverLatency)).toBe(true);
    expect(serverTel.inflight.filter((i) => i.name === TELEMETRY_NAMES.serverInFlight)).toEqual([
      { name: TELEMETRY_NAMES.serverInFlight, delta: 1 },
      { name: TELEMETRY_NAMES.serverInFlight, delta: -1 },
    ]);

    await client.close();
    await service.close();
  });

  it("trace context injected by the client span propagates on the wire to the server (T10.3)", async () => {
    const clientTel = new RecordingTelemetry({ key: "traceparent", value: "00-abc-def-01" });
    let seen: RpcContext | undefined;

    const service = createMicroservice({ transport: new RedisTransport(opts()) }).handler(
      doubler,
      async ({ request, context }) => {
        seen = context;
        return { result: request.n * 2 };
      },
    );
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()), telemetry: clientTel });
    await client.connect();
    await client.send(doubler, { n: 1 });

    // The header the client telemetry injected into the carrier reached the server ctx.
    expect(seen?.headers["traceparent"]).toBe("00-abc-def-01");

    await client.close();
    await service.close();
  });

  it("a throwing handler records an error span + error counters on both sides", async () => {
    const serverTel = new RecordingTelemetry();
    const clientTel = new RecordingTelemetry();

    const service = createMicroservice({
      transport: new RedisTransport(opts()),
      telemetry: serverTel,
    }).handler(doubler, async () => {
      throw new Error("boom");
    });
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()), telemetry: clientTel });
    await client.connect();

    await client.send(doubler, { n: 2 }).catch(() => undefined);

    expect(serverTel.spans.find((s) => s.name === TELEMETRY_NAMES.serverSpan)?.errored).toBe(true);
    expect(
      serverTel.counters.find((c) => c.name === TELEMETRY_NAMES.serverErrors)?.attributes?.["reason"],
    ).toBe("handler_error");
    expect(clientTel.spans.find((s) => s.name === TELEMETRY_NAMES.clientSpan)?.errored).toBe(true);
    expect(clientTel.counters.some((c) => c.name === TELEMETRY_NAMES.clientErrors)).toBe(true);

    await client.close();
    await service.close();
  });
});

describe("Sprint 10 — telemetry no-ops by default (T10.2)", () => {
  it("a client/server with no telemetry configured round-trips normally (NoopTelemetry)", async () => {
    const service = createMicroservice({ transport: new RedisTransport(opts()) }).handler(
      doubler,
      async ({ request }) => ({ result: request.n * 2 }),
    );
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    expect(await client.send(doubler, { n: 4 })).toEqual({ result: 8 });

    await client.close();
    await service.close();
  });

  it("NoopTelemetry methods never throw and return a safe span", () => {
    const t: Telemetry = new NoopTelemetry();
    const span = t.startSpan("x", "client", {});
    expect(() => {
      span.setError(new Error("ignored"));
      span.end();
      t.recordLatency("x", 5);
      t.recordInFlight("x", 1);
      t.incrementCounter("x");
    }).not.toThrow();
  });
});
