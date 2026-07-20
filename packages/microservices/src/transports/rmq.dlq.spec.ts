import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

// ── In-memory amqplib mock with exchange bindings + message buffering. ──
// Extends the rmq.rpc mock with exchange→queue bindings so the dead-letter
// exchange actually routes to the DLQ, and buffers messages for queues that have
// no consumer (the DLQ) so the test can inspect what was dead-lettered.
const broker = vi.hoisted(() => {
  interface Msg {
    content: Buffer;
    properties: Record<string, unknown>;
    fields: { routingKey: string };
  }
  const consumers = new Map<string, (msg: Msg) => void>();
  const buffered = new Map<string, Msg[]>();
  const bindings = new Map<string, Set<string>>(); // exchange -> bound queues
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
    async bindQueue(queue: string, exchange: string): Promise<void> {
      const set = bindings.get(exchange) ?? new Set<string>();
      set.add(queue);
      bindings.set(exchange, set);
    },
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
    publish(exchange: string, routingKey: string, content: Buffer, properties: Record<string, unknown> = {}): boolean {
      // Fanout DLX: route to every bound queue regardless of routing key.
      for (const q of bindings.get(exchange) ?? []) {
        deliver(q, { content, properties, fields: { routingKey } });
      }
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
      bindings.clear();
      seq = 0;
    },
    /** Messages that landed in an unconsumed queue (e.g. the DLQ). */
    messagesIn: (queue: string): Msg[] => buffered.get(queue) ?? [],
  };
});

vi.mock("amqplib", () => ({ connect: broker.connect, default: { connect: broker.connect } }));

import { RmqTransport } from "./rmq.transport";
import type { RawMessageHandler } from "./transport.interface";
import { createMicroservice } from "../server/microservice.builder";
import { defineContract } from "../contracts/contract-builder";

const silent = { log() {}, warn() {}, error() {} };

beforeEach(() => broker.reset());

describe("RMQ DLQ + max-retry (Sprint 9) — poison messages never loop", () => {
  it("dead-letters a repeatedly-failing message after max-retry (bounded, no loop)", async () => {
    let calls = 0;
    const server = new RmqTransport({ urls: ["amqp://mock"], queue: "jobs", maxRetries: 2, logger: silent });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async () => {
      calls += 1;
      throw new Error("poison"); // always fails → exercises the retry→DLQ path
    });
    await server.listen(handlers);

    const client = new RmqTransport({ urls: ["amqp://mock"], queue: "unused", logger: silent });
    await client.connect();
    await client.emit("jobs", { bad: true });

    await vi.waitFor(() => {
      if (broker.messagesIn("jobs.dlq").length < 1) throw new Error("not dead-lettered yet");
    });

    // initial delivery + maxRetries(2) redeliveries = 3 handler invocations, then DLQ.
    expect(calls).toBe(3);
    const dead = broker.messagesIn("jobs.dlq");
    expect(dead).toHaveLength(1);
    // The DLQ carries the original body — since SF2 that is the event envelope.
    expect(JSON.parse(dead[0]!.content.toString())).toEqual({ k: "evt", d: { bad: true } });
    const headers = dead[0]!.properties["headers"] as Record<string, unknown>;
    expect(headers["x-retry-count"]).toBe(2);
    expect(String(headers["x-death-reason"])).toContain("poison");

    // Nothing left looping on the source queue.
    expect(broker.messagesIn("jobs")).toHaveLength(0);

    await client.close();
    await server.close();
  });

  it("dead-letters a schema-invalid message immediately, without retrying", async () => {
    const contract = defineContract({
      topic: "jobs",
      request: z.object({ n: z.number() }),
      response: z.void(),
    });

    let handlerCalls = 0;
    const service = createMicroservice({
      transport: new RmqTransport({ urls: ["amqp://mock"], queue: "jobs", maxRetries: 5, logger: silent }),
    }).handler(contract, async () => {
      handlerCalls += 1;
    });
    await service.listen();

    const client = new RmqTransport({ urls: ["amqp://mock"], queue: "unused", logger: silent });
    await client.connect();
    // Transport-level emit bypasses client-side validation → invalid bytes hit the server.
    await client.emit("jobs", { n: "not-a-number" });

    await vi.waitFor(() => {
      if (broker.messagesIn("jobs.dlq").length < 1) throw new Error("not dead-lettered yet");
    });

    expect(handlerCalls).toBe(0); // validation failed before the handler ran
    const dead = broker.messagesIn("jobs.dlq");
    expect(dead).toHaveLength(1);
    // Permanent failure → no retries despite maxRetries: 5.
    expect((dead[0]!.properties["headers"] as Record<string, unknown>)["x-retry-count"]).toBe(0);

    await client.close();
    await service.close();
  });
});

describe("RMQ inbound message-size cap (Sprint SF1 — L4)", () => {
  it("dead-letters an oversize message immediately, without parsing or retrying it", async () => {
    let handlerCalls = 0;
    const server = new RmqTransport({
      urls: ["amqp://mock"],
      queue: "jobs",
      maxRetries: 5,
      maxMessageBytes: 200,
      logger: silent,
    });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async () => {
      handlerCalls += 1;
    });
    await server.listen(handlers);

    const client = new RmqTransport({ urls: ["amqp://mock"], queue: "unused", logger: silent });
    await client.connect();
    await client.emit("jobs", { blob: "x".repeat(1000) });

    await vi.waitFor(() => {
      if (broker.messagesIn("jobs.dlq").length < 1) throw new Error("not dead-lettered yet");
    });

    expect(handlerCalls).toBe(0);
    const dead = broker.messagesIn("jobs.dlq");
    expect(dead).toHaveLength(1);
    const headers = dead[0]!.properties["headers"] as Record<string, unknown>;
    // Permanent failure → straight to the DLX, no retry loop despite maxRetries: 5.
    expect(headers["x-retry-count"]).toBe(0);
    expect(String(headers["x-death-reason"])).toContain("exceeding the 200-byte limit");
    expect(broker.messagesIn("jobs")).toHaveLength(0); // nothing left looping on the source queue

    await client.close();
    await server.close();
  });
});
