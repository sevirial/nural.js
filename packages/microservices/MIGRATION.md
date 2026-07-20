# Migration Guide — `@nuraljs/microservices`

## 0.4.0 → 0.5.0

**Breaking wire format** — but with a migration window, so you do **not** need a flag-day. Read this before rolling a fleet.

### The wire is now a discriminated envelope

Every message is wrapped in an envelope carrying an explicit `k` (kind) discriminator, instead of the raw payload:

| | `0.4.0` (legacy) | `0.5.0` (new) |
|---|---|---|
| `emit(topic, {userId:"u1"})` | `{"userId":"u1"}` | `{"k":"evt","d":{"userId":"u1"}}` |
| `send(topic, {n:21})` | `{"data":{"n":21},"replyTo":"inbox","correlationId":"cid","headers":{}}` | `{"k":"rpc","d":{"n":21},"r":"inbox","c":"cid","h":{}}` |
| RPC reply | `{"correlationId":"cid","data":{…}}` | unchanged |

**Why.** Redis and the in-memory transport used to classify a message as an RPC request with the structural sniff `"replyTo" in parsed`. Since `emit()` published the raw payload, a fire-and-forget event whose *data* contained a `replyTo` field was served as an RPC request and the handler's output published to that payload-chosen channel (security audit finding **L2** — reply-address injection). Now the payload lives one level down in `d`, so nothing inside it can be mistaken for routing metadata.

RabbitMQ's body is enveloped too, but it still classifies RPC by the AMQP `replyTo` **property** — a metadata channel a publisher's payload cannot reach, which is why RMQ was never confusable. Kafka is event-only; an RPC envelope arriving there is dead-lettered rather than served.

### What to do

**Nothing, to upgrade.** `acceptLegacyWire` defaults to `true` in `0.5.x`: a `0.5.0` peer **reads** both formats and **writes** only the new one, so `0.4.0` and `0.5.0` peers interoperate in both directions. Roll your fleet in any order.

**Then close the window.** Once every publisher is on ≥ `0.5.0`, set `acceptLegacyWire: false`:

```ts
createRedisTransport({ host, port, acceptLegacyWire: false });
```

This matters for security, not just tidiness: while the window is open, the legacy branch still classifies a **legacy sender's** message with the old `"replyTo" in payload` heuristic — so finding L2 remains reachable for un-upgraded publishers. Only `acceptLegacyWire: false` closes it completely. **The default flips to `false` in the next major**, so treat the window as temporary. With it closed, an un-enveloped message is rejected as `InvalidMessageError` (`invalid_envelope`, permanent) and dead-lettered.

### Two things that changed shape

1. **Dead-letter payloads carry the envelope.** `deadLetter` republishes the original wire bytes, which are now `{"k":"evt","d":{…}}`. If you have tooling that reads a `.dlq` channel/topic/queue and parses the payload directly, unwrap `d` (or use `parseWire`, exported from the package).
2. **Anything hand-crafting wire bytes** — a non-Nural publisher writing straight to a topic, a test fixture — must emit the envelope, or run against a transport with `acceptLegacyWire: true`. Use the exported `wrapEvent(data)` / `wrapRpc(data, meta)` helpers rather than hand-writing the shape.

---

## 0.3.0 → 0.4.0

**Additive and non-breaking**, with one behavior change worth knowing: **an inbound message larger than 1 MiB is now dead-lettered instead of parsed.** Every transport gained a `maxMessageBytes` option (default `1_048_576`), enforced before signature verification and `JSON.parse`. No wire-format change — a `0.3.0` peer and a `0.4.0` peer interoperate.

**What to do.** Nothing, unless you legitimately move payloads over 1 MiB across the bus. If you do, either raise the cap (`maxMessageBytes: <bytes>`) or set `maxMessageBytes: 0` to disable it — otherwise those messages will start landing in your DLQ. Payloads that big are usually better stored out-of-band with a reference on the wire.

**The cap applies to RPC replies too**, not just requests — an inbound reply is untrusted wire input like any other. A reply larger than the *caller's* `maxMessageBytes` is rejected, so that `send()` rejects with `RpcTimeoutError` instead of resolving. If any of your RPCs return responses over 1 MiB, raise the cap **on the client transport** as well as the server's.

`@nuraljs/auth` gained the equivalent `maxTokenBytes` bound (default 8 KiB) on `createBinaryTokenEngine`; a real claims token is a few hundred bytes, so this only rejects absurd input.

---

## 0.2.0 → 0.3.0

A **pure rename/port** as the ecosystem unified under the `@nuraljs/*` family. No behavior, RPC-wire, or transport changes — only the core dependency's name moved. It is a **breaking republish** (dependency name changed), hence the minor bump.

### 1. Core dependency renamed: `nural` → `@nuraljs/core`

**What changed.** The core, previously published as `nural`, is now `@nuraljs/core` (`^0.5.0`), shipped from the unified monorepo. The sole core import here (`Logger`) now resolves through `@nuraljs/core`.

**What to do.**
- Replace `nural` with `@nuraljs/core@^0.5.0` in your dependencies.
- Update any `import … from "nural"` → `import … from "@nuraljs/core"`.

Nothing else changes — contracts, transports, the RPC wire format, DLQ/retry, signing, and telemetry are all identical to `0.2.0`. Peers on `0.2.0` and `0.3.0` interoperate on the wire (only the package name differs).

---

## 0.1.0 → 0.2.0

This release completes and hardens the `0.1.0` prototype: RPC now works across transports, failures are typed and never lost, poison messages are dead-lettered, and the wire is observable + optionally signed. It contains **breaking changes** — most importantly, the **RPC wire format changed twice** (Sprints 8 and 9), so a `0.1.0` peer cannot do RPC with a `0.2.0` peer. **Upgrade client and server together.**

Each item is *what changed → what to do*.

---

### 1. Core dependency renamed: `@nuraljs/core` → `nural`

**What changed.** Depends on the core by its real name **`nural`** (`^0.4.0`). Previously only `Logger` was imported from the (nonexistent-on-registry) `@nuraljs/core`.

**What to do.** Install `nural@^0.4.0`; update any `@nuraljs/core` import to `nural`.

### 2. Zod 3 → Zod 4 (peer dependency)

**What changed.** `peerDependencies.zod` is now `^4.0.0`.

**What to do.** Upgrade your app to **Zod 4**. Contracts (`defineContract({ request, response })`) must be Zod 4 schemas. The API used (`.parse`, `z.infer`, `ZodTypeAny`) is unchanged.

### 3. Brokers are now optional peer dependencies

**What changed.** `amqplib`, `ioredis`, and `kafkajs` moved from hard dependencies to **optional peer dependencies**. A transport throws a clear, actionable error at connect if its broker lib isn't installed.

**What to do.** Install only the broker(s) you use:
```bash
npm install ioredis      # RedisTransport
npm install amqplib      # RmqTransport
npm install kafkajs      # KafkaTransport
```

### 4. `ServerTransport.reply` signature changed

**What changed.** `reply?(replyTo: string, data)` → **`reply?(ctx: RpcContext, data)`**. The builder now passes the full context so the transport can route the reply by `ctx.replyTo` + `ctx.correlationId`.

**What to do.** If you have a **custom transport** or call `reply()` directly, pass the `RpcContext`:
```ts
// before:
await transport.reply(ctx.replyTo, data);
// after:
await transport.reply(ctx, data);
```

### 5. `capabilities` is now required on custom transports

**What changed.** `ClientTransport` / `ServerTransport` must declare `readonly capabilities: TransportCapabilities` (`{ supportsRpc: boolean }`). `RpcClient.send` fails fast with a typed `RpcUnsupportedError` when `supportsRpc` is false (this is how Kafka now rejects RPC at wiring time instead of throwing deep in a call).

**What to do.** Add `capabilities` to any custom transport:
```ts
readonly capabilities: TransportCapabilities = { supportsRpc: true };
```

### 6. Redis RPC wire format changed (correlation)

**What changed.** The Redis RPC request/reply payloads gained correlation + headers:
- request: `{ data, replyTo }` → **`{ data, replyTo, correlationId, headers }`**
- reply: `<raw value>` → **`{ correlationId, data }`**

Replies now arrive on a per-client, unguessable reply **inbox** and are matched by `correlationId` (correlation ids are UUIDs, not `Math.random`).

**What to do.** Nothing in application code (the transport handles it) — but a `0.1.0` Redis client/server **cannot** interoperate with a `0.2.0` one. Upgrade both sides together.

### 7. RPC reply is now a discriminated envelope

**What changed.** Every RPC reply crosses the wire as an envelope (created by `MicroserviceBuilder`, decoded by `RpcClient`; transports carry it opaquely):
```jsonc
{ "ok": true,  "data": <validated response> }
{ "ok": false, "error": { "code": <stable>, "message": <secret-free> } }
```
A throwing/invalid handler no longer makes the caller **time out** — the client rehydrates `ok:false` into a typed **`RpcRemoteError`** (`err.remoteCode` ∈ `handler_error` | `invalid_request` | `invalid_response` | a custom code the handler threw).

**What to do.** In application code, `client.send(...)` still returns the typed response on success. Update any error handling to catch **`RpcRemoteError`** (and `RpcTimeoutError` / `RpcUnsupportedError`) instead of relying on timeouts. This envelope is a wire break vs `0.1.0` (Sprint 8) — upgrade peers together.

### 8. Kafka RPC fails fast (behavior change)

**What changed.** `RpcClient.send` over a Kafka transport throws **`RpcUnsupportedError` at the call site**, before any network work (driven by `capabilities.supportsRpc: false`), instead of throwing from deep inside the transport at call time.

**What to do.** Use `emit` for Kafka (event streaming); use Redis or RMQ for RPC. Catch `RpcUnsupportedError` if you probe capabilities dynamically.

---

## Additive (non-breaking) in this release

- **Configurable timeouts** — `send(.., { timeoutMs })` + per-client `rpcTimeoutMs`; typed `RpcTimeoutError`.
- **DLQ + bounded retry** — `maxRetries`, `deadLetterExchange`/`deadLetterQueue` (RMQ), `enableDeadLetter`/`deadLetterSuffix` (Redis/Kafka). Replaces silent drops and RMQ's infinite requeue. See [RELIABILITY.md](./RELIABILITY.md).
- **RMQ RPC** now fully implemented (reply queue + `correlationId`); RMQ multi-URL failover + `prefetch`.
- **Idempotency keys** — `send(.., { idempotencyKey })` + `IdempotencyStore` / `MemoryIdempotencyStore`.
- **Server-side response validation** — the server refuses to reply with a contract-invalid response (unlisted fields stripped).
- **Reconnect** — shared exponential-backoff-with-jitter lifecycle; graceful `close()` that drains in-flight work.
- **Observability** — optional `Telemetry` hook (spans + latency/in-flight/errors/retries) + trace-context propagation, no-op by default.
- **Wire signing** — optional `createSharedSecretSigner` (HMAC-SHA256) rejects tampered/forged messages. See [SECURITY.md](./SECURITY.md).
- **`InMemoryTransport`** — broker-free transport for fast unit tests (`createInMemoryPair`).
- New exports: the error taxonomy, `RpcContext`, `SendOptions`, `TransportCapabilities`, `CORRELATION_HEADER`, envelope/telemetry/signing/idempotency modules, `BaseTransport`.

## Rollout checklist

1. Upgrade the app to **Zod 4** and install **`nural@^0.4.0`** + the broker peer(s) you use.
2. Update custom transports: `reply(ctx, data)` signature + required `capabilities`.
3. Replace timeout-based RPC error handling with typed errors (`RpcRemoteError` / `RpcTimeoutError` / `RpcUnsupportedError`).
4. Move any RPC-over-Kafka to `emit` (or to Redis/RMQ).
5. **Upgrade all peers together** — the RPC wire format changed; mixed `0.1.0`/`0.2.0` fleets won't interoperate on RPC.
