import type { RedisOptions } from "ioredis";
import { z } from "zod";
import {
  ClientTransport,
  RawMessageHandler,
  SendOptions,
  ServerTransport,
  TransportCapabilities,
} from "./transport.interface";
import { RpcContext, CORRELATION_HEADER } from "../server/rpc-context";
import { RpcCorrelator, newCorrelationId } from "./rpc-correlation";
import {
  BaseTransport,
  BaseTransportOptions,
  baseOptionsShape,
  errMessage,
  loadOptionalDep,
  parseTransportOptions,
} from "./base.transport";
import { WireEnvelope, wrapEvent, wrapRpc } from "./wire-envelope";

type IORedisModule = typeof import("ioredis");
type RedisClient = InstanceType<IORedisModule["default"]>;

export interface RedisTransportOptions extends BaseTransportOptions {
  host: string;
  port: number;
  password?: string;
  /** Default RPC reply timeout, ms (per-call override via `send(..,{timeoutMs})`). Default 30_000. */
  rpcTimeoutMs?: number;
  /**
   * Dead-letter failed fire-and-forget messages to a `<topic><suffix>` channel
   * instead of dropping them silently (Sprint 9). Default true. Note: Redis
   * pub/sub is at-most-once (no redelivery), so there is no retry — a dead-letter
   * subscriber must be listening for the message to be captured.
   */
  enableDeadLetter?: boolean;
  /** Suffix appended to the topic for the dead-letter channel. Default `.dlq`. */
  deadLetterSuffix?: string;
}

const redisOptionsSchema = z
  .object({
    host: z.string().min(1, "host is required"),
    port: z.number().int().min(1).max(65535, "port must be 1–65535"),
    password: z.string().optional(),
    rpcTimeoutMs: z.number().int().positive().optional(),
    enableDeadLetter: z.boolean().optional(),
    deadLetterSuffix: z.string().min(1).optional(),
    ...baseOptionsShape,
  })
  .passthrough();

/** The RPC reply envelope Redis puts on the wire. */
interface RedisRpcReply {
  correlationId: string;
  data: unknown;
}

/**
 * Redis pub/sub transport.
 *
 * Sprint 8 RPC hardening:
 * - **UUID correlation ids** (via the shared {@link RpcCorrelator}) replace the
 *   old `Math.random` reply-channel suffix.
 * - RPC replies arrive on **one pooled per-client inbox channel** and are matched
 *   by correlation id (no per-call subscribe/unsubscribe).
 * - **Per-call and per-client timeouts** (typed `RpcTimeoutError`).
 * - Correlation + trace headers propagate into `RpcContext.headers`.
 */
export class RedisTransport extends BaseTransport implements ServerTransport, ClientTransport {
  public readonly capabilities: TransportCapabilities = { supportsRpc: true };

  private readonly options: RedisTransportOptions;
  private readonly rpcTimeoutMs: number;
  private readonly deadLetterEnabled: boolean;
  private readonly deadLetterSuffix: string;
  private readonly correlator = new RpcCorrelator();

  private RedisCtor: IORedisModule["default"] | null = null;
  private pub: RedisClient | null = null;
  private sub: RedisClient | null = null;
  private rpcSub: RedisClient | null = null;

  private handlers: Map<string, RawMessageHandler> | null = null;
  private serverListenerBound = false;
  private inbox: string | null = null;
  private inboxSetup: Promise<string> | null = null;

  constructor(options: RedisTransportOptions) {
    parseTransportOptions("RedisTransport", redisOptionsSchema, options);
    super("RedisTransport", options);
    this.options = options;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    this.deadLetterEnabled = options.enableDeadLetter ?? true;
    this.deadLetterSuffix = options.deadLetterSuffix ?? ".dlq";
  }

  protected async openConnection(): Promise<void> {
    if (!this.RedisCtor) {
      const mod = await loadOptionalDep<IORedisModule>("ioredis", "redis");
      this.RedisCtor = mod.default ?? (mod as unknown as IORedisModule["default"]);
    }
    const Redis = this.RedisCtor;

    const redisOptions: RedisOptions = {
      host: this.options.host,
      port: this.options.port,
      password: this.options.password,
      lazyConnect: true,
      retryStrategy: (times: number) => this.backoffDelay(times),
    };

    this.pub = new Redis(redisOptions);
    this.sub = new Redis(redisOptions);
    this.rpcSub = new Redis(redisOptions);

    for (const [label, client] of [
      ["pub", this.pub],
      ["sub", this.sub],
      ["rpc", this.rpcSub],
    ] as const) {
      client.on("error", (err: unknown) => {
        this.logger.error(`RedisTransport: ${label} client error — ${errMessage(err)}`);
      });
      client.on("reconnecting", () => {
        this.logger.warn(`RedisTransport: ${label} client reconnecting`);
      });
    }

    // Pooled RPC replies: every reply arrives on the client's single inbox
    // channel and is matched to its pending call by correlation id.
    //
    // Reply-channel binding (Sprint 10, T10.5): the inbox is a per-client,
    // unguessable UUID channel, and `correlator.deliver` resolves *only* the
    // pending call whose exact correlation id the reply carries — a reply bearing
    // an unknown/other correlation id is dropped (`deliver` returns false). So a
    // reply can only ever reach the caller that issued it. With a `signer`
    // configured, the reply's signature is verified first, so a forged reply
    // published onto a known inbox is rejected before it is even considered.
    this.rpcSub.on("message", (channel: string, message: string) => {
      if (channel !== this.inbox) return;
      try {
        const reply = JSON.parse(this.verifyWire(message)) as RedisRpcReply;
        this.correlator.deliver(reply.correlationId, reply.data);
      } catch (err) {
        this.logger.error(`RedisTransport: rejected RPC reply on ${channel} — ${errMessage(err)}`);
      }
    });

    await Promise.all([this.pub.connect(), this.sub.connect(), this.rpcSub.connect()]);
  }

  /** Lazily establishes the per-client reply inbox on first `send()` (single-flight). */
  private async ensureInbox(): Promise<string> {
    if (this.inbox) return this.inbox;
    if (!this.inboxSetup) {
      this.inboxSetup = (async () => {
        const inbox = `nural:reply:${newCorrelationId()}`;
        await this.rpcSub!.subscribe(inbox);
        this.inbox = inbox;
        return inbox;
      })();
    }
    return this.inboxSetup;
  }

  private readonly onServerMessage = (channel: string, message: string): void => {
    const handler = this.handlers?.get(channel);
    if (!handler) return;

    let envelope: WireEnvelope;
    try {
      // Size-guard + verify the signature (a no-op without a signer) before parsing:
      // a tampered/forged message is rejected here and dead-lettered, never processed.
      // The message's kind then comes from its explicit `k` discriminator — an
      // `emit()` payload containing a `replyTo` field is just data (SF2, audit L2).
      envelope = this.readWire(message);
    } catch (err) {
      // Malformed / unauthenticated / unrecognized-envelope bytes: no handler can
      // process them — dead-letter rather than drop.
      void this.deadLetter(channel, message, err);
      return;
    }

    if (envelope.k === "rpc") {
      const headers = { ...(envelope.h ?? {}) };
      if (envelope.c) headers[CORRELATION_HEADER] = envelope.c;
      const ctx = new RpcContext("redis", channel, envelope.r, headers, envelope.c);
      // RPC failures are handled by the builder (a typed error envelope goes back
      // to the caller); catch only so a rejection is never unhandled.
      const run = Promise.resolve()
        .then(() => handler(envelope.d, ctx))
        .catch((err: unknown) => {
          this.logger.error(`RedisTransport: RPC handler error on ${channel} — ${errMessage(err)}`);
        });
      void this.trackInflight(run);
    } else {
      const ctx = new RpcContext("redis", channel);
      // Fire-and-forget: a failed handler has no caller to notify, so route the
      // message to the dead-letter channel instead of dropping it silently.
      const run = Promise.resolve()
        .then(() => handler(envelope.d, ctx))
        .catch((err: unknown) => this.deadLetter(channel, message, err));
      void this.trackInflight(run);
    }
  };

  /**
   * Dead-letters a fire-and-forget message that failed processing (Sprint 9).
   * Redis pub/sub has no redelivery, so there is no retry — the original bytes
   * are republished to `<topic><deadLetterSuffix>` (at-most-once; a subscriber
   * must be listening to capture it).
   */
  private async deadLetter(topic: string, rawMessage: string, err: unknown): Promise<void> {
    this.logger.error(`RedisTransport: message on ${topic} failed — ${errMessage(err)}; dead-lettering`);
    if (!this.deadLetterEnabled || !this.pub) return;
    try {
      await this.pub.publish(`${topic}${this.deadLetterSuffix}`, rawMessage);
    } catch (e) {
      this.logger.error(`RedisTransport: dead-letter publish failed on ${topic} — ${errMessage(e)}`);
    }
  }

  public async listen(handlers: Map<string, RawMessageHandler>): Promise<void> {
    const topics = Array.from(handlers.keys());
    if (topics.length === 0) {
      throw new Error("RedisTransport: no topics to listen to");
    }
    this.handlers = handlers;
    await this.connect();
    if (!this.serverListenerBound) {
      this.sub!.on("message", this.onServerMessage);
      this.serverListenerBound = true;
    }
    await this.sub!.subscribe(...topics);
  }

  public async connect(): Promise<void> {
    await super.connect();
  }

  public async emit(topic: string, data: unknown): Promise<void> {
    await this.connect();
    const wire = this.signWire(JSON.stringify(wrapEvent(data)));
    await this.trackInflight(this.pub!.publish(topic, wire).then(() => undefined));
  }

  public async send(topic: string, data: unknown, options?: SendOptions): Promise<unknown> {
    await this.connect();
    const replyTo = await this.ensureInbox();
    const correlationId = newCorrelationId();
    const timeoutMs = options?.timeoutMs ?? this.rpcTimeoutMs;
    const headers = { ...(options?.headers ?? {}), [CORRELATION_HEADER]: correlationId };

    const wire = this.signWire(JSON.stringify(wrapRpc(data, { replyTo, correlationId, headers })));
    const waiting = this.correlator.waitFor(correlationId, timeoutMs);

    // Publish the request; a publish failure must reject the pending call.
    this.pub!.publish(topic, wire).catch((err: unknown) => {
      this.correlator.fail(correlationId, err instanceof Error ? err : new Error(String(err)));
    });

    return this.trackInflight(waiting);
  }

  public async reply(ctx: RpcContext, data: unknown): Promise<void> {
    if (!ctx.replyTo) return;
    await this.connect();
    const reply: RedisRpcReply = { correlationId: ctx.correlationId ?? "", data };
    await this.pub!.publish(ctx.replyTo, this.signWire(JSON.stringify(reply)));
  }

  protected async teardown(): Promise<void> {
    this.correlator.rejectAll(new Error("RedisTransport: closing"));
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit(), this.rpcSub?.quit()]);
    this.pub = this.sub = this.rpcSub = null;
    this.serverListenerBound = false;
    this.inbox = null;
    this.inboxSetup = null;
  }
}
