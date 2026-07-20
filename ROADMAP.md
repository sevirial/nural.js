# ROADMAP — NuralJS Packages (`@nuraljs/auth` · `@nuraljs/microservices` · `@nuraljs/cli`)

Forward-looking plan for the downstream NuralJS packages. This is **direction, not a commitment** — priorities shift with feedback. For *what is already done*, see [`Task.md`](./Task.md), [`SECURITY-AUDIT.md`](./SECURITY-AUDIT.md), and each package's `CHANGELOG.md` / `MIGRATION.md`.

**Status at time of writing (2026-07-17):**

| Package | Version | State |
|---------|---------|-------|
| `@nuraljs/auth` | 0.5.0 | Hardened, security-audited, token inspector shipped |
| `@nuraljs/microservices` | 0.5.1 | 4 transports, DLQ, idempotency, signed wire envelope |
| `@nuraljs/cli` | 0.6.0 | 16 command groups incl. `token inspect` |
| `@nuraljs/core` (`nural`) | 0.5.1 | Zod-4 / Fastify-native hot path |
| `@nural/testing` | 0.1.1 | Adapter-driven integration harness |

All 10 findings from the security audit are closed. The packages are publishable from a unified pnpm workspace with `changesets`.

---

## Guiding principles (do not violate)

These are **locked** decisions carried over from the hardening effort. New features must respect them:

1. **`auth` stays functional / zero-class.** Factory `createX` returning closures. No decorators, no `reflect-metadata`, no classes for the public surface.
2. **`microservices` stays class-based + functional wrappers.** Do **not** rewrite it into a functional style — that is an explicit non-goal.
3. **Security is not a later feature.** No secrets in logs/errors; validate every external byte with Zod before use; fail closed; no unbounded timer/connection/retry/set.
4. **Depend on core by its real name `nural`** until core is split into a published `@nuraljs/core`.
5. **Additive is free; breaking is scheduled.** Breaking changes (wire format, store shape, option names, exported symbols) land only on a major, are called out in `MIGRATION.md`, and bump semver deliberately.

---

## Horizon 1 — Near term (next minor `0.x`, additive & non-breaking)

Ships without breaking anyone. Highest-leverage work first.

### `@nuraljs/auth`

- **A1 · Token observability, expanded.** Build on the shipped `inspectTokenHeader` / `decodeToken` ([`token/inspect.ts`](./packages/auth/src/token/inspect.ts)):
  - `nural token verify <token>` — full engine `verify` (enforces `exp`/`nbf`/`iss`/`aud`/revocation) with a pass/fail verdict, distinct from `inspect` which only *reports*.
  - `nural token mint` — dev-only signer for fixtures/local testing (gated behind an explicit `--dev` flag; never a production path).
  - **Hosted web inspector** — the true "jwt.io equivalent": a static, client-side page that runs `inspectTokenHeader` in the browser (envelope only, no key ever leaves the tab). The genuinely secure counterpart to pasting a JWT into a third-party site.
- **A2 · Debug/introspection endpoint (opt-in).** A guarded `createTokenInspectorRoute()` a team can mount behind admin auth to inspect tokens in a running service — reuses the same primitive.
- **A3 · Key-rotation ergonomics.** A `rotateNow()` helper + emitted audit event on the local provider (cloud already has `refreshNow()`), and a documented rotation runbook.
- **A4 · Revocation store adapters.** First-party `isRevoked` implementations (in-memory TTL + Redis) so revocation isn't only a bring-your-own hook.
- **A5 · Session store adapters beyond Redis.** The `SessionStore` interface exists; add a Postgres/SQL adapter and an in-memory dev store.

### `@nuraljs/microservices`

- **M1 · Streaming & backpressure.** Bounded-concurrency consumers exist; add explicit backpressure signalling and a documented flow-control story for high-throughput Kafka event consumers.
- **M2 · Observability parity.** Extend the OpenTelemetry `telemetry.ts` spans to cover DLQ replays and reconnect cycles; ship a metrics cheat-sheet (in-flight, retries, DLQ depth, RPC latency).
- **M3 · Contract registry / versioning.** A lightweight, optional contract-version negotiation so a v2 handler can coexist with v1 callers during a rollout (mirrors the wire-envelope migration pattern).
- **M4 · Idempotency store adapters.** `idempotency.ts` has the hook; add Redis + in-memory adapters with member expiry.

### `@nuraljs/cli`

- **C1 · `nural token` group expansion** — wire up `verify` / `mint` (see A1) alongside the shipped `inspect`.
- **C2 · `nural add` for auth & microservices** — scaffold a wired `@nuraljs/auth` setup (key provider + guard + protected route) and a `@nuraljs/microservices` transport, the way `add` already wires Redis/Prisma.
- **C3 · `nural doctor` deep checks** — validate an auth secret's length against the KMS floor and warn before the next-major bump (see B3); check broker reachability for configured transports.

### Docs & website

- **D1 · Token-inspection page shipped** (`content/docs/cli/token-inspection.mdx`) — keep it in sync as A1/C1 land.
- **D2 · Migration guides surfaced** — publish `auth/MIGRATION.md` + `microservices/MIGRATION.md` as website pages ahead of the next major.
- **D3 · Security hardening page** — document CORS `origin:"*" + credentials` guardrail, secret-length policy, and the wire-envelope legacy window.

---

## Horizon 2 — Next major (`1.0`, scheduled breaking changes)

These are **already promised** by the audit/hardening work — they only need the major to land. Each has a written migration note.

- **B1 · `microservices`: flip `acceptLegacyWire` `true → false`.** Closes the residual L2 finding unconditionally — inbound stops accepting pre-0.5.0 un-enveloped messages. Operators must have upgraded all publishers first. (`microservices/MIGRATION.md`, `SECURITY.md`.)
- **B2 · `auth`: raise KMS secret hard floor `16 → 32` chars.** The SF3 "warn-then-enforce" window ends; 16–31-char secrets that currently warn (`NURALJS_AUTH_SHORT_SECRET`) become a hard reject at boot. (`auth/MIGRATION.md`, [`kms/limits.ts`](./packages/auth/src/kms/limits.ts).)
- **B3 · Drop deprecated shims** — any `.openapi()`→`.meta()`-style compat shims carried for the Zod-4 migration window.
- **B4 · Semver alignment** — move both packages to `1.0.0` once the wire format and secret policy are final and stable.

> **Sequencing rule:** B1 and B2 must not ship silently. The minor before the major should make the deprecation *loud* (doctor warnings in C3, runtime warnings already present), so no one is surprised at boot.

---

## Horizon 3 — Later / exploratory (not yet scheduled)

Bigger bets, gated on demand and on core's own roadmap.

- **E1 · New transports (gRPC / NATS)** for `microservices` — behind the existing `Transport` interface, as optional peer deps. (Task G.2.)
- **E2 · New OAuth/OIDC providers** beyond Google / GitHub / generic OIDC (e.g. Microsoft Entra, Okta) — only if the generic OIDC provider can't already cover them via config. (Task G.2.)
- **E3 · Hosted KMS integrations** (AWS KMS / GCP KMS / Vault) as first-party `fetchSecrets()` implementations, beyond today's pluggable contract. (Task G.3.)
- **E4 · Depend on a published `@nuraljs/core`** once core ships F.3 (the package split), replacing the `workspace:*`/`nural` link. (Task G.1.)
- **E5 · Passkeys / WebAuthn** as an auth strategy alongside tokens + OAuth.
- **E6 · Docs UI supply-chain hardening** — pin + SRI (or self-host) the Swagger/Scalar CDN assets flagged in the audit; ship as a core-side change but track here since it affects the auth-protected `/docs`.

---

## Non-goals (deliberately excluded — do not "fix")

Listing these so they aren't re-proposed as bugs:

- **Kafka request/reply RPC.** Kafka is event-streaming; `send()` intentionally throws `RpcUnsupportedError` and `supportsRpc` is `false`. Use `emit()`. This is a design decision, not a gap.
- **A functional rewrite of `microservices`.** It stays class-based.
- **Decorators / `reflect-metadata` anywhere.** Both packages are decorator-free by design.
- **CLI `guard` / `interceptor` schematics.** Excluded in the CLI (a guard is middleware that throws; an interceptor adds a hot-path allocation).
- **JWT interoperability.** Nural tokens are encrypted, not JWTs, and are intentionally not interoperable with JWT tooling — hence the dedicated inspector.

---

## Priority summary

| ID | Package | Item | Horizon | Priority |
|----|---------|------|---------|----------|
| A1 | auth | Token verify/mint + web inspector | 1 (0.x) | High |
| C1 | cli | `nural token` group expansion | 1 (0.x) | High |
| C2 | cli | `add` for auth & microservices | 1 (0.x) | Medium |
| A4 | auth | Revocation store adapters | 1 (0.x) | Medium |
| M2 | microservices | Observability parity (OTel) | 1 (0.x) | Medium |
| C3 | cli | `doctor` deep checks (pre-major warnings) | 1 (0.x) | High |
| B1 | microservices | `acceptLegacyWire → false` | 2 (1.0) | Scheduled |
| B2 | auth | Secret floor `16 → 32` | 2 (1.0) | Scheduled |
| E1 | microservices | gRPC / NATS transports | 3 | Exploratory |
| E4 | all | Published `@nuraljs/core` dep | 3 | Blocked on core |

---

_When starting any item: read the relevant `CLAUDE.md` first, keep `Task.md` the source of truth for progress, verify behavior with a round-trip (crypto: sign→verify→tamper→expire; transport: publish→consume→reply→timeout→reconnect→DLQ), and add a migration note for anything breaking._
