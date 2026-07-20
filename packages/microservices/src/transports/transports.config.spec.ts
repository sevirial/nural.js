import { describe, it, expect } from "vitest";
import { RedisTransport, type RedisTransportOptions } from "./redis.transport";
import { RmqTransport, type RmqTransportOptions } from "./rmq.transport";
import { KafkaTransport, type KafkaTransportOptions } from "./kafka.transport";

// Construction validates options synchronously (no broker connection is opened —
// the underlying client is loaded lazily in `openConnection`), so these run
// broker-free.

describe("RedisTransport — option validation", () => {
  it("rejects a missing host", () => {
    const bad = { host: "", port: 6379 } as RedisTransportOptions;
    expect(() => new RedisTransport(bad)).toThrow(/host is required/);
  });

  it("rejects an out-of-range port", () => {
    const bad = { host: "localhost", port: 70000 } as RedisTransportOptions;
    expect(() => new RedisTransport(bad)).toThrow(/RedisTransport: invalid options/);
  });

  it("constructs with valid options (no connection opened)", () => {
    expect(() => new RedisTransport({ host: "localhost", port: 6379 })).not.toThrow();
  });
});

describe("RmqTransport — option validation", () => {
  it("rejects an empty urls list", () => {
    const bad = { urls: [], queue: "jobs" } as RmqTransportOptions;
    expect(() => new RmqTransport(bad)).toThrow(/at least one url is required/);
  });

  it("rejects a missing queue", () => {
    const bad = { urls: ["amqp://localhost"], queue: "" } as RmqTransportOptions;
    expect(() => new RmqTransport(bad)).toThrow(/queue is required/);
  });

  it("constructs with valid multi-URL options", () => {
    expect(
      () =>
        new RmqTransport({
          urls: ["amqp://primary", "amqp://secondary"],
          queue: "jobs",
          prefetch: 20,
        }),
    ).not.toThrow();
  });
});

describe("KafkaTransport — option validation", () => {
  it("rejects a missing client config", () => {
    const bad = { client: null, consumer: { groupId: "g" } } as unknown as KafkaTransportOptions;
    expect(() => new KafkaTransport(bad)).toThrow(/client \(KafkaConfig\) is required/);
  });

  it("rejects a missing consumer.groupId", () => {
    const bad = {
      client: { brokers: ["localhost:9092"] },
      consumer: { groupId: "" },
    } as KafkaTransportOptions;
    expect(() => new KafkaTransport(bad)).toThrow(/consumer.groupId is required/);
  });

  it("constructs with valid options", () => {
    expect(
      () =>
        new KafkaTransport({
          client: { brokers: ["localhost:9092"] },
          consumer: { groupId: "svc" },
          fromBeginning: false,
          partitionsConsumedConcurrently: 4,
        }),
    ).not.toThrow();
  });
});
