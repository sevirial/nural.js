import type { ChannelModel, Channel, ConsumeMessage, Options } from "amqplib";
import { z } from "zod";
import type {
  ServerTransport,
  ClientTransport,
  RawMessageHandler,
  SendOptions,
  TransportCapabilities,
} from "./transport.interface";
import { RpcContext, CORRELATION_HEADER } from "../server/rpc-context";
import { RpcCorrelator, newCorrelationId } from "./rpc-correlation";
import { InvalidMessageError } from "../errors";
import { TELEMETRY_NAMES } from "../telemetry";
import {
  BaseTransport,
  BaseTransportOptions,
  baseOptionsShape,
  errMessage,
  loadOptionalDep,
  parseTransportOptions,
} from "./base.transport";
import { WireEnvelope, wrapEvent, wrapRpc } from "./wire-envelope";

type AmqpModule = typeof import("amqplib");

/** Wire header carrying the delivery-retry count on a redelivered message. */
const RETRY_HEADER = "x-retry-count";
/** Wire header carrying the failure reason on a dead-lettered message. */
const DEATH_REASON_HEADER = "x-death-reason";

export interface RmqTransportOptions extends BaseTransportOptions {
  /** One or more broker URLs; tried in order for connect/failover. */
  urls: string[];
  /** The queue this microservice consumes from. */
  queue: string;
  queueOptions?: Options.AssertQueue;
  /** Consumer prefetch (unacked-message window) for backpressure. Default 10. */
  prefetch?: number;
  /** Default RPC reply timeout, ms (per-call override via `send(..,{timeoutMs})`). Default 30_000. */
  rpcTimeoutMs?: number;
  /**
   * Max delivery attempts for a failed fire-and-forget message before it is
   * dead-lettered (Sprint 9). Each failure republishes the message with an
   * incremented `x-retry-count`; on exhaustion it is routed to the dead-letter
   * exchange. Default 3. Set 0 to dead-letter on the first failure.
   */
  maxRetries?: number;
  /** Dead-letter exchange name. Default `<queue>.dlx`. */
  deadLetterExchange?: string;
  /** Dead-letter queue name (bound to the DLX). Default `<queue>.dlq`. */
  deadLetterQueue?: string;
}

const rmqOptionsSchema = z
  .object({
    urls: z.array(z.string().min(1, "url must be non-empty")).min(1, "at least one url is required"),
    queue: z.string().min(1, "queue is required"),
    prefetch: z.number().int().nonnegative().optional(),
    rpcTimeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().nonnegative().optional(),
    deadLetterExchange: z.string().min(1).optional(),
    deadLetterQueue: z.string().min(1).optional(),
    queueOptions: z.custom<Options.AssertQueue>().optional(),
    ...baseOptionsShape,
  })
  .passthrough();

/** Strips credentials from an `amqp://user:pass@host` URL before it is logged. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return "<url>";
  }
}

/**
 * RabbitMQ transport.
 *
 * Sprint 8 adds **request/reply RPC** (RabbitMQ's callback-queue pattern),
 * generalizing the Redis correlation model via the shared {@link RpcCorrelator}:
 * - the client lazily declares an **exclusive reply queue** and consumes it;
 * - each `send()` publishes to the target queue with `replyTo` + a UUID
 *   `correlationId` in the message properties, and awaits a matching reply;
 * - the server surfaces `replyTo`/`correlationId` on the `RpcContext`, and
 *   `reply()` `sendToQueue`s the response back with the same `correlationId`.
 *
 * Sprint 9 replaces the old infinite `nack(requeue)` on handler failure with a
 * **bounded retry + dead-letter** path: a failed fire-and-forget message is
 * republished with an incremented `x-retry-count` until `maxRetries`, then routed
 * to a dead-letter exchange/queue and acked — so a poison message can never loop.
 * RPC failures are handled by the builder (a typed error envelope goes back to
 * the caller) and are acked, never retried.
 */
export class RmqTransport extends BaseTransport implements ServerTransport, ClientTransport {
  public readonly capabilities: TransportCapabilities = { supportsRpc: true };

  private readonly options: RmqTransportOptions;
  private readonly prefetch: number;
  private readonly rpcTimeoutMs: number;
  private readonly deliveryMaxRetries: number;
  private readonly dlx: string;
  private readonly dlq: string;
  private readonly correlator = new RpcCorrelator();

  private amqp: AmqpModule | null = null;
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private handlers: Map<string, RawMessageHandler> | null = null;
  private consuming = false;
  private replyQueue: string | null = null;
  private replyQueueSetup: Promise<string> | null = null;

  constructor(options: RmqTransportOptions) {
    parseTransportOptions("RmqTransport", rmqOptionsSchema, options);
    super("RmqTransport", options);
    this.options = options;
    this.prefetch = options.prefetch ?? 10;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    this.deliveryMaxRetries = options.maxRetries ?? 3;
    this.dlx = options.deadLetterExchange ?? `${options.queue}.dlx`;
    this.dlq = options.deadLetterQueue ?? `${options.queue}.dlq`;
  }

  protected async openConnection(): Promise<void> {
    if (!this.amqp) {
      this.amqp = await loadOptionalDep<AmqpModule>("amqplib", "rmq");
    }
    this.consuming = false;
    this.replyQueue = null; // exclusive reply queues die with the connection; re-declared on demand
    this.replyQueueSetup = null;

    // Failover: try each URL in order until one connects.
    let connection: ChannelModel | null = null;
    let lastErr: unknown;
    for (const url of this.options.urls) {
      try {
        connection = await this.amqp.connect(url);
        break;
      } catch (err) {
        lastErr = err;
        this.logger.warn(`RmqTransport: connect to ${redactUrl(url)} failed — ${errMessage(err)}`);
      }
    }
    if (!connection) {
      throw new Error(`RmqTransport: all ${this.options.urls.length} URL(s) failed — ${errMessage(lastErr)}`);
    }
    this.connection = connection;

    connection.on("error", (err: unknown) => {
      this.logger.error(`RmqTransport: connection error — ${errMessage(err)}`);
    });
    connection.on("close", () => {
      this.handleDisconnect(new Error("RMQ connection closed"));
    });

    this.channel = await connection.createChannel();
    await this.channel.prefetch(this.prefetch);
    await this.channel.assertQueue(this.options.queue, this.options.queueOptions);

    // Dead-letter topology (Sprint 9): failed/poison messages land in the DLQ
    // after max-retry instead of requeuing forever. A fanout DLX keeps routing
    // trivial (routing key is irrelevant).
    await this.channel.assertExchange(this.dlx, "fanout", { durable: true });
    await this.channel.assertQueue(this.dlq, { durable: true });
    await this.channel.bindQueue(this.dlq, this.dlx, "");

    if (this.handlers) await this.ensureConsuming();
  }

  private async ensureConsuming(): Promise<void> {
    if (this.consuming || !this.handlers || !this.channel) return;
    this.consuming = true;
    const channel = this.channel;

    await channel.consume(this.options.queue, (msg) => {
      if (!msg) return;
      const topic = msg.fields.routingKey;
      const handler = this.handlers?.get(topic);
      if (!handler) {
        channel.ack(msg);
        return;
      }

      const run = (async () => {
        let envelope: WireEnvelope;
        try {
          // Size-guard + verify the signature (a no-op without a signer) before
          // parsing: a tampered/forged message is a permanent failure and is
          // dead-lettered. RMQ's body is enveloped like every other transport's
          // (SF2) — but see below: RMQ classifies RPC by the AMQP property, not
          // the body, so it was never exposed to finding L2's payload sniff.
          envelope = this.readWire(msg.content.toString());
        } catch (err) {
          // Malformed / unauthenticated / unrecognized-envelope bytes are a
          // permanent failure — DLQ immediately.
          const fail =
            err instanceof InvalidMessageError
              ? err
              : new InvalidMessageError("invalid_json", errMessage(err));
          this.routeFailedMessage(channel, msg, topic, fail);
          return;
        }

        // RPC-vs-event on RMQ is decided by the AMQP `replyTo` **property** — a
        // metadata channel separate from the body, which a publisher's payload can
        // never reach. That is why RMQ was not confusable by finding L2, and why it
        // keeps this classification rather than switching to the body's `k`: a
        // legacy (pre-0.5.0) peer's RPC request has an un-enveloped body but the
        // same properties, so it keeps working through the migration window.
        const props = msg.properties;
        const correlationId =
          typeof props.correlationId === "string" ? props.correlationId : undefined;
        const replyTo = typeof props.replyTo === "string" ? props.replyTo : undefined;
        const headers: Record<string, string> = { ...((props.headers ?? {}) as Record<string, string>) };
        if (correlationId) headers[CORRELATION_HEADER] = correlationId;

        const ctx = new RpcContext("rmq", topic, replyTo, headers, correlationId);
        try {
          await handler(envelope.d, ctx);
          channel.ack(msg);
        } catch (err) {
          // The builder handles RPC failures inline (error envelope → caller);
          // a throw here is a fire-and-forget failure → bounded retry then DLQ.
          this.routeFailedMessage(channel, msg, topic, err);
        }
      })();
      void this.trackInflight(run);
    });
  }

  /**
   * Routes a failed delivery: a retryable failure is republished to the source
   * queue with an incremented `x-retry-count` until `maxRetries`; a permanent
   * failure (`retryable === false`) or an exhausted one is published to the
   * dead-letter exchange. The original message is always acked afterwards — so a
   * poison message leaves the source queue and can never requeue-loop.
   */
  private routeFailedMessage(channel: Channel, msg: ConsumeMessage, topic: string, err: unknown): void {
    const headers: Record<string, unknown> = { ...((msg.properties.headers ?? {}) as Record<string, unknown>) };
    const retryCount = Number(headers[RETRY_HEADER] ?? 0) || 0;
    const retryable = (err as { retryable?: unknown } | null)?.retryable !== false;
    const carry = {
      correlationId: msg.properties.correlationId,
      replyTo: msg.properties.replyTo,
    };

    if (retryable && retryCount < this.deliveryMaxRetries) {
      headers[RETRY_HEADER] = retryCount + 1;
      this.telemetry.incrementCounter(TELEMETRY_NAMES.retries, { topic, transport: "rmq" });
      this.logger.warn(
        `RmqTransport: ${topic} failed (attempt ${retryCount + 1}/${this.deliveryMaxRetries}), retrying — ${errMessage(err)}`,
      );
      channel.sendToQueue(this.options.queue, msg.content, { ...carry, headers });
      channel.ack(msg);
      return;
    }

    headers[RETRY_HEADER] = retryCount;
    headers[DEATH_REASON_HEADER] = errMessage(err);
    this.logger.error(
      `RmqTransport: ${topic} dead-lettered after ${retryCount} retr${retryCount === 1 ? "y" : "ies"} — ${errMessage(err)}`,
    );
    channel.publish(this.dlx, "", msg.content, { ...carry, headers });
    channel.ack(msg);
  }

  /** Lazily declares + consumes an exclusive reply queue for this client's RPCs (single-flight). */
  private async ensureReplyQueue(): Promise<string> {
    if (this.replyQueue) return this.replyQueue;
    if (!this.replyQueueSetup) {
      this.replyQueueSetup = (async () => {
        const channel = this.channel!;
        const q = await channel.assertQueue("", { exclusive: true });
        await channel.consume(
          q.queue,
          (msg) => {
            if (!msg) return;
            const correlationId = msg.properties.correlationId;
            if (typeof correlationId !== "string") return;
            try {
              // Verify the reply signature (a no-op without a signer) before
              // delivering it to the pending call bound to this correlation id.
              this.correlator.deliver(correlationId, JSON.parse(this.verifyWire(msg.content.toString())));
            } catch (err) {
              this.logger.error(`RmqTransport: rejected RPC reply — ${errMessage(err)}`);
            }
          },
          { noAck: true },
        );
        this.replyQueue = q.queue;
        return q.queue;
      })();
    }
    return this.replyQueueSetup;
  }

  public async listen(handlers: Map<string, RawMessageHandler>): Promise<void> {
    this.handlers = handlers;
    await this.connect();
    await this.ensureConsuming();
  }

  public async connect(): Promise<void> {
    await super.connect();
  }

  public async emit(topic: string, data: unknown): Promise<void> {
    await this.connect();
    const wire = this.signWire(JSON.stringify(wrapEvent(data)));
    await this.trackInflight(
      Promise.resolve().then(() => {
        this.channel!.sendToQueue(topic, Buffer.from(wire));
      }),
    );
  }

  public async send(topic: string, data: unknown, options?: SendOptions): Promise<unknown> {
    await this.connect();
    const replyTo = await this.ensureReplyQueue();
    const correlationId = newCorrelationId();
    const timeoutMs = options?.timeoutMs ?? this.rpcTimeoutMs;
    const headers = { ...(options?.headers ?? {}), [CORRELATION_HEADER]: correlationId };

    const waiting = this.correlator.waitFor(correlationId, timeoutMs);
    try {
      // The body is tagged `k:"rpc"` for uniformity with the other transports; the
      // reply metadata stays in the native AMQP properties, which is where the
      // server reads it from (see `ensureConsuming`) — so it is carried once, not
      // in two places that could disagree.
      this.channel!.sendToQueue(topic, Buffer.from(this.signWire(JSON.stringify(wrapRpc(data)))), {
        replyTo,
        correlationId,
        headers,
      });
    } catch (err) {
      this.correlator.fail(correlationId, err instanceof Error ? err : new Error(String(err)));
    }
    return this.trackInflight(waiting);
  }

  public async reply(ctx: RpcContext, data: unknown): Promise<void> {
    if (!ctx.replyTo) return;
    await this.connect();
    this.channel!.sendToQueue(ctx.replyTo, Buffer.from(this.signWire(JSON.stringify(data))), {
      correlationId: ctx.correlationId,
    });
  }

  protected async teardown(): Promise<void> {
    this.correlator.rejectAll(new Error("RmqTransport: closing"));
    try {
      if (this.channel) await this.channel.close();
    } catch (err) {
      this.logger.warn(`RmqTransport: channel close error — ${errMessage(err)}`);
    }
    try {
      if (this.connection) await this.connection.close();
    } catch (err) {
      this.logger.warn(`RmqTransport: connection close error — ${errMessage(err)}`);
    }
    this.channel = null;
    this.connection = null;
    this.consuming = false;
    this.replyQueue = null;
    this.replyQueueSetup = null;
  }
}
