import { describe, it, expect } from "vitest";
import { z } from "zod";
import { KafkaTransport } from "./kafka.transport";
import { RedisTransport } from "./redis.transport";
import { RmqTransport } from "./rmq.transport";
import { RpcClient } from "../client/rpc-client";
import { defineContract } from "../contracts/contract-builder";
import { RpcUnsupportedError, isRpcError } from "../errors";

const kafka = () =>
  new KafkaTransport({ client: { brokers: ["localhost:9092"] }, consumer: { groupId: "svc" } });
const redis = () => new RedisTransport({ host: "localhost", port: 6379 });
const rmq = () => new RmqTransport({ urls: ["amqp://localhost"], queue: "jobs" });

const doubler = defineContract({
  topic: "math.double",
  request: z.object({ n: z.number() }),
  response: z.object({ result: z.number() }),
});

describe("transport capabilities descriptor (T8.5)", () => {
  it("Kafka declares supportsRpc: false; Redis and RMQ declare true", () => {
    expect(kafka().capabilities.supportsRpc).toBe(false);
    expect(redis().capabilities.supportsRpc).toBe(true);
    expect(rmq().capabilities.supportsRpc).toBe(true);
  });
});

describe("RPC-over-Kafka fails fast at the call site with a typed error", () => {
  it("RpcClient.send over a Kafka transport rejects with RpcUnsupportedError — no connection opened", async () => {
    const transport = kafka();
    const client = new RpcClient(transport);

    await expect(client.send(doubler, { n: 21 })).rejects.toBeInstanceOf(RpcUnsupportedError);
    // Never connected — the check is at the call site, before any network work.
    expect(transport.connectionState).toBe("idle");
  });

  it("the thrown error is programmatically distinguishable (code rpc_unsupported)", async () => {
    const client = new RpcClient(kafka());
    try {
      await client.send(doubler, { n: 1 });
      expect.unreachable();
    } catch (e) {
      expect(isRpcError(e) && e.code).toBe("rpc_unsupported");
    }
  });
});
