# @nuraljs/cli

> The official command-line tool for the **NuralJS** framework.

![version](https://img.shields.io/badge/version-1.0.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)

`@nuraljs/cli` is the developer companion for [NuralJS](https://nuraljs.org) — a schema-first, Fastify-native REST framework. It scaffolds new projects, generates feature resources and building blocks, wires in infrastructure integrations, and drives the full dev workflow (dev server, build, test, docs, introspection). Everything runs through a single `nural` command.

## Installation

Install globally to get the `nural` binary on your PATH:

```bash
pnpm add -g @nuraljs/cli
# or
npm install -g @nuraljs/cli
```

Or run a one-off scaffold without installing:

```bash
pnpm dlx @nuraljs/cli new my-app
```

## Quick start

```bash
nural new my-app     # scaffold a new project (interactive prompts)
cd my-app
nural dev            # start the development server
```

`nural new` prompts for the underlying engine (Fastify or Express), your package manager (npm / pnpm / yarn / bun), and any integrations to include (Redis, WebSockets, RabbitMQ, PostgreSQL/Prisma, MongoDB/Mongoose), then generates the project.

## Commands

Run `nural <command> --help` for details on any command.

### Scaffold

| Command | Description |
| --- | --- |
| `nural new <project-name>` | Scaffold a new NuralJS project via interactive prompts. |
| `nural generate <schematic> [name]` (alias `g`) | Generate code — a `resource`, `middleware`, `provider`, or `filter`. |
| `nural add [integration]` | Add an integration to the project: `redis`, `rabbitmq`, `mongoose`, or `prisma-pg`. |

### Dev workflow

| Command | Description |
| --- | --- |
| `nural dev` | Start the development server. `-w, --watch` enables polling mode for WSL/Docker. |
| `nural build` | Build the application for production. `--ignore-ts-errors` proceeds despite failing TypeScript checks. |
| `nural start` | Run the production application. `--debug` enables the inspector. |
| `nural test` | Run application tests. `-w, --watch`, `-c, --coverage`, `--e2e` (end-to-end only). |
| `nural console` (aliases `c`, `tinker`) | Launch an interactive application shell (REPL). |

### Introspection

| Command | Description |
| --- | --- |
| `nural info` | Print environment and project diagnostics (handy for bug reports). |
| `nural routes` (alias `list`) | List all registered routes. |
| `nural docs` | Generate a static OpenAPI specification file. `-o, --output <file>` (default `openapi.json`). |
| `nural doctor` | Check system and project health, including reachability of configured infrastructure. |

### Maintenance

| Command | Description |
| --- | --- |
| `nural clean` | Remove build artifacts and temporary files. |
| `nural completion` | Generate a shell completion script. |
| `nural update` (alias `u`) | Update NuralJS dependencies to the latest version. |

### `nural generate`

Supported schematics (pass as the first argument, e.g. `nural g resource product`):

- **`resource`** — a full feature module: model, request/response schemas, service, controller, and module — scaffolded under `src/modules/<name>/` and auto-registered in `src/app.ts`. Running `nural g <name>` with a bare name is shorthand for generating a resource.
- **`middleware`** — a middleware in `src/common/middleware/`.
- **`filter`** — an exception filter in `src/common/filters/`.
- **`provider`** — a provider in `src/providers/`, auto-registered in `src/main.ts`.

Omitting the schematic or name drops into interactive prompts.

### `nural add`

Installs the required dependencies, generates a provider, and prints the configuration steps for the chosen integration:

- **`redis`** — `ioredis` provider (`src/providers/redis.ts`).
- **`rabbitmq`** — `amqplib` provider (`src/providers/rabbitmq.ts`).
- **`mongoose`** — Mongoose provider (`src/providers/mongoose.ts`).
- **`prisma-pg`** — Prisma + `@prisma/adapter-pg` provider, a starter `prisma/schema.prisma`, and `db:generate` / `db:migrate` scripts.

Omitting the integration name opens an interactive picker.

## Requirements

- Node.js **≥ 24**

## Ecosystem

Part of the [NuralJS](https://nuraljs.org) ecosystem:

| Package | Description |
| --- | --- |
| [`@nuraljs/core`](https://github.com/ErrorX407/nural) | Schema-first, Fastify-native REST framework |
| **[`@nuraljs/cli`](https://github.com/ErrorX407/nural)** | Project scaffolding & dev tooling (`nural`) |
| [`@nuraljs/testing`](https://github.com/ErrorX407/nural) | Test harness — drive routes through the real adapter |
| [`@nuraljs/auth`](https://github.com/ErrorX407/nural-auth) | Functional auth: binary tokens, KMS, OAuth, RBAC/ABAC |
| [`@nuraljs/microservices`](https://github.com/ErrorX407/nural-microservices) | Contract-first RPC & message brokers |

## Documentation

Full documentation at **[nuraljs.org/docs](https://nuraljs.org/docs)**.

## License

[MIT](./LICENSE) © Chetan Joshi
