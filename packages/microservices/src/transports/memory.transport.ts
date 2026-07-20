// ──────────────────────────────────────────────────────────────────────────
// In-memory transport (Sprint 11).
//
// A faithful, broker-free implementation of `ClientTransport` + `ServerTransport`
// for fast unit tests (and for consumers testing their own handlers without a
// broker). It mirrors the real transports' request/reply model exactly — the same
// {@link RpcCorrelator}, UUID correlation ids, per-client reply inbox, signing,
// telemetry, `BaseTransport` lifecycle (connect / drain / close), and dead-letter
// path — so a test driving the full `RpcClient` ↔ `MicroserviceBuilder` stack over
// it exercises the *same* code paths it would over Redis, just in-process.
//
// Two instances that share a {@link MemoryBus} communicate like a client and a
// server on a broker; an instance with its own (default) bus is a self-contained
// loopback. {@link createInMemoryPair} returns a wired `{ bus, client, server }`.
// ──────────────────────────────────────────────────────────────────────────

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
  parseTransportOptions,
} from "./base.transport";
import { WireEnvelope, wrapEvent, wrapRpc } from "./wire-envelope";

/**
 * A minimal in-process pub/sub bus. Registration is synchronous; delivery is
 * deferred to a microtask to mimic a network hop (so `send()` awaits a real
 * asynchronous round-trip, exactly as a broker-backed transport would).
 */
export class MemoryBus {
  private readonly channels = new Map<string, Set<(message: string) => void>>();

  /** Subscribes `listener` to `channel`; returns an unsubscribe function. */
  subscribe(channel: string, listener: (message: string) => void): () => void {
    const set = this.channels.get(channel) ?? new Set<(message: string) => void>();
    set.add(listener);
    this.channels.set(channel, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  /** Publishes `message` to every subscriber of `channel`. Returns the subscriber count. */
  publish(channel: string, message: string): number {
    const set = this.channels.get(channel);
    if (!set || set.size === 0) return 0;
    for (const listener of [...set]) queueMicrotask(() => listener(message));
    return set.size;
  }
}

export interface InMemoryTransportOptions extends BaseTransportOptions {
  /** Shared bus for client↔server communication. Omit for a private loopback bus. */
  bus?: MemoryBus;
  /** Default RPC reply timeout, ms (per-call override via `send(..,{timeoutMs})`). Default 30_000. */
  rpcTimeoutMs?: number;
  /** Dead-letter failed fire-and-forget messages to `<topic><suffix>`. Default true. */
  enableDeadLetter?: boolean;
  /** Suffix appended to the topic for the dead-letter channel. Default `.dlq`. */
  deadLetterSuffix?: string;
}

const memoryOptionsSchema = z
  .object({
    bus: z.custom<MemoryBus>().optional(),
    rpcTimeoutMs: z.number().int().positive().optional(),
    enableDeadLetter: z.boolean().optional(),
    deadLetterSuffix: z.string().min(1).optional(),
    ...baseOptionsShape,
  })
  .passthrough();

/** The RPC reply envelope placed on the bus. */
interface MemoryRpcReply {
  correlationId: string;
  data: unknown;
}

/**
 * In-memory {@link ClientTransport} + {@link ServerTransport}. See the file header.
 */
export class InMemoryTransport extends BaseTransport implements ServerTransport, ClientTransport {
  public readonly capabilities: TransportCapabilities = { supportsRpc: true };

  private readonly bus: MemoryBus;
  private readonly rpcTimeoutMs: number;
  private readonly deadLetterEnabled: boolean;
  private readonly deadLetterSuffix: string;
  private readonly correlator = new RpcCorrelator();

  private handlers: Map<string, RawMessageHandler> | null = null;
  private readonly subscriptions: Array<() => void> = [];
  private inbox: string | null = null;
  private inboxSetup: Promise<string> | null = null;

  constructor(options: InMemoryTransportOptions = {}) {
    parseTransportOptions("InMemoryTransport", memoryOptionsSchema, options);
    super("InMemoryTransport", options);
    this.bus = options.bus ?? new MemoryBus();
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    this.deadLetterEnabled = options.enableDeadLetter ?? true;
    this.deadLetterSuffix = options.deadLetterSuffix ?? ".dlq";
  }

  protected async openConnection(): Promise<void> {
    // Nothing to dial — the bus is in-process. Re-subscribe the server topics if
    // this is a reconnect after a `teardown()` cleared them.
    if (this.handlers) this.subscribeTopics(this.handlers);
  }

  private subscribeTopics(handlers: Map<string, RawMessageHandler>): void {
    for (const topic of handlers.keys()) {
      this.subscriptions.push(this.bus.subscribe(topic, (msg) => this.onServerMessage(topic, msg)));
    }
  }

  private onServerMessage(topic: string, message: string): void {
    const handler = this.handlers?.get(topic);
    if (!handler) return;

    let envelope: WireEnvelope;
    try {
      // Size-guard + verify the signature (a no-op without a signer), then read the
      // explicit kind discriminator — never the payload's shape (SF2, audit L2).
      envelope = this.readWire(message);
    } catch (err) {
      void this.deadLetter(topic, message, err);
      return;
    }

    if (envelope.k === "rpc") {
      const headers = { ...(envelope.h ?? {}) };
      if (envelope.c) headers[CORRELATION_HEADER] = envelope.c;
      const ctx = new RpcContext("memory", topic, envelope.r, headers, envelope.c);
      // RPC failures are handled by the builder (error envelope → caller); catch
      // only so a rejection is never unhandled.
      const run = Promise.resolve()
        .then(() => handler(envelope.d, ctx))
        .catch((err: unknown) => {
          this.logger.error(`InMemoryTransport: RPC handler error on ${topic} — ${errMessage(err)}`);
        });
      void this.trackInflight(run);
    } else {
      const ctx = new RpcContext("memory", topic);
      const run = Promise.resolve()
        .then(() => handler(envelope.d, ctx))
        .catch((err: unknown) => this.deadLetter(topic, message, err));
      void this.trackInflight(run);
    }
  }

  private onReply(message: string): void {
    try {
      const reply = JSON.parse(this.verifyWire(message)) as MemoryRpcReply;
      this.correlator.deliver(reply.correlationId, reply.data);
    } catch (err) {
      this.logger.error(`InMemoryTransport: rejected RPC reply — ${errMessage(err)}`);
    }
  }

  /** Dead-letters a failed fire-and-forget message to `<topic><suffix>`. */
  private async deadLetter(topic: string, rawMessage: string, err: unknown): Promise<void> {
    this.logger.error(`InMemoryTransport: message on ${topic} failed — ${errMessage(err)}; dead-lettering`);
    if (!this.deadLetterEnabled) return;
    this.bus.publish(`${topic}${this.deadLetterSuffix}`, rawMessage);
  }

  /** Lazily establishes the per-client reply inbox on first `send()` (single-flight). */
  private async ensureInbox(): Promise<string> {
    if (this.inbox) return this.inbox;
    if (!this.inboxSetup) {
      this.inboxSetup = (async () => {
        const inbox = `mem:reply:${newCorrelationId()}`;
        this.subscriptions.push(this.bus.subscribe(inbox, (msg) => this.onReply(msg)));
        this.inbox = inbox;
        return inbox;
      })();
    }
    return this.inboxSetup;
  }

  public async listen(handlers: Map<string, RawMessageHandler>): Promise<void> {
    const topics = Array.from(handlers.keys());
    if (topics.length === 0) throw new Error("InMemoryTransport: no topics to listen to");
    this.handlers = handlers;
    await this.connect();
    // `openConnection` subscribes when handlers are already set (e.g. reconnect);
    // on the first `listen()` the handlers were just assigned, so subscribe now.
    if (this.subscriptions.length === 0) this.subscribeTopics(handlers);
  }

  public async connect(): Promise<void> {
    await super.connect();
  }

  public async emit(topic: string, data: unknown): Promise<void> {
    await this.connect();
    const wire = this.signWire(JSON.stringify(wrapEvent(data)));
    await this.trackInflight(Promise.resolve(this.bus.publish(topic, wire)).then(() => undefined));
  }

  public async send(topic: string, data: unknown, options?: SendOptions): Promise<unknown> {
    await this.connect();
    const replyTo = await this.ensureInbox();
    const correlationId = newCorrelationId();
    const timeoutMs = options?.timeoutMs ?? this.rpcTimeoutMs;
    const headers = { ...(options?.headers ?? {}), [CORRELATION_HEADER]: correlationId };

    const wire = this.signWire(JSON.stringify(wrapRpc(data, { replyTo, correlationId, headers })));
    const waiting = this.correlator.waitFor(correlationId, timeoutMs);
    this.bus.publish(topic, wire);
    return this.trackInflight(waiting);
  }

  public async reply(ctx: RpcContext, data: unknown): Promise<void> {
    if (!ctx.replyTo) return;
    await this.connect();
    const reply: MemoryRpcReply = { correlationId: ctx.correlationId ?? "", data };
    this.bus.publish(ctx.replyTo, this.signWire(JSON.stringify(reply)));
  }

  protected async teardown(): Promise<void> {
    this.correlator.rejectAll(new Error("InMemoryTransport: closing"));
    for (const unsub of this.subscriptions) unsub();
    this.subscriptions.length = 0;
    this.inbox = null;
    this.inboxSetup = null;
  }
}

/** Factory wrapper matching the package idiom. */
export function createInMemoryTransport(options?: InMemoryTransportOptions): InMemoryTransport {
  return new InMemoryTransport(options);
}

/**
 * Creates a `client` + `server` pair sharing one {@link MemoryBus} — the common
 * shape for a broker-free unit test (distinct client/server instances, as in real
 * usage). Any extra `options` apply to both.
 */
export function createInMemoryPair(
  options?: Omit<InMemoryTransportOptions, "bus">,
): { bus: MemoryBus; client: InMemoryTransport; server: InMemoryTransport } {
  const bus = new MemoryBus();
  return {
    bus,
    client: new InMemoryTransport({ ...options, bus }),
    server: new InMemoryTransport({ ...options, bus }),
  };
}
