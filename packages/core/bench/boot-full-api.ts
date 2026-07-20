/**
 * T6.7 / T6.8 — Boot examples/full-api on the Fastify engine and hit it over
 * real HTTP. Reuses the example's ACTUAL appConfig + route definitions (the
 * only thing skipped is server.ts's socket.io wrapper, which is orthogonal to
 * the Nural verification). Run: pnpm dlx tsx packages/core/bench/boot-full-api.ts
 */

import { Nural } from "nural";
import { createRequire } from "node:module";

// The example modules resolve as CommonJS (no `type: module` up-tree), while
// this harness is ESM — use createRequire for clean named-export interop.
const require = createRequire(import.meta.url);
const { appConfig } = require("../../../examples/full-api/src/config/app.config");
const { authRoutes } = require("../../../examples/full-api/src/routes/auth.routes");
const { userRoutes } = require("../../../examples/full-api/src/routes/user.routes");
const { healthRoutes } = require("../../../examples/full-api/src/routes/health.routes");

const PORT = 3131;
const BASE = `http://localhost:${PORT}`;
const ADMIN_TOKEN = "user:550e8400-e29b-41d4-a716-446655440001"; // seeded admin

let failures = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};

async function waitReady(retries = 50): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready");
}

async function main() {
  const app = new Nural(appConfig);
  app.register([...healthRoutes, ...authRoutes, ...userRoutes]);
  const server = app.start(PORT);

  try {
    await waitReady();

    // ---- Health (fast path, no auth) ----
    const health = await fetch(`${BASE}/health`);
    const healthBody = await health.json();
    ok("GET /health → 200", health.status === 200);
    ok("GET /health status=ok", healthBody.status === "ok");

    // ---- Docs UI (T6.8) ----
    const docs = await fetch(`${BASE}/docs`);
    const docsHtml = await docs.text();
    ok("GET /docs → 200", docs.status === 200);
    ok(
      "GET /docs returns HTML",
      /text\/html/.test(docs.headers.get("content-type") || "") &&
        docsHtml.toLowerCase().includes("<html"),
    );

    // ---- OpenAPI spec (T6.8) ----
    const spec = await fetch(`${BASE}/docs/openapi.json`);
    const specBody = await spec.json();
    ok("GET /docs/openapi.json → 200", spec.status === 200);
    ok(
      "openapi.json is a 3.0 document",
      typeof specBody.openapi === "string" && specBody.openapi.startsWith("3."),
      `openapi=${specBody.openapi}`,
    );
    ok(
      "openapi.json has paths for the example routes",
      !!specBody.paths &&
        !!specBody.paths["/health"] &&
        !!specBody.paths["/auth/login"] &&
        !!specBody.paths["/users"],
    );
    ok(
      "openapi.json carries securitySchemes (bearerAuth)",
      !!specBody.components?.securitySchemes?.bearerAuth,
    );

    // ---- 401-before-400 on the auth-protected, body-validated route ----
    // POST /users has middleware [auth, admin] AND a body schema.
    // (a) no auth + invalid body → auth runs first (preValidation) → 401.
    const noAuthBadBody = await fetch(`${BASE}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "valid" }),
    });
    ok(
      "401-before-400: no token + invalid body → 401 (auth precedes validation)",
      noAuthBadBody.status === 401,
      `got ${noAuthBadBody.status}`,
    );

    // (b) valid admin auth + invalid body → auth passes, ajv rejects body → 400.
    const authBadBody = await fetch(`${BASE}/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ not: "valid" }),
    });
    const authBadBodyJson = await authBadBody.json();
    ok(
      "401-before-400: admin token + invalid body → 400 (validation runs after auth)",
      authBadBody.status === 400,
      `got ${authBadBody.status}`,
    );
    // NOTE: POST /users declares `400: ErrorSchema` ({error, message}), so
    // fast-json-stringify shapes the error-handler's 400 reply to exactly that
    // schema — `details`/`stack` are (correctly) stripped. So we assert the
    // ErrorSchema envelope, not the raw handler body. (Byte-for-byte `details`
    // parity is covered by the testing suite on routes with no declared error
    // response schema.)
    ok(
      "  → 400 body matches the declared ErrorSchema {error, message}",
      authBadBodyJson.error === "Validation Error" &&
        authBadBodyJson.message === "Request validation failed",
    );

    // (c) valid admin auth + valid body → 201 created (full happy path).
    const created = await fetch(`${BASE}/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        email: "new@example.com",
        name: "New User",
        password: "secret12",
        role: "user",
      }),
    });
    ok("admin + valid body → 201 created", created.status === 201, `got ${created.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
