// ──────────────────────────────────────────────────────────────────
// `nural new` — project scaffolding.
//
// Runs the REAL scaffold against a temp cwd, with only the two things that reach
// outside the process stubbed: `execa` (we don't want a real `npm install` in a
// unit test) and `process.exit` (it would kill the test runner). Everything else
// — directory layout, template rendering, the programmatic package.json — is
// exercised for real, because those are the artifacts a user actually gets.
// ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "path";
import os from "os";

const execa = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "" })));
vi.mock("execa", () => ({ execa }));

import * as prettier from "prettier";
import { scaffold } from "./scaffold.js";
import { DEFAULT_PRETTIER_OPTIONS } from "./render.js";

let tmp: string;
let origCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  origCwd = process.cwd();
  // realpath: on macOS os.tmpdir() is /var/… which symlinks to /private/var/…,
  // and `scaffold` builds its path from `process.cwd()` (already resolved). Without
  // this, the two spellings of the same dir wouldn't compare equal.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nuraljs-cli-new-")));
  process.chdir(tmp);
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // `scaffold` calls process.exit on failure; make it throw so a test can assert
  // on it instead of tearing down the runner.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  process.chdir(origCwd);
  await fs.remove(tmp);
});

/** Options as `new.ts` passes them (framework comes from a prompt label). */
const opts = (over: Partial<Record<string, unknown>> = {}) => ({
  framework: "Fastify (Recommended)",
  packageManager: "npm",
  integrations: [],
  ...over,
});

const readJson = (p: string) => fs.readJson(path.join(tmp, "my-app", p));
const read = (p: string) => fs.readFile(path.join(tmp, "my-app", p), "utf-8");
const exists = (p: string) => fs.existsSync(path.join(tmp, "my-app", p));

describe("scaffold — project structure", () => {
  it("creates the documented source tree and entry points", async () => {
    await scaffold("my-app", opts());

    for (const f of [
      "package.json",
      "tsconfig.json",
      ".env",
      ".env.example",
      "docker-compose.yml",
      "tsup.config.ts",
      "src/app.ts",
      "src/main.ts",
      "src/config/env.ts",
      "src/modules/auth/auth.module.ts",
      "src/modules/auth/auth.service.ts",
      "src/modules/auth/auth.controller.ts",
      "src/modules/auth/models/user.model.ts",
      "src/modules/auth/schemas/auth.request.ts",
      "src/modules/auth/schemas/auth.response.ts",
      "test/e2e/auth.e2e.ts",
    ]) {
      expect(exists(f), `${f} should exist`).toBe(true);
    }
  });

  it("renders every template — no raw EJS tags leak into the generated app", async () => {
    await scaffold("my-app", opts());

    for (const f of ["src/app.ts", "src/main.ts", "src/config/env.ts", "tsconfig.json"]) {
      expect(await read(f), `${f} should be rendered`).not.toContain("<%");
    }
  });

  it("names the package after the project", async () => {
    await scaffold("my-app", opts());
    expect(await readJson("package.json")).toMatchObject({
      name: "my-app",
      version: "0.0.1",
      scripts: { dev: "nural dev", build: "nural build" },
    });
  });

  it("fails instead of clobbering an existing directory", async () => {
    await fs.ensureDir(path.join(tmp, "my-app"));
    await fs.outputFile(path.join(tmp, "my-app/keep.txt"), "precious");

    await expect(scaffold("my-app", opts())).rejects.toThrow(/process.exit\(1\)/);

    expect(await read("keep.txt")).toBe("precious"); // untouched
    expect(exists("package.json")).toBe(false); // nothing scaffolded over it
  });
});

describe("scaffold — engine selection", () => {
  it("Fastify: adds fastify, not express", async () => {
    await scaffold("my-app", opts({ framework: "Fastify (Recommended)" }));
    const pkg = await readJson("package.json");

    expect(pkg.dependencies).toHaveProperty("fastify");
    expect(pkg.dependencies).not.toHaveProperty("express");
  });

  it("Express: adds express + its types, not fastify", async () => {
    await scaffold("my-app", opts({ framework: "Express" }));
    const pkg = await readJson("package.json");

    expect(pkg.dependencies).toHaveProperty("express");
    expect(pkg.devDependencies).toHaveProperty("@types/express");
    expect(pkg.dependencies).not.toHaveProperty("fastify");
  });

  it("always depends on the core + testing packages", async () => {
    await scaffold("my-app", opts());
    const pkg = await readJson("package.json");

    expect(pkg.dependencies).toHaveProperty("@nuraljs/core");
    expect(pkg.devDependencies).toHaveProperty("@nuraljs/cli");
    expect(pkg.devDependencies).toHaveProperty("@nuraljs/testing");
  });
});

describe("scaffold — Prettier is set up, not just applied", () => {
  it("ships a .prettierrc, the devDependency, and a format script", async () => {
    await scaffold("my-app", opts());

    expect(exists(".prettierrc")).toBe(true);
    const pkg = await readJson("package.json");
    expect(pkg.devDependencies).toHaveProperty("prettier");
    expect(pkg.scripts.format).toContain("prettier --write");
  });

  it("the shipped .prettierrc IS the config the CLI formats with — they cannot drift", async () => {
    // This is the reason both are derived from one constant: if the file said one
    // thing and the generator did another, `nural g` would fight `pnpm format`.
    await scaffold("my-app", opts());
    expect(await readJson(".prettierrc")).toEqual(DEFAULT_PRETTIER_OPTIONS);
  });

  it("the generated project already satisfies its own .prettierrc", async () => {
    // The end-to-end promise: a fresh project passes `pnpm format --check` on day
    // one, so the first `format` run is not a repo-wide diff.
    await scaffold("my-app", opts());
    const config = await readJson(".prettierrc");

    for (const f of ["src/app.ts", "src/main.ts", "src/modules/auth/auth.service.ts"]) {
      const source = await read(f);
      const formatted = await prettier.format(source, { ...config, parser: "typescript" });
      expect(formatted, `${f} should already be formatted`).toBe(source);
    }
  });
});

describe("scaffold — integrations", () => {
  it.each([
    ["redis", "ioredis", "src/providers/redis.ts"],
    ["mongoose", "mongoose", "src/providers/mongoose.ts"],
    ["rabbitmq", "amqplib", "src/providers/rabbitmq.ts"],
  ])("%s adds its dependency and provider", async (integration, dep, provider) => {
    await scaffold("my-app", opts({ integrations: [integration] }));

    expect((await readJson("package.json")).dependencies).toHaveProperty(dep);
    expect(exists(provider)).toBe(true);
  });

  it("ws adds socket.io (no provider file)", async () => {
    await scaffold("my-app", opts({ integrations: ["ws"] }));
    expect((await readJson("package.json")).dependencies).toHaveProperty("socket.io");
  });

  it("prisma-pg adds the client, schema, config, and db scripts", async () => {
    await scaffold("my-app", opts({ integrations: ["prisma-pg"] }));
    const pkg = await readJson("package.json");

    expect(pkg.dependencies).toHaveProperty("@prisma/client");
    expect(pkg.dependencies).toHaveProperty("pg");
    expect(pkg.scripts["db:generate"]).toBe("prisma generate");
    expect(exists("prisma/schema.prisma")).toBe(true);
    expect(exists("prisma.config.ts")).toBe(true);
    expect(exists("src/providers/prisma.ts")).toBe(true);
  });

  it("adds nothing extra when no integrations are selected", async () => {
    await scaffold("my-app", opts());
    const pkg = await readJson("package.json");

    for (const dep of ["ioredis", "mongoose", "amqplib", "socket.io", "@prisma/client"]) {
      expect(pkg.dependencies).not.toHaveProperty(dep);
    }
    expect(exists("src/providers/redis.ts")).toBe(false);
  });

  it("composes several integrations at once", async () => {
    await scaffold("my-app", opts({ integrations: ["redis", "mongoose"] }));
    const pkg = await readJson("package.json");

    expect(pkg.dependencies).toHaveProperty("ioredis");
    expect(pkg.dependencies).toHaveProperty("mongoose");
    expect(exists("src/providers/redis.ts")).toBe(true);
    expect(exists("src/providers/mongoose.ts")).toBe(true);
  });
});

describe("scaffold — dependency install", () => {
  it("installs with the chosen package manager, in the new project dir", async () => {
    await scaffold("my-app", opts({ packageManager: "npm" }));

    expect(execa).toHaveBeenCalledWith("npm", ["install"], {
      cwd: path.join(tmp, "my-app"),
    });
  });

  it("passes --ignore-workspace for pnpm, so a nested project isn't absorbed into a parent workspace", async () => {
    await scaffold("my-app", opts({ packageManager: "pnpm" }));

    expect(execa).toHaveBeenCalledWith("pnpm", ["install", "--ignore-workspace"], {
      cwd: path.join(tmp, "my-app"),
    });
  });

  it("runs db:generate after install when prisma is selected", async () => {
    await scaffold("my-app", opts({ integrations: ["prisma-pg"] }));

    expect(execa).toHaveBeenCalledWith("npm", ["run", "db:generate"], {
      cwd: path.join(tmp, "my-app"),
    });
  });

  it("does not run db:generate without prisma", async () => {
    await scaffold("my-app", opts());

    const calls = execa.mock.calls.map((c) => JSON.stringify(c));
    expect(calls.some((c) => c.includes("db:generate"))).toBe(false);
  });

  it("keeps the scaffolded project when install fails — the files are still usable", async () => {
    execa.mockRejectedValueOnce(new Error("network down"));

    await scaffold("my-app", opts()); // must not throw

    expect(exists("package.json")).toBe(true);
    expect(exists("src/main.ts")).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled(); // a failed install is not fatal
  });
});
