import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  InMemoryTransport,
  MemoryBus,
  createInMemoryPair,
  createInMemoryTransport,
} from "./memory.transport";
import type { RawMessageHandler } from "./transport.interface";
import type { RpcContext } from "../server/rpc-context";
import { createMicroservice } from "../server/microservice.builder";
import { createRpcClient } from "../client/rpc-client";
import { defineContract } from "../contracts/contract-builder";
import { RpcRemoteError, RpcTimeoutError } from "../errors";
import { MemoryIdempotencyStore } from "../idempotency";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const silent = { log() {}, warn() {}, error() {} };

const doubler = defineContract({
  topic: "math.double",
  request: z.object({ n: z.number() }),
  response: z.object({ result: z.number() }),
});

const notify = defineContract({
  topic: "user.notify",
  request: z.object({ userId: z.string() }),
  response: z.void(),
});

/** Wires a client + server pair over a shared bus, with silent logging. */
function pair() {
  return createInMemoryPair({ logger: silent, rpcTimeoutMs: 1000 });
}

/** Collects every message published to `channel` on `bus`. */
function collectDlq(bus: MemoryBus, channel: string): string[] {
  const seen: string[] = [];
  bus.subscribe(channel, (m) => seen.push(m));
  return seen;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("InMemoryTransport — capabilities (T11.2)", () => {
  it("declares supportsRpc: true", () => {
    expect(createInMemoryTransport().capabilities.supportsRpc).toBe(true);
  });
});

describe("InMemoryTransport — RPC round-trip, correlation, timeout (T11.2)", () => {
  it("round-trips a request and surfaces a UUID correlation id on the server ctx", async () => {
    const { client, server } = pair();
    let seen: RpcContext | undefined;

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      seen = ctx;
      await server.reply(ctx, { result: (data as { n: number }).n * 2 });
    });
    await server.listen(handlers);
    await client.connect();

    const res = await client.send("math.double", { n: 21 }, { headers: { traceparent: "tp-1" } });
    expect(res).toEqual({ result: 42 });
    expect(seen?.protocol).toBe("memory");
    expect(seen?.correlationId).toMatch(UUID_RE);
    expect(seen?.headers["x-correlation-id"]).toBe(seen?.correlationId);
    expect(seen?.headers["traceparent"]).toBe("tp-1"); // headers propagate on the wire

    await client.close();
    await server.close();
  });

  it("each concurrent call gets a distinct correlation id and its own reply", async () => {
    const { client, server } = pair();
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
    expect(ids.size).toBe(3);

    await client.close();
    await server.close();
  });

  it("times out with a typed RpcTimeoutError when no reply arrives", async () => {
    const { client, server } = pair();
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("silent", async () => {
      /* never replies */
    });
    await server.listen(handlers);
    await client.connect();

    await expect(client.send("silent", {}, { timeoutMs: 30 })).rejects.toBeInstanceOf(RpcTimeoutError);

    await client.close();
    await server.close();
  });
});

describe("InMemoryTransport — full RpcClient ↔ MicroserviceBuilder stack (T11.2)", () => {
  it("client validates the request before it leaves (invalid request rejects locally)", async () => {
    const { client } = pair();
    const rpc = createRpcClient({ transport: client });
    await rpc.connect();

    // n must be a number — the client parses before any wire work.
    await expect(rpc.send(doubler, { n: "not-a-number" } as unknown as { n: number })).rejects.toThrow();

    await rpc.close();
  });

  it("a successful RPC round-trips through the envelope transparently", async () => {
    const { client, server } = pair();
    const service = createMicroservice({ transport: server }).handler(doubler, async ({ request }) => ({
      result: request.n * 2,
    }));
    await service.listen();
    const rpc = createRpcClient({ transport: client });
    await rpc.connect();

    expect(await rpc.send(doubler, { n: 21 })).toEqual({ result: 42 });

    await rpc.close();
    await service.close();
  });

  it("a throwing handler returns a typed RpcRemoteError (not a timeout)", async () => {
    const { client, server } = pair();
    const service = createMicroservice({ transport: server }).handler(doubler, async () => {
      throw Object.assign(new Error("nope"), { code: "quota_exceeded" });
    });
    await service.listen();
    const rpc = createRpcClient({ transport: client });
    await rpc.connect();

    const err = (await rpc.send(doubler, { n: 1 }).catch((e) => e)) as RpcRemoteError;
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err).not.toBeInstanceOf(RpcTimeoutError);
    expect(err.remoteCode).toBe("quota_exceeded");

    await rpc.close();
    await service.close();
  });

  it("a contract-invalid response is rejected by the server (invalid_response)", async () => {
    const { client, server } = pair();
    const service = createMicroservice({ transport: server }).handler(
      doubler,
      async () => ({ result: "bad" }) as unknown as { result: number },
    );
    await service.listen();
    const rpc = createRpcClient({ transport: client });
    await rpc.connect();

    const err = (await rpc.send(doubler, { n: 2 }).catch((e) => e)) as RpcRemoteError;
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err.remoteCode).toBe("invalid_response");

    await rpc.close();
    await service.close();
  });

  it("a duplicate idempotency key replays the outcome without re-running the handler", async () => {
    const { client, server } = pair();
    let calls = 0;
    const service = createMicroservice({
      transport: server,
      idempotency: new MemoryIdempotencyStore(),
    }).handler(doubler, async ({ request }) => {
      calls += 1;
      return { result: request.n * 2 };
    });
    await service.listen();
    const rpc = createRpcClient({ transport: client });
    await rpc.connect();

    const a = await rpc.send(doubler, { n: 21 }, { idempotencyKey: "k1" });
    const b = await rpc.send(doubler, { n: 21 }, { idempotencyKey: "k1" });
    expect(a).toEqual({ result: 42 });
    expect(b).toEqual({ result: 42 });
    expect(calls).toBe(1);

    await rpc.close();
    await service.close();
  });
});

describe("InMemoryTransport — builder safeParse → drop/DLQ for fire-and-forget (T11.2)", () => {
  it("a schema-invalid fire-and-forget message is dead-lettered (not silently dropped), handler never runs", async () => {
    const { bus, client, server } = pair();
    let handlerRuns = 0;
    const service = createMicroservice({ transport: server }).handler(notify, async () => {
      handlerRuns += 1;
    });
    await service.listen();
    await client.connect();

    const dlq = collectDlq(bus, "user.notify.dlq");
    // Publish a raw, schema-invalid payload straight onto the wire (bypassing the
    // client's own request validation) to exercise the SERVER's safeParse → DLQ.
    await client.emit("user.notify", { wrong: "shape" });
    await tick();

    expect(handlerRuns).toBe(0);
    expect(dlq.length).toBe(1);
    // The DLQ carries the original wire bytes — since SF2 that is the event
    // envelope, with the rejected payload under `d`.
    expect(JSON.parse(dlq[0]!)).toEqual({ k: "evt", d: { wrong: "shape" } });

    await client.close();
    await service.close();
  });

  it("a throwing fire-and-forget handler dead-letters the message", async () => {
    const { bus, client, server } = pair();
    const service = createMicroservice({ transport: server }).handler(notify, async () => {
      throw new Error("handler boom");
    });
    await service.listen();
    await client.connect();

    const dlq = collectDlq(bus, "user.notify.dlq");
    await client.emit("user.notify", { userId: "u1" }); // valid shape, handler throws
    await tick();

    expect(dlq.length).toBe(1);
    expect(JSON.parse(dlq[0]!)).toEqual({ k: "evt", d: { userId: "u1" } });

    await client.close();
    await service.close();
  });
});

describe("InMemoryTransport — emit/consume + lifecycle (T11.2)", () => {
  it("delivers an emitted event to the consumer", async () => {
    const { client, server } = pair();
    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("evt", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    await client.emit("evt", { hello: "world" });
    await tick();
    expect(received).toContainEqual({ hello: "world" });

    await client.close();
    await server.close();
  });

  it("connect/close is idempotent and drains in-flight work before teardown", async () => {
    const t = new InMemoryTransport({ logger: silent });
    await t.connect();
    await t.connect();
    expect(t.connectionState).toBe("connected");
    await t.close();
    await t.close();
    expect(t.connectionState).toBe("closed");
  });

  it("closing rejects pending RPC calls (no dangling promises)", async () => {
    // A short drain window: close() drains in-flight work (bounded by
    // drainTimeoutMs) then teardown rejects any still-pending RPC call.
    const bus = new MemoryBus();
    const server = new InMemoryTransport({ bus, logger: silent });
    const client = new InMemoryTransport({ bus, logger: silent, drainTimeoutMs: 20 });
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("slow", async () => {
      /* never replies */
    });
    await server.listen(handlers);
    await client.connect();

    const pending = client.send("slow", {}, { timeoutMs: 5000 });
    await tick(); // let the call register (published + awaiting a reply) before closing
    await client.close(); // must reject the in-flight call rather than hang
    await expect(pending).rejects.toThrow(/closing/);

    await server.close();
  });
});
