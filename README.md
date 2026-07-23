<div align="center">

# NuralJS

**The intelligent, schema-first REST framework for Node.js — NestJS-style structure, zero decorators, Fastify-native speed.**

![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen) ![license](https://img.shields.io/badge/license-MIT-green) ![pnpm](https://img.shields.io/badge/pnpm-workspace-orange) ![types](https://img.shields.io/badge/types-TypeScript-blue)

</div>

NuralJS lets you build production REST APIs — and their realtime, auth, and microservice layers — with **plain functions and [Zod](https://zod.dev) schemas**. No route classes, no decorators, no `reflect-metadata`. It's the *"NestJS alternative without decorators"*: you still get modules, dependency injection, middleware/guards, and generated OpenAPI docs, but the authoring surface is entirely functional.

Schemas are compiled to JSON Schema **once at boot**, so on the hot path [Fastify](https://fastify.dev)'s `ajv` validator and `fast-json-stringify` serializer do the per-request work and **Zod runs 0× per request** on compilable routes. Fastify is the optimized engine; [Express](https://expressjs.com) is available as an optional legacy adapter.

This repository is the **unified monorepo** for the whole ecosystem.

## Packages

| Package | Version | Description |
|---|---|---|
| [`@nuraljs/core`](./packages/core) | `1.0.0` | The schema-first, functional REST framework — routes, modules, DI, middleware, OpenAPI. Fastify-native hot path. |
| [`@nuraljs/cli`](./packages/cli) | `1.0.0` | Project scaffolding and codegen — `nural new`, generators, and lifecycle commands. |
| [`@nuraljs/testing`](./packages/testing) | `1.0.0` | Official test harness — drive routes through the real adapter with `createTestClient`. |
| [`@nuraljs/auth`](./packages/auth) | `0.6.0` | Zero-class, schema-first authentication — binary token engine, KMS, OAuth/OIDC, sessions, RBAC/ABAC. |
| [`@nuraljs/microservices`](./packages/microservices) | `0.6.0` | Contract-first RPC + message broker layer with pluggable transports (Redis / Kafka / RabbitMQ). |
| [`@nuraljs/websocket`](./packages/websocket) | *in design* | Schema-first realtime gateways on the `ws` library. See [`SPEC.md`](./packages/websocket/SPEC.md) — spec locked, implementation pending. |

All packages are independently versioned and published from this workspace via [changesets](https://github.com/changesets/changesets).

## Quick start

Scaffold a new project with the CLI:

```bash
pnpm dlx @nuraljs/cli new my-api
```

Or add the core framework to an existing project:

```bash
pnpm add @nuraljs/core fastify
```

```ts
import { Nuraljs, createRoute, createModule, Schema } from "@nuraljs/core";

// `Schema` is the exported alias for Zod's `z` (both are exported).
const getUser = createRoute({
  method: "GET",
  path: "/users/:id",
  summary: "Get a user by ID",
  request: { params: Schema.object({ id: Schema.string().uuid() }) },
  responses: {
    200: Schema.object({ id: Schema.string(), name: Schema.string() }),
  },
  handler: async ({ params }) => {
    return { id: params.id, name: "Ada" };
    // extra fields are stripped to match the 200 schema — no accidental leaks
  },
});

const usersModule = createModule({ prefix: "/users", routes: [getUser] });

const app = new Nuraljs({ framework: "fastify", docs: true });
app.registerModule(usersModule);
app.start(3000); // → http://localhost:3000 · interactive docs at /docs
```

Add typed auth via middleware — a `401` beats a body `400` because middleware runs before validation:

```ts
import { defineMiddleware, UnauthorizedException } from "@nuraljs/core";

const withUser = defineMiddleware(async (req) => {
  const header = req.headers["authorization"];
  if (!header) throw new UnauthorizedException("Missing bearer token");
  return { user: await verifyToken(header) }; // typed onto the handler context
});
```

See [`examples/`](./examples) for a runnable [`basic`](./examples/basic) server and a full-featured [`full-api`](./examples/full-api).

## Repository layout

```
nuraljs_packages/
├── packages/
│   ├── core/           @nuraljs/core         — the framework
│   ├── cli/            @nuraljs/cli          — scaffolding & codegen
│   ├── testing/        @nuraljs/testing      — test harness
│   ├── auth/           @nuraljs/auth         — authentication toolkit
│   ├── microservices/  @nuraljs/microservices — RPC + message broker
│   └── websocket/      @nuraljs/websocket    — realtime gateways (in design; see SPEC.md)
├── examples/           basic · full-api
├── .changeset/         changesets versioning
└── pnpm-workspace.yaml
```

## Development

Requires **Node ≥ 24** and **pnpm 10** (`packageManager` is pinned). All commands run from this root and fan out across the workspace with `pnpm -r`:

```bash
pnpm install          # install the whole workspace
pnpm build            # build every package (tsup → dual ESM + CJS)
pnpm test             # run every package's vitest suite
pnpm typecheck        # tsc --noEmit across packages
pnpm lint             # lint across packages
```

Scope a command to one package with a filter, e.g. `pnpm --filter @nuraljs/core test`.

### Releasing

Versioning and publishing are driven by changesets:

```bash
pnpm changeset          # record a change + semver bump
pnpm version-packages   # apply pending changesets to package versions
pnpm release            # build all, then changeset publish
```

## Design principles

These are locked decisions the whole ecosystem respects:

- **Functional, zero-decorator public API.** `core` and `auth` expose factory functions returning closures — no classes for routes/modules, no `reflect-metadata`. (`microservices` is class-based internally with functional wrappers.)
- **Schema-first with Zod as the single source of truth.** Validation, serialization, OpenAPI, and (soon) realtime contracts all derive from your Zod schemas.
- **Move work to boot, not per request.** Anything computable once at registration — JSON Schema, status codes, DI merges, static headers — is hoisted off the hot path.
- **Secure by default, fail closed.** Responses are shaped to their schema so undeclared fields can't leak; external input is validated before use; no secrets in logs.
- **Additive is free; breaking is scheduled.** Breaking changes land only on a major, are documented in each package's `MIGRATION.md`, and bump semver deliberately.

## License

[MIT](./packages/core/package.json) © the NuralJS authors.
