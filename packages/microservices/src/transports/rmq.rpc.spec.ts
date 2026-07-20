import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

// ── In-memory amqplib mock: a shared broker routing sendToQueue → consumer. ──
// `vi.hoisted` builds the broker before `vi.mock` runs; both transports (client
// + server) `import("amqplib")` and therefore share this one broker.
const broker = vi.hoisted(() => {
  interface Msg {
    content: Buffer;
    properties: Record<string, unknown>;
    fields: { routingKey: string };
  }
  const consumers = new Map<string, (msg: Msg) => void>();
  const buffered = new Map<string, Msg[]>();
  let seq = 0;

  const deliver = (queue: string, msg: Msg): void => {
    const c = consumers.get(queue);
    if (c) {
      void Promise.resolve().then(() => c(msg));
    } else {
      const arr = buffered.get(queue) ?? [];
      arr.push(msg);
      buffered.set(queue, arr);
    }
  };

  const makeChannel = () => ({
    async prefetch(): Promise<void> {},
    async assertQueue(name: string): Promise<{ queue: string }> {
      return { queue: name && name.length ? name : `q_${++seq}` };
    },
    async assertExchange(): Promise<void> {},
    async bindQueue(): Promise<void> {},
    async consume(queue: string, onMsg: (msg: Msg) => void): Promise<{ consumerTag: string }> {
      consumers.set(queue, onMsg);
      const pending = buffered.get(queue);
      if (pending) {
        buffered.delete(queue);
        for (const m of pending) void Promise.resolve().then(() => onMsg(m));
      }
      return { consumerTag: `ct_${++seq}` };
    },
    sendToQueue(queue: string, content: Buffer, properties: Record<string, unknown> = {}): boolean {
      deliver(queue, { content, properties, fields: { routingKey: queue } });
      return true;
    },
    publish(_ex: string, routingKey: string, content: Buffer, properties: Record<string, unknown> = {}): boolean {
      deliver(routingKey, { content, properties, fields: { routingKey } });
      return true;
    },
    ack(): void {},
    nack(): void {},
    async close(): Promise<void> {},
  });

  const connection = {
    async createChannel() {
      return makeChannel();
    },
    on(): void {},
    async close(): Promise<void> {},
  };

  return {
    connect: async (_url: string) => connection,
    reset: () => {
      consumers.clear();
      buffered.clear();
      seq = 0;
    },
  };
});

vi.mock("amqplib", () => ({ connect: broker.connect, default: { connect: broker.connect } }));

// Import AFTER the mock is registered.
import { RmqTransport } from "./rmq.transport";
import type { RawMessageHandler } from "./transport.interface";
import type { RpcContext } from "../server/rpc-context";
import { RpcTimeoutError } from "../errors";
import { createMicroservice } from "../server/microservice.builder";
import { createRpcClient } from "../client/rpc-client";
import { defineContract } from "../contracts/contract-builder";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const silent = { log() {}, warn() {}, error() {} };
const opts = (queue: string) => ({ urls: ["amqp://mock"], queue, logger: silent });

beforeEach(() => broker.reset());

describe("RMQ RPC — request/reply over the reply-queue + correlationId", () => {
  it("round-trips a request to a handler and resolves with its reply", async () => {
    const server = new RmqTransport(opts("math.double"));
    const client = new RmqTransport(opts("client-unused"));

    let seen: RpcContext | undefined;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx) => {
      seen = ctx;
      const n = (data as { n: number }).n;
      await server.reply(ctx, { result: n * 2 });
    });

    await server.listen(handlers);
    await client.connect();

    const res = await client.send("math.double", { n: 21 }, { headers: { traceparent: "tp-abc" } });
    expect(res).toEqual({ result: 42 });

    // UUID correlation + trace context flowed into the server's RpcContext.
    expect(seen?.correlationId).toMatch(UUID_RE);
    expect(seen?.headers["x-correlation-id"]).toBe(seen?.correlationId);
    expect(seen?.headers["traceparent"]).toBe("tp-abc");

    await client.close();
    await server.close();
  });

  it("times out with a typed RpcTimeoutError when the handler never replies", async () => {
    const server = new RmqTransport(opts("silent"));
    const client = new RmqTransport(opts("client-unused-2"));

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("silent", async () => {
      /* deliberately never replies */
    });
    await server.listen(handlers);
    await client.connect();

    await expect(client.send("silent", { n: 1 }, { timeoutMs: 40 })).rejects.toBeInstanceOf(
      RpcTimeoutError,
    );

    await client.close();
    await server.close();
  });

  it("works through the full RpcClient + MicroserviceBuilder stack", async () => {
    const doubler = defineContract({
      topic: "math.double",
      request: z.object({ n: z.number() }),
      response: z.object({ result: z.number() }),
    });

    const service = createMicroservice({ transport: new RmqTransport(opts("math.double")) }).handler(
      doubler,
      async ({ request }) => ({ result: request.n * 2 }),
    );
    await service.listen();

    const client = createRpcClient({ transport: new RmqTransport(opts("client")) });
    await client.connect();

    const res = await client.send(doubler, { n: 50 });
    expect(res).toEqual({ result: 100 });

    await client.close();
    await service.close();
  });
});
