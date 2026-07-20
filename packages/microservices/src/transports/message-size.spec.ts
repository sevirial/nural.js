// ──────────────────────────────────────────────────────────────────────────
// Inbound message-size cap (Sprint SF1 — audit finding L4).
//
// The guard lives in `BaseTransport.verifyWire`, which every transport's inbound
// path funnels through, so these specs assert both halves of the claim:
//   • the guard itself rejects before verify/parse (BaseTransport unit tests), and
//   • an oversize message is dead-lettered — not retried, not parsed, handler
//     never runs — on a real round-trip (memory) and a mocked broker (kafka).
// Redis and RMQ are covered in `redis.security.spec.ts` / `rmq.dlq.spec.ts`,
// alongside their existing broker mocks.
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from "vitest";

// ── Minimal kafkajs mock: captures produced messages and exposes the consumer's
// `eachMessage` so a test can push a raw record at it.
const kafka = vi.hoisted(() => {
  interface Produced { topic: string; messages: Array<{ value: unknown; headers?: unknown }> }
  const produced: Produced[] = [];
  let eachMessage: ((p: { topic: string; partition: number; message: { value: Buffer; offset: string } }) => Promise<void>) | null = null;

  class FakeKafka {
    constructor(_config?: unknown) {}
    producer() {
      return {
        async connect(): Promise<void> {},
        async disconnect(): Promise<void> {},
        async send(p: Produced): Promise<void> {
          produced.push(p);
        },
      };
    }
    consumer() {
      return {
        async connect(): Promise<void> {},
        async disconnect(): Promise<void> {},
        async subscribe(): Promise<void> {},
        async run(cfg: { eachMessage: NonNullable<typeof eachMessage> }): Promise<void> {
          eachMessage = cfg.eachMessage;
        },
      };
    }
  }

  return {
    Kafka: FakeKafka,
    produced,
    deliver: (topic: string, value: string) =>
      eachMessage!({ topic, partition: 0, message: { value: Buffer.from(value), offset: "0" } }),
    reset: () => {
      produced.length = 0;
      eachMessage = null;
    },
  };
});

vi.mock("kafkajs", () => ({ Kafka: kafka.Kafka, default: { Kafka: kafka.Kafka } }));

import {
  BaseTransport,
  type BaseTransportOptions,
  DEFAULT_MAX_MESSAGE_BYTES,
  parseTransportOptions,
  baseOptionsShape,
} from "./base.transport";
import { z } from "zod";
import { InvalidMessageError, RpcTimeoutError } from "../errors";
import { createSharedSecretSigner } from "../signing";
import { InMemoryTransport, MemoryBus, createInMemoryPair } from "./memory.transport";
import { KafkaTransport } from "./kafka.transport";
import type { RawMessageHandler } from "./transport.interface";

const silent = { log() {}, warn() {}, error() {} };
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Exposes the protected wire hooks so the guard can be driven directly. */
class FakeTransport extends BaseTransport {
  constructor(opts: BaseTransportOptions = {}) {
    super("Fake", { logger: silent, ...opts });
  }
  protected async openConnection(): Promise<void> {}
  protected async teardown(): Promise<void> {}
  public verify(wire: string): string {
    return this.verifyWire(wire);
  }
  public sign(payload: string): string {
    return this.signWire(payload);
  }
}

/** Collects every message published to `channel` on `bus`. */
function collectDlq(bus: MemoryBus, channel: string): string[] {
  const seen: string[] = [];
  bus.subscribe(channel, (m) => seen.push(m));
  return seen;
}

describe("BaseTransport — guardMessageSize (SF1.2)", () => {
  it("defaults to a 1 MiB cap", () => {
    expect(DEFAULT_MAX_MESSAGE_BYTES).toBe(1_048_576);
    const t = new FakeTransport();
    expect(() => t.verify("x".repeat(DEFAULT_MAX_MESSAGE_BYTES + 1))).toThrow(InvalidMessageError);
    expect(t.verify("x".repeat(1024))).toHaveLength(1024); // a normal message is untouched
  });

  it("rejects over the cap with a permanent, payload-free InvalidMessageError", () => {
    const t = new FakeTransport({ maxMessageBytes: 100 });
    const err = (() => {
      try {
        t.verify("SECRETSECRET".repeat(50)); // 600 bytes
        return null;
      } catch (e) {
        return e as InvalidMessageError;
      }
    })();

    expect(err).toBeInstanceOf(InvalidMessageError);
    expect(err!.code).toBe("message_too_large");
    expect(err!.retryable).toBe(false); // permanent → dead-letter, never retry
    expect(err!.message).toContain("600");
    expect(err!.message).toContain("100");
    expect(err!.message).not.toContain("SECRET"); // no payload bytes in the error
  });

  it("is inclusive at the boundary: exactly the cap passes, one byte over throws", () => {
    const t = new FakeTransport({ maxMessageBytes: 10 });
    expect(t.verify("0123456789")).toBe("0123456789");
    expect(() => t.verify("0123456789X")).toThrow(/exceeding the 10-byte limit/);
  });

  it("measures BYTES, not characters (multi-byte UTF-8)", () => {
    const t = new FakeTransport({ maxMessageBytes: 8 });
    expect(() => t.verify("€€€")).toThrow(InvalidMessageError); // 3 chars, 9 bytes
    expect(t.verify("€€")).toBe("€€"); // 6 bytes
  });

  it("maxMessageBytes: 0 disables the cap (explicit opt-out)", () => {
    const t = new FakeTransport({ maxMessageBytes: 0 });
    const huge = "x".repeat(DEFAULT_MAX_MESSAGE_BYTES * 2);
    expect(t.verify(huge)).toHaveLength(huge.length);
  });

  it("runs BEFORE signature verification — an oversize message is rejected as too-large, not as unsigned", () => {
    const t = new FakeTransport({ maxMessageBytes: 50, signer: createSharedSecretSigner({ secret: "s" }) });
    // Unsigned AND oversize: the size guard must win, proving it runs first.
    const err = (() => {
      try {
        t.verify("x".repeat(200));
        return null;
      } catch (e) {
        return e as InvalidMessageError;
      }
    })();
    expect(err!.code).toBe("message_too_large");
  });

  it("accepts 0 and rejects a negative cap at option-validation time", () => {
    const schema = z.object({ ...baseOptionsShape });
    expect(parseTransportOptions("X", schema, { maxMessageBytes: 0 })).toBeTruthy();
    expect(() => parseTransportOptions("X", schema, { maxMessageBytes: -1 })).toThrow(
      /X: invalid options/,
    );
  });
});

describe("InMemoryTransport — oversize message is dead-lettered (SF1.3, SF1.5)", () => {
  it("dead-letters an oversize message; the handler never runs", async () => {
    const { bus, client, server } = createInMemoryPair({ logger: silent, maxMessageBytes: 200 });

    let handlerRuns = 0;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async () => {
      handlerRuns += 1;
    });
    await server.listen(handlers);
    await client.connect();

    const dlq = collectDlq(bus, "jobs.dlq");

    await client.emit("jobs", { blob: "x".repeat(1000) }); // > 200 bytes on the wire
    await tick();

    expect(handlerRuns).toBe(0);
    expect(dlq).toHaveLength(1);

    await client.close();
    await server.close();
  });

  it("a normal-size message is unaffected", async () => {
    const { client, server } = createInMemoryPair({ logger: silent }); // default 1 MiB
    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    await client.emit("jobs", { hello: "world" });
    await tick();

    expect(received).toEqual([{ hello: "world" }]);

    await client.close();
    await server.close();
  });

  it("maxMessageBytes: 0 lets an over-default message through", async () => {
    const { client, server } = createInMemoryPair({ logger: silent, maxMessageBytes: 0 });
    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await server.listen(handlers);
    await client.connect();

    const blob = "x".repeat(DEFAULT_MAX_MESSAGE_BYTES + 1000);
    await client.emit("jobs", { blob });
    await tick();

    expect(received).toEqual([{ blob }]);

    await client.close();
    await server.close();
  });
});

describe("InMemoryTransport — the cap also bounds RPC replies (SF1.3)", () => {
  it("an oversize reply is rejected, so the caller times out rather than parsing it", async () => {
    // The cap lives in verifyWire, which the reply path also funnels through — an
    // inbound reply is untrusted bytes too. A rejected reply never reaches the
    // correlator, so the pending call lapses into its normal timeout.
    const bus = new MemoryBus();
    const server = new InMemoryTransport({ bus, logger: silent });
    const client = new InMemoryTransport({ bus, logger: silent, maxMessageBytes: 200 });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("big", async (_data, ctx) => {
      await server.reply(ctx, { blob: "x".repeat(1000) }); // reply exceeds the client's cap
    });
    await server.listen(handlers);
    await client.connect();

    await expect(client.send("big", {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(RpcTimeoutError);

    await client.close();
    await server.close();
  });

  it("a reply under the cap round-trips normally", async () => {
    const bus = new MemoryBus();
    const server = new InMemoryTransport({ bus, logger: silent });
    const client = new InMemoryTransport({ bus, logger: silent, maxMessageBytes: 1000 });

    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("small", async (_data, ctx) => {
      await server.reply(ctx, { ok: true });
    });
    await server.listen(handlers);
    await client.connect();

    expect(await client.send("small", {}, { timeoutMs: 500 })).toEqual({ ok: true });

    await client.close();
    await server.close();
  });
});

describe("KafkaTransport — oversize message is dead-lettered (SF1.3)", () => {
  it("routes an oversize record to the DLQ topic; the handler never runs", async () => {
    kafka.reset();
    const transport = new KafkaTransport({
      client: { brokers: ["localhost:9092"] },
      consumer: { groupId: "svc" },
      logger: silent,
      maxMessageBytes: 200,
    });

    let handlerRuns = 0;
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async () => {
      handlerRuns += 1;
    });
    await transport.listen(handlers);

    await kafka.deliver("jobs", JSON.stringify({ blob: "x".repeat(1000) }));

    expect(handlerRuns).toBe(0);
    const dlq = kafka.produced.filter((p) => p.topic === "jobs.dlq");
    expect(dlq).toHaveLength(1);
    expect(String((dlq[0]!.messages[0]!.headers as Record<string, string>)["x-death-reason"])).toContain(
      "exceeding the 200-byte limit",
    );

    await transport.close();
  });

  it("a normal-size record still reaches the handler", async () => {
    kafka.reset();
    const transport = new KafkaTransport({
      client: { brokers: ["localhost:9092"] },
      consumer: { groupId: "svc" },
      logger: silent,
    });

    const received: unknown[] = [];
    const handlers = new Map<string, RawMessageHandler>();
    handlers.set("jobs", async (data) => {
      received.push(data);
    });
    await transport.listen(handlers);

    await kafka.deliver("jobs", JSON.stringify({ ok: true }));

    expect(received).toEqual([{ ok: true }]);
    expect(kafka.produced.filter((p) => p.topic === "jobs.dlq")).toHaveLength(0);

    await transport.close();
  });
});
