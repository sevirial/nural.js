import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory ioredis pub/sub mock: a shared hub of channel → subscribers. ──
const hub = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class FakeRedis {
    private readonly listeners = new Map<string, Listener[]>();
    private readonly channels = new Set<string>();

    // Every FakeRedis instance shares the module-level subscription registry.
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
      for (const client of set) {
        void Promise.resolve().then(() => client.emit("message", channel, message));
      }
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

import { RedisTransport } from "./redis.transport";
import type { RawMessageHandler } from "./transport.interface";
import type { RpcContext } from "../server/rpc-context";
import { RpcTimeoutError } from "../errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const silent = { log() {}, warn() {}, error() {} };
const opts = () => ({ host: "localhost", port: 6379, logger: silent });

beforeEach(() => hub.reset());

describe("Redis RPC — request/reply over a pooled inbox + correlationId", () => {
  it("round-trips a request and resolves with the reply, UUID correlation in ctx", async () => {
    const server = new RedisTransport(opts());
    const client = new RedisTransport(opts());

    let seen: RpcContext | undefined;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      seen = ctx;
      const n = (data as { n: number }).n;
      await server.reply(ctx, { result: n * 2 });
    });

    await server.listen(handlers);
    await client.connect();

    const res = await client.send("math.double", { n: 21 }, { headers: { traceparent: "tp-xyz" } });
    expect(res).toEqual({ result: 42 });

    expect(seen?.correlationId).toMatch(UUID_RE);
    expect(seen?.headers["x-correlation-id"]).toBe(seen?.correlationId);
    expect(seen?.headers["traceparent"]).toBe("tp-xyz");

    await client.close();
    await server.close();
  });

  it("each concurrent call gets its own correlation id and correct reply", async () => {
    const server = new RedisTransport(opts());
    const client = new RedisTransport(opts());
    const ids = new Set<string>();

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("echo", async (data, ctx) => {
      if (ctx.correlationId) ids.add(ctx.correlationId);
      await server.reply(ctx, data);
    });
    await server.listen(handlers);
    await client.connect();

    const results = await Promise.all([
      client.send("echo", { i: 1 }),
      client.send("echo", { i: 2 }),
      client.send("echo", { i: 3 }),
    ]);
    expect(results).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    expect(ids.size).toBe(3); // three distinct correlation ids

    await client.close();
    await server.close();
  });

  it("times out with a typed RpcTimeoutError when no reply arrives", async () => {
    const server = new RedisTransport(opts());
    const client = new RedisTransport(opts());

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("silent", async () => {
      /* never replies */
    });
    await server.listen(handlers);
    await client.connect();

    await expect(client.send("silent", {}, { timeoutMs: 40 })).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );

    await client.close();
    await server.close();
  });
});
