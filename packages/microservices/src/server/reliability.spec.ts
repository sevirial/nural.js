import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

// ── In-memory ioredis pub/sub mock (shared hub of channel → subscribers). ──
// Same shape as redis.rpc.spec's mock; the full RpcClient + MicroserviceBuilder
// stack drives real Redis transports over it.
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

import { RedisTransport } from "../transports/redis.transport";
import { createMicroservice } from "./microservice.builder";
import { createRpcClient } from "../client/rpc-client";
import { defineContract } from "../contracts/contract-builder";
import { RpcRemoteError, RpcTimeoutError } from "../errors";
import { MemoryIdempotencyStore } from "../idempotency";

const silent = { log() {}, warn() {}, error() {} };
// A modest RPC timeout so a *regression* (a lost error → timeout) fails fast and
// distinctly rather than hanging the whole suite.
const opts = () => ({ host: "localhost", port: 6379, logger: silent, rpcTimeoutMs: 2000 });

const doubler = defineContract({
  topic: "math.double",
  request: z.object({ n: z.number() }),
  response: z.object({ result: z.number() }),
});

beforeEach(() => hub.reset());

describe("Sprint 9 — RPC error envelope: a failing handler returns a typed error, not a timeout", () => {
  it("a throwing handler rejects the caller with RpcRemoteError (code handler_error)", async () => {
    const service = createMicroservice({ transport: new RedisTransport(opts()) }).handler(
      doubler,
      async () => {
        throw new Error("boom");
      },
    );
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    const err = await client.send(doubler, { n: 21 }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err).not.toBeInstanceOf(RpcTimeoutError); // proves it is NOT a timeout
    expect((err as RpcRemoteError).remoteCode).toBe("handler_error");
    // The raw message is redacted by default — an arbitrary throw can carry
    // internal detail/secrets. The stable code still crosses.
    expect((err as RpcRemoteError).message).toBe("Internal handler error");
    expect((err as RpcRemoteError).message).not.toContain("boom");

    await client.close();
    await service.close();
  });

  it("forwards the raw handler message only when exposeErrorMessages is enabled", async () => {
    const service = createMicroservice({
      transport: new RedisTransport(opts()),
      exposeErrorMessages: true,
    }).handler(doubler, async () => {
      throw new Error("boom");
    });
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    const err = (await client.send(doubler, { n: 21 }).catch((e) => e)) as RpcRemoteError;
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err.remoteCode).toBe("handler_error");
    expect(err.message).toBe("boom");

    await client.close();
    await service.close();
  });

  it("a handler error carrying a stable `code` propagates that code as remoteCode", async () => {
    const service = createMicroservice({ transport: new RedisTransport(opts()) }).handler(
      doubler,
      async () => {
        throw Object.assign(new Error("nope"), { code: "quota_exceeded" });
      },
    );
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    const err = (await client.send(doubler, { n: 1 }).catch((e) => e)) as RpcRemoteError;
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err.remoteCode).toBe("quota_exceeded");

    await client.close();
    await service.close();
  });

  it("a contract-invalid response is rejected by the server (code invalid_response)", async () => {
    const service = createMicroservice({ transport: new RedisTransport(opts()) }).handler(
      doubler,
      // Handler returns the wrong shape — must never reach the caller as data.
      async () => ({ result: "not-a-number" }) as unknown as { result: number },
    );
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    const err = (await client.send(doubler, { n: 2 }).catch((e) => e)) as RpcRemoteError;
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err.remoteCode).toBe("invalid_response");

    await client.close();
    await service.close();
  });

  it("a successful call still round-trips normally (envelope is transparent)", async () => {
    const service = createMicroservice({ transport: new RedisTransport(opts()) }).handler(
      doubler,
      async ({ request }) => ({ result: request.n * 2 }),
    );
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    expect(await client.send(doubler, { n: 21 })).toEqual({ result: 42 });

    await client.close();
    await service.close();
  });
});

describe("Sprint 9 — idempotency: a duplicate key replays the outcome without re-running the handler", () => {
  it("two sends with the same idempotency key run the handler once and return the same reply", async () => {
    let calls = 0;
    const service = createMicroservice({
      transport: new RedisTransport(opts()),
      idempotency: new MemoryIdempotencyStore(),
    }).handler(doubler, async ({ request }) => {
      calls += 1;
      return { result: request.n * 2 };
    });
    await service.listen();

    const client = createRpcClient({ transport: new RedisTransport(opts()) });
    await client.connect();

    const first = await client.send(doubler, { n: 21 }, { idempotencyKey: "dup-key" });
    const second = await client.send(doubler, { n: 21 }, { idempotencyKey: "dup-key" });

    expect(first).toEqual({ result: 42 });
    expect(second).toEqual({ result: 42 });
    expect(calls).toBe(1); // handler ran once; the duplicate was replayed from the store

    await client.close();
    await service.close();
  });
});
