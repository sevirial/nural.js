# Reliability & Delivery Semantics (`@nuraljs/microservices`)

Sprint 9 makes the RPC/message path fail safely: **no lost errors, no poison
loops.** This document is the contract for how failures are handled and what
delivery guarantees each transport gives.

## RPC error envelope

Every RPC reply crosses the wire as a discriminated envelope (created by the
`MicroserviceBuilder`, consumed by the `RpcClient`; transports carry it opaquely):

```jsonc
// success
{ "ok": true, "data": <the validated response> }
// failure
{ "ok": false, "error": { "code": "<stable code>", "message": "<secret-free>" } }
```

A failing handler no longer makes the caller **time out** — the client rehydrates
the error envelope into a typed [`RpcRemoteError`](./src/errors.ts) whose
`remoteCode` is the server-assigned code:

| `remoteCode`       | Meaning                                                             |
|--------------------|--------------------------------------------------------------------|
| `handler_error`    | The handler threw. Its `.message` is propagated (no stack traces).  |
| `invalid_request`  | The inbound payload failed `contract.request` validation.           |
| `invalid_response` | The handler returned a value failing `contract.response` — **the server refuses to put it on the wire** (no data leaks). |
| *custom*           | The handler threw an error carrying a stable string `code`.         |

```ts
try {
  await client.send(contract, data);
} catch (err) {
  if (err instanceof RpcRemoteError && err.remoteCode === "quota_exceeded") { /* … */ }
}
```

> **Security:** stack traces are never placed on the wire. Handler authors must
> not put secrets in thrown error messages — the message is propagated verbatim.

The server also **validates its outgoing response** against `contract.response`
before replying (and sends the validated value, so unlisted fields are stripped).

## Dead-letter queues & retry (poison-message handling)

A **fire-and-forget** message whose handler fails no longer loops forever or is
silently dropped. RPC failures are delivered to the caller (above) and acked —
never retried.

| Transport | Delivery      | Retry on failure                         | Dead-letter destination                          |
|-----------|---------------|------------------------------------------|--------------------------------------------------|
| **RMQ**   | at-least-once | republish with `x-retry-count`++ up to `maxRetries` (default 3) | fanout DLX `<queue>.dlx` → queue `<queue>.dlq`, with `x-death-reason` |
| **Redis** | at-most-once  | none (pub/sub has no redelivery)         | republished to channel `<topic>.dlq` (a subscriber must be listening) |
| **Kafka** | at-least-once | kafkajs producer/consumer retries        | produced to topic `<topic>.dlq`, offset committed (partition never stalls) |

**Permanent failures** (schema-invalid / malformed-JSON / oversize /
unrecognized-envelope messages) skip retry and are dead-lettered immediately — a
retry would fail identically.

Dead-lettered bytes are the **original wire envelope**, so a `.dlq` consumer reads
`{ "k": "evt", "d": <the payload> }` — unwrap `d`, or use the exported
`parseWire`. See [Wire envelope](./README.md#wire-envelope-emit-vs-send).

**RMQ topology** (asserted at connect):

```
<queue>            ── consumed by the worker
<queue>.dlx        ── fanout exchange (durable)
<queue>.dlq        ── durable queue bound to <queue>.dlx
```

On a failed fire-and-forget delivery the message is republished to `<queue>` with
`x-retry-count` incremented and the original acked; once the count reaches
`maxRetries` it is published to the DLX (→ DLQ) and acked. Because the original
is always acked, a poison message **cannot requeue-loop**. Configurable via
`maxRetries`, `deadLetterExchange`, `deadLetterQueue`.

Redis (`enableDeadLetter`, `deadLetterSuffix`) and Kafka (`enableDeadLetter`,
`deadLetterTopicSuffix`) expose the same opt-outs/names.

## Inbound message-size cap

Every transport bounds an inbound message at `maxMessageBytes` (default
**1_048_576** — 1 MiB) *before* it verifies the signature and *before* it parses
the JSON, so an oversize payload is never deserialized into the worker's memory.
The guard lives in the shared `BaseTransport.verifyWire`, which every transport's
inbound path funnels through, so the bound is identical on Redis, RMQ, Kafka, and
the in-memory transport.

An over-cap message throws `InvalidMessageError("message_too_large")` with
`retryable: false`, so it takes the **permanent-failure** path above: dead-lettered
immediately, never retried (on RMQ it does not consume a retry attempt), never
handed to a handler. The error reports only the measured size and the limit — no
payload bytes.

```ts
new RedisTransport({ host, port, maxMessageBytes: 1_048_576 }); // default
new RedisTransport({ host, port, maxMessageBytes: 0 });         // opt out entirely
```

Setting `0` disables the cap; the broker's own max-frame limit is then the only
bound. Raise the cap for legitimately large payloads — though a multi-MiB message
is usually better stored out-of-band with a reference on the wire.

## Wire envelope & the legacy window

Inbound classification reads the envelope's explicit `k` discriminator
(`{ k: "evt", d }` vs `{ k: "rpc", d, r, c, h }`), so an event is never served as
an RPC request because of what its payload contains. A missing/unrecognized `k` is
a permanent failure (`invalid_envelope`) → dead-lettered.

`0.5.0` introduced this format. During the `0.5.x` window `acceptLegacyWire`
defaults to `true`, so a transport **reads** both the legacy and new formats while
**writing** only the new one — `0.4.x` and `0.5.x` peers interoperate and a fleet
rolls in any order. Set `acceptLegacyWire: false` once every publisher is on
≥ `0.5.0` (it also closes the last of audit finding L2); the default flips next
major. See [MIGRATION.md](./MIGRATION.md).

## Idempotency (optional)

At-least-once transports can redeliver. Attach an idempotency key:

```ts
await client.send(contract, data, { idempotencyKey: "order-42" });
```

It is propagated on the wire as `x-idempotency-key`. A builder given an
`IdempotencyStore` records each key's outcome and, on a **duplicate delivery**,
replays it without re-running the handler (RPC → the cached reply is re-sent;
emit → the delivery is skipped). Only outcomes of messages processed to
completion are recorded, so the retry/DLQ path is never short-circuited.

```ts
import { createMicroservice, MemoryIdempotencyStore } from "@nuraljs/microservices";

createMicroservice({
  transport,
  idempotency: new MemoryIdempotencyStore(), // in-process, bounded; supply your own for a fleet
});
```

`MemoryIdempotencyStore` is per-worker and bounded (oldest evicted). For
horizontally-scaled dedup, implement the tiny `IdempotencyStore` interface over a
shared store (e.g. Redis).
