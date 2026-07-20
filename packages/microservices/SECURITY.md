# Wire Security & Observability (`@nuraljs/microservices`)

Sprint 10 hardens the wire: unified structured logging, optional distributed
tracing + metrics behind a no-op default, trace-context propagation, optional
message signing / shared-secret authentication, and reply-channel binding. None
of it is on by default — a transport with no `telemetry` and no `signer` behaves
exactly as before, at zero cost.

## Message signing / shared-secret authentication

Brokers rarely authenticate *individual messages*. A `MessageSigner` wraps every
outgoing wire string in a signed envelope and verifies + unwraps every incoming
one, **rejecting** any message whose signature is missing, forged (wrong secret),
or tampered (bytes changed in flight). A rejected message is a permanent failure
(`InvalidMessageError`, `retryable: false`) so the transport dead-letters it — it
is never processed and never retried.

```ts
import { createSharedSecretSigner, RedisTransport } from "@nuraljs/microservices";

const signer = createSharedSecretSigner({
  secret: process.env.RPC_SHARED_SECRET!, // 32+ random bytes, distributed out of band
  maxAgeMs: 30_000,                        // optional replay window (0 = disabled)
});

// Every peer that must interoperate uses the SAME secret.
const transport = new RedisTransport({ host, port, signer });
```

**Scheme.** HMAC-SHA256 over `` `${version}.${timestamp}.${payload}` ``, compared
in constant time (`crypto.timingSafeEqual`). The wire envelope is
`{ v, alg: "HS256", ts, payload, sig }` (`sig` base64). `v` is a real negotiation
point reserved for algorithm/secret rotation. `maxAgeMs > 0` rejects envelopes
older than the window, bounding replay.

Signing is wired uniformly into all three transports (Redis, RMQ, Kafka) at the
publish/consume boundary via `BaseTransport.signWire` / `verifyWire`, so it covers
`emit`, RPC `send`, and RPC `reply`. It is **format-agnostic** — it signs the
serialized string a transport already puts on the wire — and orthogonal to the
Sprint 9 RPC error envelope (which rides *inside* the signed payload).

### Signing vs. TLS/mTLS — use both

Signing authenticates and integrity-protects each **message**. It does **not**
encrypt (payloads are plaintext inside the envelope) and does not authenticate the
**connection**. For confidentiality and mutual authentication of the transport
connection, terminate TLS/mTLS at the broker — they are complementary:

- **Redis:** enable TLS (`rediss://` / `tls` options) and Redis AUTH/ACLs; for
  mutual auth, present a client certificate the server trusts.
- **RabbitMQ:** enable the AMQP TLS listener (`amqps://…`) and turn on
  `ssl_options.verify = verify_peer` + `fail_if_no_peer_cert` for mTLS; scope
  users with vhost permissions.
- **Kafka:** `security.protocol = SSL` (or `SASL_SSL`) with a client keystore for
  mTLS; restrict topic access with ACLs.

Terminate TLS for confidentiality + connection auth; layer signing on top for
end-to-end per-message integrity across hops/proxies the TLS session doesn't span.

## Inbound message-size cap

Every transport rejects an inbound message larger than `maxMessageBytes`
(default **1 MiB**) *before* verifying its signature and *before* `JSON.parse` —
so an attacker who can publish to a topic cannot force the worker to deserialize
an arbitrarily large payload into memory. Ordering matters: the size guard runs
first precisely because verification and parsing are the expensive steps a huge
message would otherwise weaponize.

The guard sits in the shared `BaseTransport.verifyWire`, so it applies uniformly
to Redis, RabbitMQ, Kafka, and the in-memory transport. An over-cap message is a
permanent failure (`InvalidMessageError`, code `message_too_large`,
`retryable: false`) and is dead-lettered immediately — never retried, never
handed to a handler. The error carries only the measured size and the configured
limit; no payload bytes reach the log.

`maxMessageBytes: 0` disables the cap. Only opt out when your broker enforces its
own max-frame limit — otherwise you are back to an unbounded parse. Note that
brokers bound the frame, not your parse, so the two are complementary.

See [RELIABILITY.md](./RELIABILITY.md#inbound-message-size-cap) for the
delivery/DLQ semantics.

## Explicit message kind on the wire (no payload sniffing)

A message's kind — fire-and-forget event vs RPC request — is declared explicitly
by the `k` field of its envelope (`{ k: "evt", d }` / `{ k: "rpc", d, r, c, h }`),
never inferred from the payload's shape. Your payload rides in `d`, one level
below the routing metadata, so no field inside it can be read as routing.

This closes audit finding **L2**. Redis and the in-memory transport used to
classify with the structural sniff `"replyTo" in parsed` while `emit()` published
the raw payload — so an event whose data carried a `replyTo` field was served as
an RPC request and the handler's return value published to that payload-chosen
channel (reply-address injection / handler-output redirection). RabbitMQ was never
exposed: it classifies on the AMQP `replyTo` **property**, a metadata channel a
publisher's body cannot reach, and still does. Kafka is event-only and
dead-letters an RPC envelope rather than serving it. The discriminator is applied
uniformly all the same, so no transport can reintroduce the sniff.

An envelope with a missing or unrecognized `k` is a permanent failure
(`InvalidMessageError`, code `invalid_envelope`) and is dead-lettered. The error
never echoes the offending bytes — malformed envelopes are attacker-influenced
input, and echoing them would place them in your logs.

**During the `0.5.x` migration window** (`acceptLegacyWire`, default `true`),
inbound legacy un-enveloped messages are still accepted and classified by the old
heuristic, so L2 remains reachable **for legacy senders only** — a `0.5.0`
publisher's `emit` is always enveloped and always safe. Set
`acceptLegacyWire: false` once every publisher is upgraded to close it fully; the
default flips next major.

## Reply-channel binding (Redis)

RPC replies for a client arrive on a single **per-client, unguessable UUID inbox
channel** (`nural:reply:<uuid>`), and each reply is delivered **only** to the
pending call whose exact correlation id it carries — a reply bearing an
unknown/foreign correlation id is dropped, so a reply can only ever reach the
caller that issued it. With a `signer` configured, a reply's signature is verified
before it is even considered, so a forged reply published onto a known inbox is
rejected outright.

## Telemetry (tracing + metrics)

Pass an optional `telemetry` sink to `createRpcClient`, `createMicroservice`, and
(for retry metrics) each transport. It is behind a **no-op default** — with none
configured every hook does nothing.

- **Spans:** `microservice.client.send` (client kind) and
  `microservice.server.handle` (server kind).
- **Metrics:** `*.duration_ms` (latency), `*.in_flight` (gauge, ±1),
  `*.errors` (counter, with a `reason` attribute on the server:
  `invalid_request` / `handler_error` / `invalid_response`), and
  `microservice.retries` (counter, emitted by RMQ on each delivery retry).

Attributes are low-cardinality only (`topic`, `transport`) — **never** payloads,
headers, or secrets.

### Trace-context propagation

Trace context rides on `RpcContext.headers` — the same map that carries the
correlation id. The client span receives the outgoing headers as its `carrier` and
should **inject** trace context into it; the server span receives the incoming
`ctx.headers` as its `carrier` and should **extract** the parent from it. With a
W3C-compliant adapter this propagates `traceparent`/`tracestate` end to end. A thin
OpenTelemetry adapter implementing the `Telemetry` interface is all that is needed
— no OTel dependency is imposed by this package.
