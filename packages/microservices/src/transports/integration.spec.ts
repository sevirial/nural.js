import { describe, it, expect, afterAll } from "vitest";
import { RedisTransport } from "./redis.transport";
import { RmqTransport } from "./rmq.transport";
import { KafkaTransport } from "./kafka.transport";
import type { RawMessageHandler } from "./transport.interface";
import { RpcContext } from "../server/rpc-context";

// ──────────────────────────────────────────────────────────────────────────
// Opt-in integration tests (T7.7 / T11.3). These need a REAL broker and are
// skipped unless the matching env var points at one:
//   NURAL_IT_REDIS=localhost:6379          (host:port)
//   NURAL_IT_RMQ=amqp://localhost:5672
//   NURAL_IT_KAFKA=localhost:9092          (broker list, comma-separated)
// Run e.g.  NURAL_IT_REDIS=localhost:6379 pnpm exec vitest run integration
//
// They exercise the real wire: connect → publish/consume → RPC → DLQ → graceful
// close/drain. (Reconnect-with-backoff is transport-agnostic and exhaustively
// unit-tested in base.transport.spec.ts, so it is not re-driven per broker here.)
// A unique per-run suffix keeps topics/queues from colliding across runs.
// ──────────────────────────────────────────────────────────────────────────

const REDIS = process.env["NURAL_IT_REDIS"];
const RMQ = process.env["NURAL_IT_RMQ"];
const KAFKA = process.env["NURAL_IT_KAFKA"];

const suffix = process.env["NURAL_IT_RUN"] ?? String(process.pid);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!REDIS)("integration: Redis transport (real broker)", () => {
  const [host, port] = (REDIS ?? "localhost:6379").split(":");
  const opts = () => ({ host: host!, port: Number(port ?? 6379) });

  it("connects, does an RPC round-trip, and closes gracefully", async () => {
    const server = new RedisTransport(opts());
    const client = new RedisTransport(opts());

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("math.double", async (data, ctx: RpcContext) => {
      const n = (data as { n: number }).n;
      if (ctx.replyTo) await server.reply(ctx, { result: n * 2 });
    });
    await server.listen(handlers);
    await client.connect();

    const res = (await client.send("math.double", { n: 21 })) as { result: number };
    expect(res.result).toBe(42);

    await client.close();
    await server.close();
    expect(server.connectionState).toBe("closed"); // shutdown transitions state
  });

  it("dead-letters a failed fire-and-forget message to <topic>.dlq", async () => {
    const topic = `nural.it.redis.dlq.${suffix}`;
    const received: unknown[] = [];
    const server = new RedisTransport(opts());
    const dlqConsumer = new RedisTransport(opts());
    const client = new RedisTransport(opts());

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set(topic, async () => {
      throw new Error("boom"); // fire-and-forget failure → dead-letter
    });
    await server.listen(handlers);

    const dlqHandlers = new Map<string, RawMessageHandler>();
    dlqHandlers.set(`${topic}.dlq`, async (data) => {
      received.push(data);
    });
    await dlqConsumer.listen(dlqHandlers);
    await client.connect();

    await client.emit(topic, { x: 1 });
    await sleep(300);
    expect(received).toContainEqual({ x: 1 });

    await client.close();
    await server.close();
    await dlqConsumer.close();
  });
});

describe.skipIf(!RMQ)("integration: RMQ transport (real broker)", () => {
  const created: RmqTransport[] = [];
  afterAll(async () => {
    for (const t of created) await t.close();
  });

  it("connects with failover, consumes an emitted message, and drains on close", async () => {
    const received: unknown[] = [];
    const queue = `nural.it.jobs.${suffix}`;
    // First URL is bad → exercises multi-URL failover to the real broker.
    const server = new RmqTransport({ urls: ["amqp://invalid-host:1", RMQ as string], queue });
    const client = new RmqTransport({ urls: [RMQ as string], queue });
    created.push(server, client);

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set(queue, async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    await client.emit(queue, { hello: "world" });
    await sleep(300);
    expect(received).toContainEqual({ hello: "world" });
  });

  it("does an RPC round-trip (reply queue + correlationId) with a real broker", async () => {
    const server = new RmqTransport({ urls: [RMQ as string], queue: `nural.it.rpc.${suffix}` });
    const client = new RmqTransport({ urls: [RMQ as string], queue: `nural.it.rpc.client.${suffix}` });
    created.push(server, client);

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set(`nural.it.rpc.${suffix}`, async (data, ctx: RpcContext) => {
      const n = (data as { n: number }).n;
      if (ctx.replyTo) await server.reply(ctx, { result: n * 2 });
    });
    await server.listen(handlers);
    await client.connect();

    const res = (await client.send(`nural.it.rpc.${suffix}`, { n: 21 }, { timeoutMs: 5000 })) as {
      result: number;
    };
    expect(res.result).toBe(42);
  });

  it("bounds retries then dead-letters a poison message (no infinite requeue)", async () => {
    let attempts = 0;
    const queue = `nural.it.poison.${suffix}`;
    const server = new RmqTransport({ urls: [RMQ as string], queue, maxRetries: 2 });
    const client = new RmqTransport({ urls: [RMQ as string], queue: `${queue}.client` });
    created.push(server, client);

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set(queue, async () => {
      attempts += 1;
      throw new Error("poison"); // always fails
    });
    await server.listen(handlers);
    await client.connect();

    await client.emit(queue, { bad: true });
    await sleep(1500);
    // 1 initial delivery + 2 retries, then dead-lettered — bounded, never a loop.
    expect(attempts).toBe(3);
  });
});

describe.skipIf(!KAFKA)("integration: Kafka transport (real broker)", () => {
  const created: KafkaTransport[] = [];
  const brokers = (KAFKA ?? "localhost:9092").split(",");
  afterAll(async () => {
    for (const t of created) await t.close();
  });

  it("connects, emits, and the consumer receives; then closes cleanly", async () => {
    const topic = `nural.it.kafka.${suffix}`;
    const received: unknown[] = [];
    const producer = new KafkaTransport({ client: { brokers }, consumer: { groupId: `p-${topic}` } });
    const consumer = new KafkaTransport({
      client: { brokers },
      consumer: { groupId: `c-${topic}` },
      fromBeginning: true,
    });
    created.push(producer, consumer);

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set(topic, async (data) => {
      received.push(data);
    });
    await consumer.listen(handlers);
    await producer.connect();

    await producer.emit(topic, { hello: "kafka" });
    await sleep(2000); // Kafka rebalance + delivery is slower than the others
    expect(received).toContainEqual({ hello: "kafka" });

    await producer.close();
    await consumer.close();
    expect(consumer.connectionState).toBe("closed");
  });

  it("declares RPC unsupported (supportsRpc: false)", () => {
    const t = new KafkaTransport({ client: { brokers }, consumer: { groupId: `caps-${suffix}` } });
    created.push(t);
    expect(t.capabilities.supportsRpc).toBe(false);
  });
});
