/**
 * T6.9 / T6.10 — autocannon benchmark harness.
 *
 * Benchmarks two scenarios (hello-world GET, validated POST) across four
 * servers on identical hardware, back-to-back:
 *
 *   1. raw Fastify          — hand-written JSON schema (ajv + fast-json-stringify). Ceiling.
 *   2. raw Express          — express.json() + plain handler (no validation; favors Express).
 *   3. rewritten Nural      — current build (Fastify engine, Zod compiled → ajv, 0× Zod/req).
 *   4. current Nural (recon)— faithful reconstruction of the PRE-rewrite Fastify adapter:
 *                             routes registered with NO `schema`, handler runs
 *                             `await schema.parseAsync(input)` + `await resp.parseAsync(output)`
 *                             per request (interpreted Zod ×2), then reply.send().
 *                             (No git history exists to check out the literal old build.)
 *
 * All four run with no CORS/Helmet/logger so the delta reflects the request
 * pipeline (validation + serialization) the rewrite targets.
 *
 * Run: node_modules/.bin/tsx packages/core/bench/autocannon-bench.ts
 */

import Fastify from "fastify";
import express from "express";
import autocannon from "autocannon";
import { createRequire } from "node:module";
import type { Server } from "node:http";

const require = createRequire(import.meta.url);
const { Nural, createRoute, z } = require("nural");
// Zod 3 — the ACTUAL pre-rewrite dependency (`^3.25`). Used only by the
// "current Nural" reconstruction so its per-request parseAsync cost is faithful
// to the old build (Zod 4 parse is faster and would understate the old cost).
const { z: z3 } = require("zod3");

const DURATION = Number(process.env.BENCH_DURATION ?? 8); // seconds per test
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS ?? 50);
const PORT = 3211;
const WARMUP = process.env.BENCH_NO_WARMUP !== "1";

// A realistic validated payload — nested object, arrays, enums, string formats.
// This is where interpreted Zod (old path) diverges from compiled ajv (rewrite):
// a trivial 3-field body is dominated by HTTP overhead and hides the difference.
// Includes a 50-element `items` array so validation/serialization is a real
// share of the request (bulk-style payload) rather than noise under HTTP I/O.
const POST_BODY = {
  name: "Alice Smith",
  email: "alice@example.com",
  age: 30,
  website: "https://alice.dev",
  tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
  address: { street: "123 Main St", city: "Springfield", zip: "12345", country: "US" },
  roles: ["user", "admin"],
  metadata: { createdAt: "2026-01-01T00:00:00Z", score: 9.5 },
  items: Array.from({ length: 50 }, (_v, i) => ({
    sku: `SKU-${i}`,
    qty: i + 1,
    price: (i + 1) * 1.5,
  })),
};

// Shared Zod (v4) schemas — rewritten Nural (compiled to ajv at boot) ----------
const zBody = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  age: z.number().int().min(0).max(120),
  website: z.string().url().optional(),
  tags: z.array(z.string()).max(20),
  address: z.object({
    street: z.string(),
    city: z.string(),
    zip: z.string(),
    country: z.string().length(2),
  }),
  roles: z.array(z.enum(["admin", "user", "guest"])),
  metadata: z.object({ createdAt: z.string(), score: z.number() }),
  items: z
    .array(z.object({ sku: z.string(), qty: z.number().int(), price: z.number() }))
    .max(200),
});
const zResp = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  tags: z.array(z.string()),
  address: z.object({
    street: z.string(),
    city: z.string(),
    zip: z.string(),
    country: z.string(),
  }),
  items: z.array(
    z.object({ sku: z.string(), qty: z.number().int(), price: z.number() }),
  ),
});

// Handler result shape shared by all servers (built from the validated body).
const buildResult = (b: {
  name: string;
  email: string;
  tags: string[];
  address: Record<string, string>;
  items: unknown[];
}) => ({
  id: "1",
  name: b.name,
  email: b.email,
  tags: b.tags,
  address: b.address,
  items: b.items,
});

// Hand-written JSON schema for raw Fastify (equivalent to zBody/zResp) ---------
const jsonBody = {
  type: "object",
  required: ["name", "email", "age", "tags", "address", "roles", "metadata", "items"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    email: { type: "string" },
    age: { type: "integer", minimum: 0, maximum: 120 },
    website: { type: "string" },
    tags: { type: "array", items: { type: "string" }, maxItems: 20 },
    address: {
      type: "object",
      required: ["street", "city", "zip", "country"],
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zip: { type: "string" },
        country: { type: "string", minLength: 2, maxLength: 2 },
      },
    },
    roles: { type: "array", items: { type: "string", enum: ["admin", "user", "guest"] } },
    metadata: {
      type: "object",
      required: ["createdAt", "score"],
      properties: { createdAt: { type: "string" }, score: { type: "number" } },
    },
    items: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        required: ["sku", "qty", "price"],
        properties: {
          sku: { type: "string" },
          qty: { type: "integer" },
          price: { type: "number" },
        },
      },
    },
  },
};
const jsonResp = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    email: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    address: {
      type: "object",
      additionalProperties: false,
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zip: { type: "string" },
        country: { type: "string" },
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sku: { type: "string" },
          qty: { type: "integer" },
          price: { type: "number" },
        },
      },
    },
  },
};

// ---- Server builders: each returns { start, stop } --------------------------

type Bootable = { start: (port: number) => Promise<Server>; stop: () => Promise<void> };

function rawFastify(): Bootable {
  const app = Fastify();
  app.get("/hello", async () => ({ hello: "world" }));
  app.route({
    method: "POST",
    url: "/users",
    schema: { body: jsonBody, response: { 200: jsonResp } },
    handler: async (req) => buildResult(req.body as Parameters<typeof buildResult>[0]),
  });
  return {
    start: (port) => app.listen({ port }).then(() => app.server),
    stop: () => app.close(),
  };
}

function rawExpress(): Bootable {
  const app = express();
  app.use(express.json());
  app.get("/hello", (_req, res) => res.json({ hello: "world" }));
  app.post("/users", (req, res) => {
    res.json(buildResult(req.body));
  });
  let server: Server;
  return {
    start: (port) =>
      new Promise((resolve) => {
        server = app.listen(port, () => resolve(server));
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function rewrittenNural(): Bootable {
  const app = new Nural({
    framework: "fastify",
    cors: false,
    helmet: false,
    docs: false,
    logger: { enabled: false },
  });
  app.register([
    createRoute({
      method: "GET",
      path: "/hello",
      responses: { 200: z.object({ hello: z.string() }) },
      handler: async () => ({ hello: "world" }),
    }),
    createRoute({
      method: "POST",
      path: "/users",
      request: { body: zBody },
      responses: { 200: zResp },
      handler: async ({ body }: { body: Parameters<typeof buildResult>[0] }) =>
        buildResult(body),
    }),
  ]);
  return {
    start: (port) =>
      new Promise((resolve) => {
        const server = app.start(port);
        server.once("listening", () => resolve(server));
        if (server.listening) resolve(server);
      }),
    stop: () => (app as { server: Server }).server.close?.() as unknown as Promise<void>,
  };
}

// The ACTUAL current Nural Express adapter (legacy/unoptimized path). Same Zod
// routes as rewrittenNural, but framework:"express" → express.ts runs
// per-request `parseAsync` on input AND output (Zod 4, interpreted) + JSON.
function nuralExpress(): Bootable {
  const app = new Nural({
    framework: "express",
    cors: false,
    helmet: false,
    docs: false,
    logger: { enabled: false },
  });
  app.register([
    createRoute({
      method: "GET",
      path: "/hello",
      responses: { 200: z.object({ hello: z.string() }) },
      handler: async () => ({ hello: "world" }),
    }),
    createRoute({
      method: "POST",
      path: "/users",
      request: { body: zBody },
      responses: { 200: zResp },
      handler: async ({ body }: { body: Parameters<typeof buildResult>[0] }) =>
        buildResult(body),
    }),
  ]);
  return {
    start: (port) =>
      new Promise((resolve) => {
        const server = app.start(port);
        server.once("listening", () => resolve(server));
        if (server.listening) resolve(server);
      }),
    stop: () => (app as { server: Server }).server.close?.() as unknown as Promise<void>,
  };
}

// PRE-F.4 Nural Express baseline: bare Express + express.json() + per-request
// Zod 4 parseAsync on input AND output — exactly what express.ts did BEFORE the
// F.4 fast-path prototype. Both this and nuralExpress() are Zod 4 on the Express
// engine, so their delta isolates the F.4 rewrite (ajv + fast-json-stringify).
function preF4NuralExpress(): Bootable {
  const app = express();
  app.use(express.json());
  app.get("/hello", (_req, res) => res.json({ hello: "world" }));
  app.post("/users", async (req, res) => {
    try {
      const body = await zBody.parseAsync(req.body); // input Zod 4
      const clean = await zResp.parseAsync(buildResult(body)); // output Zod 4
      res.json(clean);
    } catch {
      res.status(400).json({ error: "Validation Error" });
    }
  });
  let server: Server;
  return {
    start: (port) =>
      new Promise((resolve) => {
        server = app.listen(port, () => resolve(server));
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Reconstruction of the PRE-rewrite Nural EXPRESS path: bare Express +
// express.json() + per-request Zod 3 parseAsync on input AND output. This is
// what express.ts did before the Zod 3→4 upgrade — the apples-to-apples "old
// Nural Express" baseline for the Express-to-Express improvement number.
function oldNuralExpressRecon(): Bootable {
  const app = express();
  app.use(express.json());
  app.get("/hello", (_req, res) => res.json({ hello: "world" }));
  app.post("/users", async (req, res) => {
    try {
      const body = await z3Body.parseAsync(req.body); // input Zod 3
      const clean = await z3Resp.parseAsync(buildResult(body)); // output Zod 3
      res.json(clean);
    } catch {
      res.status(400).json({ error: "Validation Error" });
    }
  });
  let server: Server;
  return {
    start: (port) =>
      new Promise((resolve) => {
        server = app.listen(port, () => resolve(server));
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// Faithful reconstruction of the PRE-rewrite Fastify hot path (Zod 3, no schema).
const z3Body = z3.object({
  name: z3.string().min(1).max(100),
  email: z3.string().email(),
  age: z3.number().int().min(0).max(120),
  website: z3.string().url().optional(),
  tags: z3.array(z3.string()).max(20),
  address: z3.object({
    street: z3.string(),
    city: z3.string(),
    zip: z3.string(),
    country: z3.string().length(2),
  }),
  roles: z3.array(z3.enum(["admin", "user", "guest"])),
  metadata: z3.object({ createdAt: z3.string(), score: z3.number() }),
  items: z3
    .array(z3.object({ sku: z3.string(), qty: z3.number().int(), price: z3.number() }))
    .max(200),
});
const z3Resp = z3.object({
  id: z3.string(),
  name: z3.string(),
  email: z3.string(),
  tags: z3.array(z3.string()),
  address: z3.object({
    street: z3.string(),
    city: z3.string(),
    zip: z3.string(),
    country: z3.string(),
  }),
  items: z3.array(
    z3.object({ sku: z3.string(), qty: z3.number().int(), price: z3.number() }),
  ),
});

function currentNuralReconstructed(): Bootable {
  const app = Fastify();
  // hello-world: pre-rewrite had no schema; handler returns object → JSON.stringify.
  app.route({
    method: "GET",
    url: "/hello",
    handler: async (_req, reply) => {
      reply.send({ hello: "world" });
    },
  });
  // validated POST: NO `schema` key → Fastify does nothing; per request we run
  // interpreted Zod 3 on BOTH input and output via parseAsync (the old cost:
  // two microtask hops + interpreted validation + Fastify's fallback serializer).
  app.route({
    method: "POST",
    url: "/users",
    handler: async (req, reply) => {
      const body = await z3Body.parseAsync(req.body); // input Zod 3 (interpreted)
      const result = buildResult(body);
      const clean = await z3Resp.parseAsync(result); // output Zod 3 (interpreted)
      reply.send(clean); // Fastify falls back to JSON.stringify
    },
  });
  return {
    start: (port) => app.listen({ port }).then(() => app.server),
    stop: () => app.close(),
  };
}

// ---- Runner -----------------------------------------------------------------

function runAutocannon(
  path: string,
  method: "GET" | "POST",
): Promise<{ rps: number; latencyMean: number; latencyP99: number }> {
  return new Promise((resolve, reject) => {
    const opts: autocannon.Options = {
      url: `http://localhost:${PORT}${path}`,
      connections: CONNECTIONS,
      duration: DURATION,
      method,
    };
    if (method === "POST") {
      opts.headers = { "content-type": "application/json" };
      opts.body = JSON.stringify(POST_BODY);
    }
    autocannon(opts, (err, result) => {
      if (err) return reject(err);
      const non2xx = (result.non2xx ?? 0) + ((result as { errors?: number }).errors ?? 0);
      if (non2xx > 0) {
        console.warn(
          `  ⚠️  ${method} ${path}: ${non2xx} non-2xx/errors — validation mismatch? numbers unreliable`,
        );
      }
      resolve({
        rps: Math.round(result.requests.average),
        latencyMean: result.latency.mean,
        latencyP99: result.latency.p99,
      });
    });
  });
}

type Row = {
  server: string;
  helloRps: number;
  helloLat: number;
  postRps: number;
  postLat: number;
  postP99: number;
};

async function benchServer(name: string, b: Bootable): Promise<Row> {
  await b.start(PORT);
  // brief warmup
  if (WARMUP) await runAutocannon("/hello", "GET");
  const hello = await runAutocannon("/hello", "GET");
  const post = await runAutocannon("/users", "POST");
  await b.stop();
  await new Promise((r) => setTimeout(r, 400)); // let the port free
  return {
    server: name,
    helloRps: hello.rps,
    helloLat: hello.latencyMean,
    postRps: post.rps,
    postLat: post.latencyMean,
    postP99: post.latencyP99,
  };
}

async function main() {
  const rows: Row[] = [];
  console.log(
    `Bench: ${CONNECTIONS} connections, ${DURATION}s/test (after warmup)\n`,
  );
  rows.push(await benchServer("raw Fastify", rawFastify()));
  console.log("  ✓ raw Fastify done");
  rows.push(await benchServer("raw Express", rawExpress()));
  console.log("  ✓ raw Express done");
  rows.push(await benchServer("rewritten Nural", rewrittenNural()));
  console.log("  ✓ rewritten Nural done");
  rows.push(await benchServer("Nural Express (F.4 fast-path)", nuralExpress()));
  console.log("  ✓ Nural Express (F.4 fast-path) done");
  rows.push(await benchServer("Nural Express pre-F.4 (Zod4)", preF4NuralExpress()));
  console.log("  ✓ Nural Express pre-F.4 done");
  rows.push(await benchServer("old Nural Express (recon)", oldNuralExpressRecon()));
  console.log("  ✓ old Nural Express (recon) done");
  rows.push(await benchServer("current Nural (recon)", currentNuralReconstructed()));
  console.log("  ✓ current Nural (recon) done\n");

  // ---- Report ----
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  console.log(
    pad("server", 24) +
      pad("hello RPS", 12) +
      pad("hello ms", 10) +
      pad("POST RPS", 12) +
      pad("POST ms", 10) +
      pad("POST p99", 10),
  );
  console.log("-".repeat(78));
  for (const r of rows) {
    console.log(
      pad(r.server, 24) +
        pad(r.helloRps, 12) +
        pad(r.helloLat, 10) +
        pad(r.postRps, 12) +
        pad(r.postLat, 10) +
        pad(r.postP99, 10),
    );
  }

  // ---- Gate evaluation ----
  const fastify = rows.find((r) => r.server === "raw Fastify")!;
  const nural = rows.find((r) => r.server === "rewritten Nural")!;
  const current = rows.find((r) => r.server === "current Nural (recon)")!;
  const pct = (a: number, b: number) => (((b - a) / b) * 100).toFixed(1);
  const mult = (a: number, b: number) => (a / b).toFixed(2);

  console.log("\n--- Gate ---");
  console.log(
    `hello: rewritten Nural ${nural.helloRps} vs raw Fastify ${fastify.helloRps} ` +
      `→ ${pct(nural.helloRps, fastify.helloRps)}% below Fastify; ` +
      `${mult(nural.helloRps, current.helloRps)}× current`,
  );
  console.log(
    `POST:  rewritten Nural ${nural.postRps} vs raw Fastify ${fastify.postRps} ` +
      `→ ${pct(nural.postRps, fastify.postRps)}% below Fastify; ` +
      `${mult(nural.postRps, current.postRps)}× current`,
  );

  console.log("\n[JSON]" + JSON.stringify(rows));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
