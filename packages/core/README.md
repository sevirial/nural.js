# @nuraljs/core

> The intelligent, schema-first REST framework for Node.js — NestJS-style structure, zero decorators, Fastify-native speed.

![version](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

`@nuraljs/core` lets you build REST APIs with plain functions and [Zod](https://zod.dev) schemas — no classes, no decorators, no `reflect-metadata`. It's the *"NestJS alternative without decorators"*: you get modules, dependency injection, guards, and generated OpenAPI docs, but the authoring surface is entirely functional. Schemas are compiled to JSON Schema **once at boot**, so on the hot path [Fastify](https://fastify.dev)'s `ajv` validator and `fast-json-stringify` serializer do the per-request work and Zod runs **0× per request** on compilable routes. Fastify is the optimized engine; [Express](https://expressjs.com) is available as an optional legacy adapter.

## Features

- **Schema-first & functional** — define endpoints with `createRoute` and a Zod schema. Zero route classes, zero decorators, no DI container.
- **Boot-time schema compilation** — Zod schemas compile to JSON Schema once at registration; `ajv` validates and `fast-json-stringify` serializes per request. Routes that use `.refine()` / `.transform()` / `.superRefine()` / `z.custom()` transparently fall back to a runtime Zod `parse()` for the affected slot only.
- **Validation for free** — `body`, `query`, and `params` are validated **before** your handler runs; invalid requests get a consistent structured `400`.
- **Safe response serialization** — outgoing payloads are shaped to your response schema, so fields you didn't declare are **stripped** and internal data can't leak by accident.
- **End-to-end type safety** — `body`, `query`, `params`, injected services, and middleware context are all inferred from your schemas.
- **Middleware & guards as `preValidation` hooks** — `defineMiddleware` returns typed context that merges into the handler; it runs before validation, so an auth `401` beats a body `400`.
- **Functional DI & modules** — group routes with `createModule`, share services via `providers` / `inject` maps, and register lifecycle providers with `defineProvider` — all merged once at boot.
- **Automatic OpenAPI 3 docs** — a spec plus an interactive Scalar or Swagger UI at `/docs`, generated natively from your schemas via `z.toJSONSchema`.
- **Structured exceptions** — a full `HttpException` hierarchy mapped to consistent JSON error responses, with `defineExceptionFilter` for custom handling.
- **Engine-agnostic** — Fastify (recommended, hot path) or Express (optional legacy adapter); both are optional peer dependencies, loaded lazily.

## Installation

```bash
pnpm add @nuraljs/core fastify
```

```bash
npm install @nuraljs/core fastify
```

Zod ships as a direct dependency, so you don't install it separately. The HTTP engine is a peer dependency — install only the one you use. Express is optional and legacy:

```bash
pnpm add express   # optional, legacy adapter
```

## Quick start

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
    // extra fields would be stripped to match the 200 schema
  },
});

const usersModule = createModule({
  prefix: "/users",
  routes: [getUser],
});

const app = new Nuraljs({ framework: "fastify", docs: true });
app.registerModule(usersModule);
app.start(3000); // → http://localhost:3000 · docs at /docs
```

You can also register routes directly with `app.register([getUser])`.

> Note: the exported app class is `Nuraljs`. `Schema` and `z` both point at Zod.

## Validation & response serialization

Declare inputs under `request: { body, query, params }`. On failure the core returns a consistent `400` **before** your handler runs:

```ts
const createUser = createRoute({
  method: "POST",
  path: "/users",
  request: {
    body: Schema.object({
      name: Schema.string().min(1),
      age: Schema.coerce.number().int().positive(),
    }),
  },
  responses: { 201: Schema.object({ id: Schema.string() }) },
  handler: async ({ body, status }) => {
    status(201); // pick which declared 2xx code the return value uses
    return { id: crypto.randomUUID() };
  },
});
```

Path and query params arrive as strings — use `Schema.coerce.number()` for numeric fields. Response bodies are serialized against the schema for the chosen status code via `fast-json-stringify`, so undeclared fields never reach the client.

## Middleware & guards

`defineMiddleware` returns typed data that merges onto the route context. Middleware run as `preValidation` hooks, so authentication failures short-circuit before body validation:

```ts
import { defineMiddleware, UnauthorizedException } from "@nuraljs/core";

const withUser = defineMiddleware(async (req) => {
  const header = req.headers["authorization"];
  if (!header) throw new UnauthorizedException("Missing bearer token");
  return { user: await verifyToken(header) }; // typed onto the handler context
});

const me = createRoute({
  method: "GET",
  path: "/me",
  middleware: [withUser],
  responses: { 200: Schema.object({ id: Schema.string() }) },
  handler: async ({ user }) => ({ id: user.id }), // `user` is inferred
});
```

Modules can apply middleware to every route via `createModule({ middleware: [...] })`.

## Dependency injection

Declare shared services on a module's `providers` map (or a route's `inject` map). They're merged once at boot and appear as typed fields on the handler context:

```ts
const usersModule = createModule({
  prefix: "/users",
  providers: { db }, // available (typed) on every route in the module
  routes: [getUser],
});
```

Lifecycle services can be registered with `defineProvider` and `await app.registerProvider(...)`, which are disposed in LIFO order on shutdown. The context keys `params`, `query`, `body`, `req`, `res`, and `status` are reserved.

## Exceptions

Throw a typed exception anywhere and the global handler maps it to a consistent JSON response:

```ts
import { ConflictException } from "@nuraljs/core";

throw new ConflictException("Email already registered"); // → 409
```

The full hierarchy extends `HttpException`: `BadRequestException` (400), `UnauthorizedException` (401), `ForbiddenException` (403), `NotFoundException` (404), `ConflictException` (409), `GoneException` (410), `PayloadTooLargeException` (413), `UnsupportedMediaTypeException` (415), `UnprocessableEntityException` (422), `InternalServerErrorException` (500), `NotImplementedException` (501), `BadGatewayException` (502), `ServiceUnavailableException` (503), `GatewayTimeoutException` (504), plus `CustomException(message, statusCode, details?)`. Use `defineExceptionFilter` to customize handling.

## OpenAPI & docs

Enable `docs` and the core generates an OpenAPI 3 spec natively (via `z.toJSONSchema`) plus an interactive UI:

```ts
const app = new Nuraljs({
  framework: "fastify",
  docs: { ui: "scalar" }, // or "swagger" · UI at /docs · spec at /docs/openapi.json
});
```

Author endpoint metadata with Zod 4 `.meta()`, or use the `.openapi()` compatibility shim (installed on Zod's prototype; also exported as `extendZodWithOpenApi`).

## Requirements

- **Node.js ≥ 24**
- **Fastify 5** — the recommended, optimized hot-path engine (optional peer dependency).
- **Express 5** — optional, legacy adapter (optional peer dependency); keeps working but is not on the optimized path.
- **Zod 4** — the authoring API for schemas (bundled as a direct dependency).

Ships ESM + CJS builds with TypeScript types. No `experimentalDecorators` / `emitDecoratorMetadata` required — the framework is fully functional.

## Ecosystem

Part of the [NuralJS](https://nuraljs.org) ecosystem:

| Package | Description |
| --- | --- |
| **[`@nuraljs/core`](https://github.com/ErrorX407/nural)** | Schema-first, Fastify-native REST framework |
| [`@nuraljs/cli`](https://github.com/ErrorX407/nural) | Project scaffolding & dev tooling (`nuraljs`) |
| [`@nuraljs/testing`](https://github.com/ErrorX407/nural) | Test harness — drive routes through the real adapter |
| [`@nuraljs/auth`](https://github.com/ErrorX407/nural-auth) | Functional auth: binary tokens, KMS, OAuth, RBAC/ABAC |
| [`@nuraljs/microservices`](https://github.com/ErrorX407/nural-microservices) | Contract-first RPC & message brokers |

## Documentation

Full documentation at **[nuraljs.org/docs](https://nuraljs.org/docs)**.

## License

[MIT](./LICENSE) © Chetan Joshi
