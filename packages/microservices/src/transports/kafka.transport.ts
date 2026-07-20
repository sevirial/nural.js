import type { Kafka, Consumer, Producer, KafkaConfig, ConsumerConfig } from "kafkajs";
import { z } from "zod";
import type {
  ServerTransport,
  ClientTransport,
  RawMessageHandler,
  SendOptions,
  TransportCapabilities,
} from "./transport.interface";
import { RpcContext } from "../server/rpc-context";
import { InvalidMessageError, RpcUnsupportedError } from "../errors";
import {
  BaseTransport,
  BaseTransportOptions,
  baseOptionsShape,
  errMessage,
  loadOptionalDep,
  parseTransportOptions,
} from "./base.transport";
import { wrapEvent } from "./wire-envelope";

type KafkaModule = typeof import("kafkajs");

export interface KafkaTransportOptions extends BaseTransportOptions {
  client: KafkaConfig;
  consumer: ConsumerConfig;
  /**
   * Whether the consumer reads a topic from its beginning on first subscription.
   * Default **false** (the old code hardcoded `true`, silently replaying history).
   */
  fromBeginning?: boolean;
  /** Partitions processed concurrently by the consumer. Default 1 (kafkajs default). */
  partitionsConsumedConcurrently?: number;
  /**
   * Produce a failed/poison message to a `<topic><suffix>` dead-letter topic and
   * commit its offset, instead of re-throwing and stalling the partition on the
   * poison message (Sprint 9). Default true.
   */
  enableDeadLetter?: boolean;
  /** Suffix appended to the topic for the dead-letter topic. Default `.dlq`. */
  deadLetterTopicSuffix?: string;
}

const kafkaOptionsSchema = z
  .object({
    client: z.custom<KafkaConfig>(
      (v) => typeof v === "object" && v !== null,
      "client (KafkaConfig) is required",
    ),
    consumer: z
      .object({ groupId: z.string().min(1, "consumer.groupId is required") })
      .passthrough(),
    fromBeginning: z.boolean().optional(),
    partitionsConsumedConcurrently: z.number().int().positive().optional(),
    enableDeadLetter: z.boolean().optional(),
    deadLetterTopicSuffix: z.string().min(1).optional(),
    ...baseOptionsShape,
  })
  .passthrough();

/**
 * Kafka transport.
 *
 * Sprint 7 hardening:
 * - `fromBeginning` is **configurable** (default `false`) — no more forced
 *   history replay on every subscribe.
 * - `partitionsConsumedConcurrently` exposes consumer concurrency.
 * - kafkajs handles its own broker reconnection; `BaseTransport` provides the
 *   shared state machine + graceful drain-then-`disconnect()` `close()`.
 *
 * (Kafka is event-streaming; `send()` RPC becomes an explicit typed capability
 * flag in Sprint 8 rather than a call-time throw.)
 */
export class KafkaTransport extends BaseTransport implements ServerTransport, ClientTransport {
  // Kafka is event-streaming: it has no request/reply RPC. This flag makes an
  // RPC-over-Kafka wiring fail fast with a typed error (Sprint 8, T8.5).
  public readonly capabilities: TransportCapabilities = { supportsRpc: false };

  private readonly options: KafkaTransportOptions;
  private readonly fromBeginning: boolean;
  private readonly concurrency: number | undefined;
  private readonly deadLetterEnabled: boolean;
  private readonly deadLetterSuffix: string;

  private kafka: Kafka | null = null;
  private producer: Producer | null = null;
  private consumer: Consumer | null = null;

  constructor(options: KafkaTransportOptions) {
    parseTransportOptions("KafkaTransport", kafkaOptionsSchema, options);
    super("KafkaTransport", options);
    this.options = options;
    this.fromBeginning = options.fromBeginning ?? false;
    this.concurrency = options.partitionsConsumedConcurrently;
    this.deadLetterEnabled = options.enableDeadLetter ?? true;
    this.deadLetterSuffix = options.deadLetterTopicSuffix ?? ".dlq";
  }

  protected async openConnection(): Promise<void> {
    if (!this.kafka) {
      const mod = await loadOptionalDep<KafkaModule>("kafkajs", "kafka");
      this.kafka = new mod.Kafka(this.options.client);
      this.producer = this.kafka.producer();
      this.consumer = this.kafka.consumer(this.options.consumer);
    }
    await this.producer!.connect();
  }

  public async listen(handlers: Map<string, RawMessageHandler>): Promise<void> {
    await this.connect(); // ensures kafka/producer created
    const consumer = this.consumer!;
    await consumer.connect();

    for (const topic of handlers.keys()) {
      await consumer.subscribe({ topic, fromBeginning: this.fromBeginning });
    }

    await consumer.run({
      partitionsConsumedConcurrently: this.concurrency,
      eachMessage: async ({ topic, partition, message }) => {
        const handler = handlers.get(topic);
        if (!handler || !message.value) return;
        try {
          // Size-guard + verify the signature (a no-op without a signer) before
          // parsing: a tampered/forged message is dead-lettered by the catch below.
          const envelope = this.readWire(message.value.toString());
          // Kafka is event-streaming: it has no reply path, so an RPC request here
          // could never be answered. Reject it as permanent rather than silently
          // serving it as an event (SF2).
          if (envelope.k === "rpc") {
            throw new InvalidMessageError(
              "rpc_unsupported",
              "received an RPC request envelope on Kafka, which has no reply path; use emit",
            );
          }
          const ctx = new RpcContext("kafka", topic, undefined, {
            partition: partition.toString(),
            offset: message.offset,
          });
          await this.trackInflight(Promise.resolve(handler(envelope.d, ctx)));
        } catch (err) {
          // Route the poison message to a dead-letter topic and commit its offset
          // (Sprint 9) — re-throwing would stall the partition on the bad message.
          this.logger.error(`KafkaTransport: failed to process message on ${topic}`, String(err));
          await this.deadLetter(topic, message.value, err);
        }
      },
    });
  }

  /**
   * Produces a failed/poison message to the `<topic><suffix>` dead-letter topic
   * so the source partition can proceed (Sprint 9). At-least-once: the DLQ produce
   * may itself be retried by kafkajs.
   */
  private async deadLetter(topic: string, value: Buffer, err: unknown): Promise<void> {
    if (!this.deadLetterEnabled || !this.producer) return;
    const dlqTopic = `${topic}${this.deadLetterSuffix}`;
    try {
      await this.producer.send({
        topic: dlqTopic,
        messages: [{ value, headers: { "x-death-reason": errMessage(err) } }],
      });
    } catch (e) {
      this.logger.error(`KafkaTransport: dead-letter produce to ${dlqTopic} failed — ${errMessage(e)}`);
    }
  }

  public async connect(): Promise<void> {
    await super.connect();
  }

  public async emit(topic: string, data: unknown): Promise<void> {
    await this.connect();
    const wire = this.signWire(JSON.stringify(wrapEvent(data)));
    await this.trackInflight(
      this.producer!.send({ topic, messages: [{ value: wire }] }).then(() => undefined),
    );
  }

  public async send(_topic: string, _data: unknown, _options?: SendOptions): Promise<unknown> {
    // Backstop — RpcClient checks `capabilities.supportsRpc` and fails fast before
    // ever calling this. Typed so a direct caller still gets a distinguishable error.
    throw new RpcUnsupportedError(
      "KafkaTransport: Kafka is an event-streaming platform; RPC 'send' is unsupported — use 'emit'.",
    );
  }

  protected async teardown(): Promise<void> {
    await Promise.allSettled([
      this.producer?.disconnect(),
      this.consumer?.disconnect(),
    ]).then((results) => {
      for (const r of results) {
        if (r.status === "rejected") {
          this.logger.warn(`KafkaTransport: disconnect error — ${errMessage(r.reason)}`);
        }
      }
    });
  }
}
