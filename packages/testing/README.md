# @nuraljs/testing

> Official test harness for NuralJS — drive your routes through the real adapter.

![version](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

`@nuraljs/testing` is the official test harness for [NuralJS](https://nuraljs.org) apps. `createTestClient` drives a `Nuraljs` application through its **real adapter** — `app.inject()` for Fastify, `supertest` for Express — so your tests exercise the full request pipeline (validation, serialization, middleware, error shapes) exactly as production does, with no network sockets and no mocks. It works with any test runner (Vitest, Jest) and returns plain, typed response objects you can assert on directly.

## Features

- **`createTestClient(app)`** — one universal client for a `Nuraljs` app on either engine; it auto-detects Fastify vs. Express and picks the right driver.
- **Real adapter, no mocks** — Fastify routes run through `app.inject()`; Express routes through `supertest`, so tests validate the actual framework pipeline rather than a stand-in.
- **Full request pipeline** — request validation, response serialization/field-stripping, and middleware/guards all run, so 400/401 envelopes match what your users see.
- **Typed responses** — every call resolves to a `TestResponse` with `status`, `body` (parsed JSON when applicable), `text`, and `headers`.
- **Standard HTTP verbs** — `get`, `post`, `put`, `patch`, `delete`, each with optional per-request headers.

## Installation

```bash
pnpm add -D @nuraljs/testing
```

```bash
npm install -D @nuraljs/testing
```

`@nuraljs/testing` is a dev dependency, and `@nuraljs/core` is a peer dependency (you already depend on it in your app). Works with both the Fastify and Express engines.

## Quick start

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { Nuraljs, createRoute, Schema as z } from "@nuraljs/core";
import { createTestClient, type TestClient } from "@nuraljs/testing";

const echo = createRoute({
  method: "POST",
  path: "/echo",
  request: { body: z.object({ msg: z.string() }) },
  responses: { 200: z.object({ msg: z.string() }) },
  handler: async ({ body }) => ({ msg: body.msg }),
});

describe("echo route", () => {
  let client: TestClient;

  beforeAll(() => {
    const app = new Nuraljs({ framework: "fastify", logger: { enabled: false } });
    app.register([echo]);
    client = createTestClient(app);
  });

  it("returns the message on a valid body", async () => {
    const res = await client.post("/echo", { msg: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ msg: "hi" });
  });

  it("returns a 400 envelope when validation fails", async () => {
    const res = await client.post("/echo", {}); // missing `msg`
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("Validation Error");
  });
});
```

Because the client runs against the real adapter, a validation failure returns the same `400` envelope your users would see — the harness never short-circuits the pipeline.

## API

### `createTestClient(app): TestClient`

Creates a universal test client for a `Nuraljs` application. Pass the initialized app instance (after `app.register(...)`); the client detects whether the app is running on Express or Fastify and drives the appropriate adapter. The app does **not** need to be listening on a port.

### `TestClient`

Each method resolves to a `Promise<TestResponse>`. Bodies are sent as the request payload; `headers` are merged into the request.

```ts
interface TestClient {
  get(url: string, headers?: Record<string, string>): Promise<TestResponse>;
  post(url: string, body?: string | object, headers?: Record<string, string>): Promise<TestResponse>;
  put(url: string, body?: string | object, headers?: Record<string, string>): Promise<TestResponse>;
  patch(url: string, body?: string | object, headers?: Record<string, string>): Promise<TestResponse>;
  delete(url: string, headers?: Record<string, string>): Promise<TestResponse>;
}
```

### `TestResponse`

```ts
interface TestResponse {
  status: number;                                          // HTTP status code
  body: string | object | undefined;                       // parsed JSON when the payload is JSON, else the raw string
  text: string;                                            // raw response payload
  headers: Record<string, string | string[] | undefined>; // response headers
}
```

## Requirements

- **Node.js ≥ 24**
- **[`@nuraljs/core`](https://github.com/ErrorX407/nural)** (peer dependency)
- A test runner — **Vitest** recommended (Jest and others work too, since the client is runner-agnostic)

## Ecosystem

Part of the [NuralJS](https://nuraljs.org) ecosystem:

| Package | Description |
| --- | --- |
| [`@nuraljs/core`](https://github.com/ErrorX407/nural) | Schema-first, Fastify-native REST framework |
| [`@nuraljs/cli`](https://github.com/ErrorX407/nural) | Project scaffolding & dev tooling (`nuraljs`) |
| **[`@nuraljs/testing`](https://github.com/ErrorX407/nural)** | Test harness — drive routes through the real adapter |
| [`@nuraljs/auth`](https://github.com/ErrorX407/nural-auth) | Functional auth: binary tokens, KMS, OAuth, RBAC/ABAC |
| [`@nuraljs/microservices`](https://github.com/ErrorX407/nural-microservices) | Contract-first RPC & message brokers |

## Documentation

Full documentation at **[nuraljs.org/docs](https://nuraljs.org/docs)**.

## License

[MIT](./LICENSE) © Chetan Joshi
