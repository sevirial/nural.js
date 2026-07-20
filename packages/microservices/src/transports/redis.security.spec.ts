import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory ioredis pub/sub mock (a shared hub of channel → subscribers). ──
// `publish` is exposed so a test can inject a raw/forged message onto a channel.
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

import { RedisTransport } from "./redis.transport";
import type { RawMessageHandler } from "./transport.interface";
import { RpcTimeoutError } from "../errors";
import { createSharedSecretSigner } from "../signing";

const silent = { log() {}, warn() {}, error() {} };
const base = () => ({ host: "localhost", port: 6379, logger: silent, rpcTimeoutMs: 2000 });

/** Polls `fn` until it returns a truthy value (or gives up after ~50 ticks). */
async function waitFor<T>(fn: () => T): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2));
  }
  return fn();
}

/** Subscribes a bare mock client to `channel` and resolves with the first message. */
function captureOne(channel: string): Promise<string> {
  return new Promise((resolve) => {
    const spy = new hub.FakeRedis();
    void spy.subscribe(channel).then(() => {
      spy.on("message", (ch, msg) => {
        if (ch === channel) resolve(msg as string);
      });
    });
  });
}

beforeEach(() => hub.reset());

describe("Sprint 10 — Redis reply-channel binding (T10.5)", () => {
  it("a reply carrying a foreign correlation id is NOT delivered to a pending call (it stays bound)", async () => {
    const server = new RedisTransport(base());
    const client = new RedisTransport(base());

    // A handler that never replies, so the call stays pending until its timeout.
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("slow", async () => {
      /* deliberately never replies */
    });
    await server.listen(handlers);
    await client.connect();

    const pending = client.send("slow", {}, { timeoutMs: 200 });

    // Find the client's private reply inbox and inject a forged reply bearing a
    // DIFFERENT correlation id — the reply channel is bound to the caller's own
    // correlation id, so this must not resolve (or hijack) the pending call.
    // (The inbox is subscribed asynchronously inside send(); wait for it.)
    const inbox = await waitFor(() =>
      [...hub.FakeRedis.subs.keys()].find((c) => c.startsWith("nural:reply:")),
    );
    expect(inbox).toBeTruthy();
    const injector = new hub.FakeRedis();
    await injector.publish(
      inbox!,
      JSON.stringify({ correlationId: "some-other-callers-id", data: { hijacked: true } }),
    );

    await expect(pending).rejects.toBeInstanceOf(RpcTimeoutError);

    await client.close();
    await server.close();
  });

  it("each caller consumes only its own reply (concurrent calls do not cross)", async () => {
    const server = new RedisTransport(base());
    const client = new RedisTransport(base());

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("echo", async (data, ctx) => {
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

    await client.close();
    await server.close();
  });
});

describe("Sprint 10 — Redis wire signing (T10.4)", () => {
  const signer = () => createSharedSecretSigner({ secret: "shared-secret" });

  it("a signed client ↔ signed server RPC round-trips normally", async () => {
    const server = new RedisTransport({ ...base(), signer: signer() });
    const client = new RedisTransport({ ...base(), signer: signer() });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      await server.reply(ctx, { result: (data as { n: number }).n * 2 });
    });
    await server.listen(handlers);
    await client.connect();

    expect(await client.send("math.double", { n: 21 })).toEqual({ result: 42 });

    await client.close();
    await server.close();
  });

  it("a signed server REJECTS a forged (unsigned) message — handler never runs, message is dead-lettered", async () => {
    const server = new RedisTransport({ ...base(), signer: signer() });

    let handlerRuns = 0;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("secure.topic", async () => {
      handlerRuns += 1;
    });
    await server.listen(handlers);

    const dlq = captureOne("secure.topic.dlq");

    // An attacker publishes an UNSIGNED (forged) message straight onto the topic.
    const attacker = new hub.FakeRedis();
    await attacker.publish("secure.topic", JSON.stringify({ evil: true }));

    // The forged message is rejected (bad signature) and dead-lettered; it never
    // reaches the handler.
    const deadLettered = await dlq;
    expect(JSON.parse(deadLettered)).toEqual({ evil: true });
    expect(handlerRuns).toBe(0);

    await server.close();
  });

  it("a signed server REJECTS a message signed with the WRONG secret", async () => {
    const server = new RedisTransport({ ...base(), signer: createSharedSecretSigner({ secret: "real" }) });

    let handlerRuns = 0;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("secure.topic", async () => {
      handlerRuns += 1;
    });
    await server.listen(handlers);

    const dlq = captureOne("secure.topic.dlq");

    // Signed with a different secret → a forgery from the server's perspective.
    const forged = createSharedSecretSigner({ secret: "attacker" }).sign(JSON.stringify({ evil: true }));
    const attacker = new hub.FakeRedis();
    await attacker.publish("secure.topic", forged);

    await dlq; // resolves only if the message was dead-lettered
    expect(handlerRuns).toBe(0);

    await server.close();
  });
});

describe("Sprint SF1 — Redis inbound message-size cap (L4)", () => {
  it("dead-letters an oversize message before parsing it — handler never runs", async () => {
    const server = new RedisTransport({ ...base(), maxMessageBytes: 200 });

    let handlerRuns = 0;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async () => {
      handlerRuns += 1;
    });
    await server.listen(handlers);

    const dlq = captureOne("jobs.dlq");

    const attacker = new hub.FakeRedis();
    await attacker.publish("jobs", JSON.stringify({ blob: "x".repeat(1000) }));

    await dlq; // resolves only if the oversize message was dead-lettered
    expect(handlerRuns).toBe(0);

    await server.close();
  });

  it("delivers a message under the cap normally", async () => {
    const server = new RedisTransport({ ...base(), maxMessageBytes: 1000 });

    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);

    const client = new RedisTransport(base());
    await client.connect();
    await client.emit("jobs", { ok: true });

    await waitFor(() => received.length > 0);
    expect(received).toEqual([{ ok: true }]);

    await client.close();
    await server.close();
  });
});
