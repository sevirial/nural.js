# @nuraljs/microservices

> Contract-first RPC and message brokers for NuralJS — Zod contracts on the wire, pluggable transports, typed reliability.

![version](https://img.shields.io/badge/version-0.6.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

A lightweight, contract-first RPC and message-broker layer for the [NuralJS](https://nuraljs.org) framework. Define a strongly-typed network boundary once with a Zod contract, share it between client and server, and let the transport validate every payload on the wire — in both directions. Ships with pluggable transports for Redis, RabbitMQ, and Kafka (each an optional peer dependency), a typed error envelope, DLQ + bounded retry, UUID correlation, configurable timeouts, and a broker-free in-memory transport for tests.

## Features

- **Contract-first RPC & pub/sub** — `defineContract` describes a `topic`, a `request` schema, and a `response` schema; `send` does request/reply, `emit` is fire-and-forget.
- **Zod-validated wire contracts** — the client validates outgoing data, and the server validates the incoming request *and* its own response before replying, so unlisted fields never leak.
- **Pluggable transports** — Redis and RabbitMQ support full request/reply RPC + pub/sub; Kafka is event-streaming (`emit` only, `supportsRpc: false`) and fails RPC wiring fast with a typed error. An in-memory transport mirrors the real ones for tests.
- **Typed error envelope** — a throwing handler doesn't make the caller time out: the failure crosses the wire as `{ ok: false, error: { code, message } }` and rehydrates into a typed `RpcRemoteError` (with a stable `remoteCode`). Success is `{ ok: true, data }`.
- **UUID correlation IDs** — replies are matched to their pending call by an unguessable correlation id over a pooled per-client reply inbox.
- **Request/reply timeouts** — per-call (`send(.., { timeoutMs })`) or per-client (`rpcTimeoutMs`), surfaced as a typed `RpcTimeoutError`.
- **Reconnect with backoff** — every transport shares one connection state machine with exponential backoff + jitter, plus a graceful `close()` that drains in-flight work before tearing down.
- **DLQ / bounded retry** — poison and schema-invalid messages are dead-lettered (RabbitMQ: bounded `maxRetries` then a dead-letter exchange/queue; Redis/Kafka: a `.dlq` channel/topic) instead of being silently dropped or requeued forever.
- **Bounded inbound messages** — every transport rejects a message over `maxMessageBytes` (default 1 MiB) *before* parsing it, so an oversize payload is dead-lettered rather than deserialized into memory.
- **Explicit wire envelope** — every message declares its kind (`{ k: "evt", d }` vs `{ k: "rpc", d, r, c, h }`), so an event is never mistaken for an RPC request because of what its payload happens to contain.
- **Idempotency keys** — `send(.., { idempotencyKey })` + an `IdempotencyStore` replays a recorded outcome for a duplicate delivery.
- **Optional wire signing & telemetry** — HMAC-SHA256 shared-secret message signing and a pluggable `Telemetry` hook (spans + latency/in-flight/error/retry metrics with trace-context propagation), both off by default with zero imposed dependencies.

## Installation

Install the package and Zod, then add only the broker client(s) you actually use — brokers are **optional peer dependencies**.

```bash
# pnpm
pnpm add @nuraljs/microservices zod
pnpm add ioredis    # Redis transport
pnpm add amqplib    # RabbitMQ transport
pnpm add kafkajs    # Kafka transport
```

```bash
# npm
npm install @nuraljs/microservices zod
npm install ioredis    # Redis transport
npm install amqplib    # RabbitMQ transport
npm install kafkajs    # Kafka transport
```

## Quick start

Define a contract once and share it between client and server:

```ts
import { defineContract } from "@nuraljs/microservices";
import { z } from "zod";

export const doubler = defineContract({
  topic: "math.double",
  request: z.object({ n: z.number() }),
  response: z.object({ result: z.number() }),
});
```

**Server** — a microservice worker that registers a typed handler:

```ts
import { createMicroservice, RedisTransport } from "@nuraljs/microservices";

const service = createMicroservice({
  transport: new RedisTransport({ host: "localhost", port: 6379 }),
}).handler(doubler, async ({ request }) => {
  return { result: request.n * 2 };
});

await service.listen();
```

**Client** — an RPC caller:

```ts
import { createRpcClient, RedisTransport } from "@nuraljs/microservices";

const client = createRpcClient({
  transport: new RedisTransport({ host: "localhost", port: 6379 }),
});
await client.connect();

const { result } = await client.send(doubler, { n: 21 }); // → { result: 42 }, fully typed

// fire-and-forget:
await client.emit(doubler, { n: 10 });
```

`inject` on `createMicroservice` passes services into every handler (`async ({ request, context, ...services })`), and `context` is the `RpcContext` (protocol, topic, correlation id, propagated headers).

## Contracts

A contract is the single source of truth for a network boundary — its `topic` names the channel, and its `request` / `response` Zod schemas type both ends of the call:

```ts
const createUser = defineContract({
  topic: "users.create",
  request: z.object({ email: z.string().email(), name: z.string() }),
  response: z.object({ id: z.string() }),
});
```

TypeScript enforces that `client.send(createUser, data)` receives a matching `data` and returns the declared response type. At runtime the client parses the request before sending, and the server parses the request on arrival and its own response before replying — so a contract-invalid response is refused rather than put on the wire, and any unlisted fields are stripped. A contract with no `response` (defaults to `z.void()`) is emit-only.

## Transports

Each transport implements both `ClientTransport` and `ServerTransport` and declares its `capabilities`. All share the same lifecycle: connect + **reconnect with exponential backoff + jitter**, a graceful `close()` that **drains in-flight** work, a **bounded inbound message size** (`maxMessageBytes`), the same **discriminated wire envelope**, and Zod-validated constructor options.

| Transport | RPC (`send`) | Delivery | Notes |
|-----------|:---:|----------|-------|
| `RedisTransport` | ✅ | at-most-once | Pooled per-client reply inbox, correlation-bound replies, `.dlq` channel. |
| `RmqTransport` | ✅ | at-least-once | Multi-URL failover, prefetch backpressure, bounded retry → dead-letter exchange/queue (DLX/DLQ). |
| `KafkaTransport` | ❌ (`supportsRpc: false`) | at-least-once | Event-streaming; `emit` only — RPC fails fast at the call site with `RpcUnsupportedError`. Configurable concurrency + `.dlq` topic. |
| `InMemoryTransport` | ✅ | in-process | Broker-free; mirrors the real correlation, envelope, DLQ, signing, and drain paths for unit tests. Use `createInMemoryPair()` for a wired client/server. |

Kafka is honest about its model: because it has no native request/reply, `supportsRpc` is `false` and the `RpcClient` rejects an RPC over it *before* any network work. Use `emit` for Kafka.

### Wire envelope: `emit` vs `send`

Every message travels in an envelope whose `k` field declares its kind. The payload you pass to `emit`/`send` is carried in `d`, one level below the routing metadata:

```jsonc
// emit(topic, { userId: "u1" }) — fire-and-forget
{ "k": "evt", "d": { "userId": "u1" } }

// send(topic, { n: 21 }) — request expecting a reply
{ "k": "rpc", "d": { "n": 21 }, "r": "<replyTo>", "c": "<correlationId>", "h": { } }
```

This is a **routing contract, not a suggestion**: a server decides event-vs-request from `k` alone. Because your payload sits in `d`, a field inside it named `replyTo` (or `k`, or anything else) is just data — it cannot redirect a handler's output. Before `0.5.0`, Redis and the in-memory transport inferred RPC from `"replyTo" in payload`, so an emitted event carrying that field was answered as an RPC (audit finding **L2**). RabbitMQ carries the RPC metadata in the native AMQP `replyTo`/`correlationId` properties and classifies on those — a separate channel your payload cannot reach — so its body carries only `k` + `d`. Kafka is event-only: an RPC envelope arriving there is dead-lettered.

RPC **replies** are not enveloped: they arrive on a private, unguessable per-client inbox and are matched by correlation id, so there is no kind to disambiguate.

`wrapEvent(data)`, `wrapRpc(data, meta)`, and `parseWire(raw, acceptLegacy?)` are exported for tooling that reads or writes raw wire bytes (e.g. a DLQ inspector — dead-lettered bytes are the original envelope, so unwrap `d`).

#### Migrating from a pre-0.5.0 fleet

`0.5.0` changed this wire format. To avoid a flag-day, every transport takes `acceptLegacyWire` (default **`true`** for `0.5.x`): inbound accepts both the legacy un-enveloped format and the new one, while `emit`/`send` always **write** the new one — so peers on either version interoperate and you can roll in any order.

```ts
const transport = new RedisTransport({
  host: "localhost",
  port: 6379,
  acceptLegacyWire: false, // close the window once every publisher is on ≥ 0.5.0
});
```

Close it as soon as you can, and treat it as temporary — **the default flips to `false` next major**. The legacy branch necessarily still classifies legacy senders with the old `"replyTo" in payload` heuristic, so finding L2 stays reachable for un-upgraded publishers until you set `acceptLegacyWire: false`. With the window closed, an un-enveloped message is a permanent failure (`InvalidMessageError`, code `invalid_envelope`) and is dead-lettered. See [MIGRATION.md](./MIGRATION.md).

### Message-size cap

Every transport accepts `maxMessageBytes` (default **1 MiB**), enforced on each inbound message *before* the signature is verified and *before* `JSON.parse` — so an oversize payload is never deserialized into memory:

```ts
const transport = new RedisTransport({
  host: "localhost",
  port: 6379,
  maxMessageBytes: 1_048_576, // default: 1 MiB; 0 disables the cap
});
```

An over-cap message is a permanent failure (`InvalidMessageError`, code `message_too_large`, `retryable: false`) and is **dead-lettered immediately** — never retried, never passed to a handler. On RabbitMQ it bypasses the retry budget and goes straight to the DLX; Redis, Kafka, and the in-memory transport publish it to the `.dlq` channel/topic. Setting `maxMessageBytes: 0` opts out entirely, leaving your broker's max-frame setting as the only bound.

The cap bounds **RPC replies** too — a reply is inbound wire input like any other. A reply exceeding the *caller's* cap is rejected, so that `send()` rejects with `RpcTimeoutError`. If an RPC legitimately returns more than 1 MiB, raise the cap on the client transport as well as the server's.

### Testing without a broker

```ts
import { createInMemoryPair, createMicroservice, createRpcClient } from "@nuraljs/microservices";

const { client, server } = createInMemoryPair();

const service = createMicroservice({ transport: server })
  .handler(doubler, async ({ request }) => ({ result: request.n * 2 }));
await service.listen();

const rpc = createRpcClient({ transport: client });
await rpc.connect();

await rpc.send(doubler, { n: 21 }); // → { result: 42 }
```

## Error handling & reliability

- **Typed error taxonomy.** RPC failures are programmatically distinguishable via a stable `code`: `RpcTimeoutError` (`rpc_timeout`), `RpcUnsupportedError` (`rpc_unsupported`), and `RpcRemoteError` (`rpc_remote`, with the server-assigned `remoteCode` such as `handler_error` / `invalid_request` / `invalid_response`). `isRpcError(err)` narrows any of them.
- **Error envelope.** A remote handler throw or a validation failure is caught server-side, sent back as `{ ok: false, error: { code, message } }`, and rehydrated on the client into `RpcRemoteError` — so a failed `send()` rejects with a typed error instead of hanging until timeout. Stack traces are never placed on the wire.
- **Timeouts.** Configure per call (`send(contract, data, { timeoutMs })`) or per client (`rpcTimeoutMs`, default 30s). A lapsed request rejects with `RpcTimeoutError`.
- **DLQ & bounded retry.** A schema-invalid message is a permanent failure (`InvalidMessageError`, `retryable: false`) routed straight to the dead-letter destination. A transient fire-and-forget failure is retried up to `maxRetries` (RabbitMQ) then dead-lettered; Redis/Kafka route failures to a `.dlq` channel/topic.
- **Bounded inbound size.** A message larger than `maxMessageBytes` (default 1 MiB) is rejected before signature verification and parsing — `message_too_large`, permanent, dead-lettered. `0` disables the cap. See [Message-size cap](#message-size-cap).
- **Explicit message kind.** A message whose envelope has no `k`, or an unrecognized one, is a permanent failure (`invalid_envelope`) and is dead-lettered — routing is never guessed from the payload's shape. See [Wire envelope](#wire-envelope-emit-vs-send).
- **Reconnect & graceful shutdown.** Connections self-heal with backoff + jitter; `close()` drains in-flight operations (bounded by `drainTimeoutMs`) before disconnecting, so no reply or publish is dropped mid-flight.
- **Idempotency.** With an `IdempotencyStore` (e.g. `MemoryIdempotencyStore`) and an `idempotencyKey`, a duplicate delivery replays the recorded reply without re-running the handler.

## Requirements

- **Node ≥ 24**
- **Zod 4** (`zod@^4`, peer dependency)
- **[`@nuraljs/core`](https://github.com/ErrorX407/nural)**
- A broker client for the transport you use — `ioredis`, `amqplib`, or `kafkajs` — each an **optional peer dependency** (install only what you use; the in-memory transport needs none).

## Further reading

- **[RELIABILITY.md](./RELIABILITY.md)** — connection, retry, DLQ, and graceful-shutdown semantics in depth.
- **[SECURITY.md](./SECURITY.md)** — wire signing, payload validation, and the threat model.
- **[MIGRATION.md](./MIGRATION.md)** — upgrade notes between versions.
- **[CHANGELOG.md](./CHANGELOG.md)** — release history.

## Ecosystem

Part of the [NuralJS](https://nuraljs.org) ecosystem:

| Package | Description |
| --- | --- |
| [`@nuraljs/core`](https://github.com/ErrorX407/nural) | Schema-first, Fastify-native REST framework |
| [`@nuraljs/cli`](https://github.com/ErrorX407/nural) | Project scaffolding & dev tooling (`nuraljs`) |
| [`@nuraljs/testing`](https://github.com/ErrorX407/nural) | Test harness — drive routes through the real adapter |
| [`@nuraljs/auth`](https://github.com/ErrorX407/nural-auth) | Functional auth: binary tokens, KMS, OAuth, RBAC/ABAC |
| **[`@nuraljs/microservices`](https://github.com/ErrorX407/nural-microservices)** | Contract-first RPC & message brokers |

## Documentation

Full documentation at **[nuraljs.org/docs](https://nuraljs.org/docs)**.

## License

[MIT](./LICENSE) © Chetan Joshi
