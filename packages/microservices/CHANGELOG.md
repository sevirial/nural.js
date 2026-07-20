# @nuraljs/microservices

## 0.6.0

### Minor Changes

- **Aligned with `@nuraljs/core@^1.0.0`.** Version bumped to 0.6.0; the package stays pre-1.0 until the Redis/Kafka/RabbitMQ transports are verified against live brokers. The shared RPC/event/error logic (request-reply, fire-and-forget, error-envelope propagation, timeout) is exercised via the in-memory transport.

## 0.5.1

### Patch Changes

- Updated dependencies
  - @nuraljs/core@0.5.1

## 0.5.0

### Minor Changes

- **Explicit `kind` discriminator on the wire (security — audit finding L2). Breaking wire format.**

  Every message now travels in a discriminated envelope — `{ k: "evt", d }` for a fire-and-forget `emit()`, `{ k: "rpc", d, r?, c?, h? }` for a `send()` request (`r`=replyTo, `c`=correlationId, `h`=headers) — instead of the raw payload. Redis and the in-memory transport previously decided RPC-vs-event with the structural sniff `"replyTo" in parsed`, so an `emit()` whose **payload** happened to contain a `replyTo` field was served as an RPC request and the handler's return value published to that payload-chosen channel. With the payload one level down in `d`, its fields can never be read as routing metadata.

  The discriminator is applied **uniformly** to all four transports so inbound classification is explicit everywhere and no future transport can reintroduce the sniff. RabbitMQ, which classifies RPC by the AMQP `replyTo` _property_ rather than the body, keeps doing so (its properties are a separate channel a payload cannot reach) and Kafka stays event-only — an RPC envelope arriving there is now dead-lettered rather than silently served as an event.

  **Migration window.** Transports gained `acceptLegacyWire` (default **`true`** this release, flipping to `false` next major). Inbound accepts both the legacy un-enveloped format and the new one, while `emit`/`send` always **write** the new format — so a mixed fleet rolls without a flag-day. Note the legacy branch still classifies by the old heuristic, so finding L2 is only fully closed for legacy senders once you set `acceptLegacyWire: false`. Dead-letter payloads now carry the envelope; a consumer reading `.dlq` bytes should expect `d`. See MIGRATION.md.

## 0.4.0

### Minor Changes

- **Bound inbound message size before parsing (security — audit finding L4).** Every transport now accepts `maxMessageBytes` (default **1_048_576**, 1 MiB), enforced on each inbound message _before_ the signature is verified and _before_ `JSON.parse`. Previously a transport parsed wire bytes with no length cap, so a very large message could be deserialized straight into the worker's memory. The guard lives in the shared `BaseTransport.verifyWire`, which every inbound path funnels through, so Redis, RabbitMQ, Kafka, and the in-memory transport are all covered identically.

  An over-cap message is a permanent failure — `InvalidMessageError` with code `message_too_large` and `retryable: false` — so it takes the existing permanent-failure path: **dead-lettered immediately**, never retried (on RabbitMQ it does not consume a retry attempt), never handed to a handler. The error reports only the measured size and the configured limit; no payload bytes are logged.

  Additive and non-breaking, with one behavior change to note: **messages larger than 1 MiB now dead-letter instead of being parsed.** If you legitimately move payloads that large, raise `maxMessageBytes` or set it to `0` to disable the cap (leaving your broker's max-frame setting as the only bound). See MIGRATION.md.

## 0.3.0

### Minor Changes

- **Rebrand to the `@nuraljs/core` dependency (breaking).** The core dependency moves `nural` → `@nuraljs/core` and the sole core import (`Logger`) becomes `from "@nuraljs/core"`. The package now ships from the unified `nuraljs_packages` monorepo.

  **What to do.** Install `@nuraljs/core@^0.5.0` in place of `nural` and update any `from "nural"` import → `from "@nuraljs/core"`. No behavior, wire-format, or transport changes — this is a pure rename/port; see MIGRATION.md.

### Patch Changes

- Updated dependencies
  - @nuraljs/core@0.5.0

## 0.2.0

### Minor Changes

- Depend on the core by its real name **`nural`** (`^0.4.0`) instead of `@nuraljs/core`, migrate the peer dependency to **Zod 4** (`^4`), and move the broker libraries (`amqplib`, `ioredis`, `kafkajs`) to **optional peer dependencies**. **Breaking:** update imports to `nural`, upgrade to Zod 4, and install the broker peer(s) you use. See MIGRATION.md.
- RPC wire format changed (correlation + error envelope). Redis RPC payloads now carry `{ correlationId, headers }` and replies are matched on a per-client inbox by UUID correlation id; every RPC reply crosses the wire as a discriminated envelope `{ ok:true, data } | { ok:false, error }`. A throwing/invalid handler now returns a typed **`RpcRemoteError`** to the caller instead of timing out. **Breaking:** the RPC wire changed vs `0.1.0` — upgrade client and server together; catch `RpcRemoteError`/`RpcTimeoutError` instead of relying on timeouts. See MIGRATION.md.
- Transport interface changes. `ServerTransport.reply` is now `reply(ctx: RpcContext, data)` (was `reply(replyTo, data)`), and `capabilities: TransportCapabilities` is **required** on `ClientTransport`/`ServerTransport`. RPC over a transport with `supportsRpc: false` (Kafka) now fails fast with a typed `RpcUnsupportedError` at the call site. **Breaking for custom transports/direct `reply()` callers.** See MIGRATION.md.

### Patch Changes

- Additive (non-breaking): configurable RPC timeouts; **DLQ + bounded retry** replacing silent drops and RMQ infinite requeue; complete RMQ request/reply + multi-URL failover + prefetch; server-side response validation; idempotency keys (`IdempotencyStore`); shared reconnect-with-backoff lifecycle + graceful drain; optional `Telemetry` hook + trace-context propagation; optional HMAC message signing (`createSharedSecretSigner`); and a broker-free `InMemoryTransport` (`createInMemoryPair`) for tests. New exports: error taxonomy, `RpcContext`, `SendOptions`, `TransportCapabilities`, envelope/telemetry/signing/idempotency modules, `BaseTransport`.
