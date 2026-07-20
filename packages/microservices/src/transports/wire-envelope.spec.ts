// ──────────────────────────────────────────────────────────────────────────
// Discriminated wire envelope (Sprint SF2 — audit finding L2).
//
// The finding: redis + memory classified an inbound message as an RPC request
// with the structural sniff `"replyTo" in parsed`, and `emit()` published the raw
// payload — so a fire-and-forget event whose data carried a `replyTo` field was
// served as an RPC and its handler's output published to that payload-chosen
// channel. These specs assert the exploit is dead on both confusable transports
// (via a real round-trip on memory, a mocked broker on redis) and that normal RPC
// still round-trips everywhere, incl. the legacy-accept migration window.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from "vitest";

// ── Minimal ioredis mock: an in-process pub/sub hub shared by every FakeRedis,
// so a client and a server instance talk to each other (mirrors the mock in
// `redis.security.spec.ts`).
const hub = vi.hoisted(() => {
  type Listener = (channel: string, message: string) => void;
  const subs = new Map<string, Set<FakeRedis>>();

  class FakeRedis {
    private readonly listeners = new Set<Listener>();
    private readonly channels = new Set<string>();

    on(event: string, listener: Listener): this {
      if (event === "message") this.listeners.add(listener);
      return this;
    }
    async connect(): Promise<void> {}
    async quit(): Promise<void> {
      for (const channel of this.channels) subs.get(channel)?.delete(this);
      this.channels.clear();
    }
    async subscribe(...channels: string[]): Promise<number> {
      for (const channel of channels) {
        this.channels.add(channel);
        const set = subs.get(channel) ?? new Set<FakeRedis>();
        set.add(this);
        subs.set(channel, set);
      }
      return channels.length;
    }
    async publish(channel: string, message: string): Promise<number> {
      const set = subs.get(channel);
      if (!set) return 0;
      for (const client of [...set]) {
        for (const listener of [...client.listeners]) {
          queueMicrotask(() => listener(channel, message));
        }
      }
      return set.size;
    }
  }

  return { FakeRedis, reset: () => subs.clear() };
});

vi.mock("ioredis", () => ({ default: hub.FakeRedis, Redis: hub.FakeRedis }));

import { InvalidMessageError } from "../errors";
import { RedisTransport } from "./redis.transport";
import { InMemoryTransport, MemoryBus, createInMemoryPair } from "./memory.transport";
import type { RawMessageHandler } from "./transport.interface";
import { RpcContext } from "../server/rpc-context";
import { parseWire, wrapEvent, wrapRpc, WIRE_EVENT, WIRE_RPC } from "./wire-envelope";

const silent = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setTimeout(r, 5));
const redisOpts = () => ({ host: "localhost", port: 6379, logger: silent });

/** Collects every message published to `channel` on `bus`. */
function collect(bus: MemoryBus, channel: string): string[] {
  const seen: string[] = [];
  bus.subscribe(channel, (m) => seen.push(m));
  return seen;
}

/** Collects every message published to `channel` on the redis hub. */
function collectRedis(channel: string): string[] {
  const seen: string[] = [];
  const spy = new hub.FakeRedis();
  spy.on("message", (c: string, m: string) => {
    if (c === channel) seen.push(m);
  });
  void spy.subscribe(channel);
  return seen;
}

describe("wire-envelope — wrap/parse (SF2.1)", () => {
  it("wraps an event with the payload one level down, so its fields cannot be metadata", () => {
    expect(wrapEvent({ replyTo: "attacker" })).toEqual({ k: "evt", d: { replyTo: "attacker" } });
  });

  it("wraps an RPC request with its reply metadata, omitting absent fields", () => {
    expect(wrapRpc({ n: 1 }, { replyTo: "inbox", correlationId: "cid" })).toEqual({
      k: "rpc",
      d: { n: 1 },
      r: "inbox",
      c: "cid",
    });
    expect(wrapRpc({ n: 1 })).toEqual({ k: "rpc", d: { n: 1 } }); // RMQ: metadata rides the AMQP props
  });

  it("round-trips both kinds", () => {
    expect(parseWire(JSON.stringify(wrapEvent({ a: 1 })))).toEqual({ k: WIRE_EVENT, d: { a: 1 } });
    expect(parseWire(JSON.stringify(wrapRpc({ a: 1 }, { replyTo: "i", correlationId: "c" })))).toEqual({
      k: WIRE_RPC,
      d: { a: 1 },
      r: "i",
      c: "c",
      h: undefined,
    });
  });

  it("rejects a missing `k` as a permanent, payload-free InvalidMessageError", () => {
    const err = (() => {
      try {
        parseWire(JSON.stringify({ secretField: "SECRET" }));
        return null;
      } catch (e) {
        return e as InvalidMessageError;
      }
    })();

    expect(err).toBeInstanceOf(InvalidMessageError);
    expect(err!.code).toBe("invalid_envelope");
    expect(err!.retryable).toBe(false); // permanent → dead-letter, never retry
    expect(err!.message).not.toContain("SECRET"); // no payload bytes in the error
  });

  it("rejects an unrecognized `k` without echoing it back", () => {
    const err = (() => {
      try {
        parseWire(JSON.stringify({ k: "EVIL-KIND", d: 1 }), true);
        return null;
      } catch (e) {
        return e as InvalidMessageError;
      }
    })();

    expect(err!.code).toBe("invalid_envelope");
    expect(err!.message).not.toContain("EVIL-KIND"); // attacker-controlled: never logged back
  });

  it("rejects non-JSON bytes", () => {
    expect(() => parseWire("not json{", true)).toThrow(InvalidMessageError);
  });

  it("keeps only string-valued headers", () => {
    const parsed = parseWire(JSON.stringify({ k: "rpc", d: 1, h: { ok: "yes", nested: { x: 1 } } }));
    expect(parsed).toMatchObject({ h: { ok: "yes" } });
  });

  it("ignores a non-string replyTo rather than trusting it", () => {
    expect(parseWire(JSON.stringify({ k: "rpc", d: 1, r: { evil: true } }))).toMatchObject({ r: undefined });
  });

  describe("legacy window (SF2.5)", () => {
    it("classifies a legacy raw payload as an event", () => {
      expect(parseWire(JSON.stringify({ userId: "u1" }), true)).toEqual({ k: WIRE_EVENT, d: { userId: "u1" } });
    });

    it("classifies a legacy RPC request via the old heuristic", () => {
      const legacy = { data: { n: 1 }, replyTo: "inbox", correlationId: "cid", headers: { a: "b" } };
      expect(parseWire(JSON.stringify(legacy), true)).toEqual({
        k: WIRE_RPC,
        d: { n: 1 },
        r: "inbox",
        c: "cid",
        h: { a: "b" },
      });
    });

    it("handles a legacy scalar payload", () => {
      expect(parseWire("42", true)).toEqual({ k: WIRE_EVENT, d: 42 });
    });

    it("rejects legacy bytes when the window is closed", () => {
      expect(() => parseWire(JSON.stringify({ userId: "u1" }), false)).toThrow(/not a discriminated wire envelope/);
    });

    it("a new-format envelope is read identically with the window open or closed", () => {
      const wire = JSON.stringify(wrapEvent({ replyTo: "attacker" }));
      expect(parseWire(wire, true)).toEqual(parseWire(wire, false));
    });
  });
});

describe("InMemoryTransport — emit() payload with a replyTo field is an EVENT (SF2.6, audit L2)", () => {
  it("runs the handler on the data and publishes NO reply to the payload's channel", async () => {
    const { bus, client, server } = createInMemoryPair({ logger: silent });

    const received: unknown[] = [];
    const contexts: RpcContext[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data, ctx) => {
      received.push(data);
      contexts.push(ctx);
      return { handlerOutput: "must-not-leak" };
    });
    await server.listen(handlers);
    await client.connect();

    // The exploit: a fire-and-forget payload naming an attacker-chosen channel.
    const hijacked = collect(bus, "attacker.channel");
    const payload = { userId: "u1", replyTo: "attacker.channel", correlationId: "cid" };
    await client.emit("jobs", payload);
    await tick();

    // Delivered as an event: the handler sees the payload verbatim…
    expect(received).toEqual([payload]);
    // …with no reply address, so its output has nowhere to go…
    expect(contexts[0]!.replyTo).toBeUndefined();
    // …and nothing was published to the payload-chosen channel.
    expect(hijacked).toEqual([]);

    await client.close();
    await server.close();
  });

  it("an emit() payload cannot forge an envelope either — a nested `k` stays data", async () => {
    const { bus, client, server } = createInMemoryPair({ logger: silent });

    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    const hijacked = collect(bus, "attacker.channel");
    const payload = { k: "rpc", d: { x: 1 }, r: "attacker.channel" };
    await client.emit("jobs", payload);
    await tick();

    // emit() always wraps, so the forged envelope lands under `d` as plain data.
    expect(received).toEqual([payload]);
    expect(hijacked).toEqual([]);

    await client.close();
    await server.close();
  });
});

describe("RedisTransport — emit() payload with a replyTo field is an EVENT (SF2.6, audit L2)", () => {
  it("runs the handler on the data and publishes NO reply to the payload's channel", async () => {
    hub.reset();
    const server = new RedisTransport(redisOpts());
    const client = new RedisTransport(redisOpts());

    const received: unknown[] = [];
    const contexts: RpcContext[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data, ctx) => {
      received.push(data);
      contexts.push(ctx);
      return { handlerOutput: "must-not-leak" };
    });
    await server.listen(handlers);
    await client.connect();

    const hijacked = collectRedis("attacker.channel");
    const payload = { userId: "u1", replyTo: "attacker.channel", correlationId: "cid" };
    await client.emit("jobs", payload);
    await tick();

    expect(received).toEqual([payload]);
    expect(contexts[0]!.replyTo).toBeUndefined();
    expect(hijacked).toEqual([]);

    await client.close();
    await server.close();
  });
});

describe("RPC still round-trips over the new envelope (SF2.6)", () => {
  it("memory: request → reply", async () => {
    const { client, server } = createInMemoryPair({ logger: silent });
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      await server.reply(ctx, { result: (data as { n: number }).n * 2 });
    });
    await server.listen(handlers);
    await client.connect();

    expect(await client.send("math.double", { n: 21 }, { timeoutMs: 500 })).toEqual({ result: 42 });

    await client.close();
    await server.close();
  });

  it("memory: the RPC context carries replyTo + correlation headers from the envelope", async () => {
    const { client, server } = createInMemoryPair({ logger: silent });
    const contexts: RpcContext[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (_data, ctx) => {
      contexts.push(ctx);
      await server.reply(ctx, { ok: true });
    });
    await server.listen(handlers);
    await client.connect();

    await client.send("math.double", { n: 1 }, { timeoutMs: 500, headers: { "x-trace": "t1" } });

    const ctx = contexts[0]!;
    expect(ctx.replyTo).toBeTruthy();
    expect(ctx.correlationId).toBeTruthy();
    expect(ctx.headers["x-trace"]).toBe("t1");

    await client.close();
    await server.close();
  });

  it("redis: request → reply", async () => {
    hub.reset();
    const server = new RedisTransport(redisOpts());
    const client = new RedisTransport(redisOpts());

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      await server.reply(ctx, { result: (data as { n: number }).n * 2 });
    });
    await server.listen(handlers);
    await client.connect();

    expect(await client.send("math.double", { n: 21 }, { timeoutMs: 500 })).toEqual({ result: 42 });

    await client.close();
    await server.close();
  });

  it("cross-transport: a memory client and a memory server on one bus", async () => {
    // Distinct instances sharing a bus — a client and a server as in real usage.
    const bus = new MemoryBus();
    const client = new InMemoryTransport({ bus, logger: silent });
    const server = new InMemoryTransport({ bus, logger: silent });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("echo", async (data, ctx) => {
      await server.reply(ctx, data);
    });
    handlers.set("events", async () => {});
    await server.listen(handlers);
    await client.connect();

    expect(await client.send("echo", { hi: "there" }, { timeoutMs: 500 })).toEqual({ hi: "there" });
    await client.emit("events", { fire: "forget" }); // both kinds over one connection

    await client.close();
    await server.close();
  });
});

describe("Legacy wire window on a live transport (SF2.5, SF2.6)", () => {
  it("accepts a legacy raw emit by default, and still delivers it as an event", async () => {
    const { bus, client, server } = createInMemoryPair({ logger: silent });
    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    // A pre-0.5.0 peer publishes the raw payload, with no envelope.
    bus.publish("jobs", JSON.stringify({ legacy: true }));
    await tick();

    expect(received).toEqual([{ legacy: true }]);

    await client.close();
    await server.close();
  });

  it("accepts a legacy RPC request and replies to it", async () => {
    const bus = new MemoryBus();
    const server = new InMemoryTransport({ bus, logger: silent });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      await server.reply(ctx, { result: (data as { n: number }).n * 2 });
    });
    await server.listen(handlers);

    const replies = collect(bus, "legacy.inbox");
    // A pre-0.5.0 client's RPC request: raw, with a top-level replyTo.
    bus.publish(
      "math.double",
      JSON.stringify({ data: { n: 21 }, replyTo: "legacy.inbox", correlationId: "legacy-cid", headers: {} }),
    );
    await tick();

    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0]!)).toEqual({ correlationId: "legacy-cid", data: { result: 42 } });

    await server.close();
  });

  it("acceptLegacyWire: false dead-letters legacy bytes — the handler never runs", async () => {
    const { bus, client, server } = createInMemoryPair({ logger: silent, acceptLegacyWire: false });
    let handlerRuns = 0;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async () => {
      handlerRuns += 1;
    });
    await server.listen(handlers);
    await client.connect();

    const dlq = collect(bus, "jobs.dlq");
    bus.publish("jobs", JSON.stringify({ legacy: true }));
    await tick();

    expect(handlerRuns).toBe(0);
    expect(dlq).toHaveLength(1);

    await client.close();
    await server.close();
  });

  it("acceptLegacyWire: false fully closes L2 — a legacy sender's replyTo payload cannot redirect a reply", async () => {
    // With the window open, a LEGACY publisher's emit payload carrying `replyTo`
    // is still sniffed as RPC (the finding's original behavior, scoped to legacy
    // senders). Closing the window removes that last path.
    const { bus, client, server } = createInMemoryPair({ logger: silent, acceptLegacyWire: false });
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (_data, ctx) => {
      await server.reply(ctx, { handlerOutput: "must-not-leak" });
    });
    await server.listen(handlers);
    await client.connect();

    const hijacked = collect(bus, "attacker.channel");
    bus.publish("jobs", JSON.stringify({ data: { x: 1 }, replyTo: "attacker.channel", correlationId: "c" }));
    await tick();

    expect(hijacked).toEqual([]);

    await client.close();
    await server.close();
  });

  it("both formats round-trip on one server during the window", async () => {
    const { bus, client, server } = createInMemoryPair({ logger: silent }); // window open (default)
    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    bus.publish("jobs", JSON.stringify({ from: "legacy" })); // legacy peer
    await client.emit("jobs", { from: "new" }); // 0.5.0 peer
    await tick();

    expect(received).toEqual([{ from: "legacy" }, { from: "new" }]);

    await client.close();
    await server.close();
  });
});
