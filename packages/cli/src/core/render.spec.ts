// ──────────────────────────────────────────────────────────────────
// Generated-output cleanliness.
//
// The bug this pins: EJS emits everything outside its tags verbatim, so a
// conditional line that renders nothing still leaves its indentation and its
// newline behind — scaffolded projects came out full of whitespace-only lines,
// and the default docker-compose.yml was actually INVALID (`depends_on:` with an
// empty list is `null`, which Compose rejects).
//
// Two layers are tested here:
//   1. `normalizeGenerated` — the safety net, unit-tested directly.
//   2. Every shipped template, rendered across every integration combination,
//      asserted to contain no ghost whitespace. This is the layer that would
//      catch a future template losing its `-%>`.
// ──────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs-extra";
import { fileURLToPath } from "url";
import { formatGenerated, normalizeGenerated, renderTemplate } from "./render.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(here, "../templates");

describe("normalizeGenerated", () => {
  it("strips trailing whitespace left by a rendered-away tag", () => {
    expect(normalizeGenerated("async function boot() {\n  \n}\n")).toBe(
      "async function boot() {\n\n}\n",
    );
  });

  it("collapses runs of blank lines to a single separator", () => {
    expect(normalizeGenerated("a\n\n\n\n\nb\n")).toBe("a\n\nb\n");
  });

  it("keeps a single blank line — it is meaningful separation, not noise", () => {
    expect(normalizeGenerated("a\n\nb\n")).toBe("a\n\nb\n");
  });

  it("removes leading blank lines", () => {
    expect(normalizeGenerated("\n\nimport x;\n")).toBe("import x;\n");
  });

  it("ends with exactly one newline, whether there were none or many", () => {
    expect(normalizeGenerated("a")).toBe("a\n");
    expect(normalizeGenerated("a\n\n\n")).toBe("a\n");
  });

  it("never touches indentation on a line that has content", () => {
    const code = "class A {\n  method() {\n    return 1;\n  }\n}\n";
    expect(normalizeGenerated(code)).toBe(code);
  });

  it("is idempotent", () => {
    const messy = "\n\na\n  \n\n\n   b   \n\n";
    expect(normalizeGenerated(normalizeGenerated(messy))).toBe(normalizeGenerated(messy));
  });
});

describe("formatGenerated — Prettier layer", () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => fs.remove(d)));
  });
  const tmpProject = async () => {
    const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nuraljs-fmt-")));
    tmpDirs.push(d);
    return d;
  };

  it("formats TypeScript — not just whitespace, real layout", async () => {
    const ugly = `const x={a:1,b:2};\nfunction f(  a:string ){return a}\n`;
    const out = await formatGenerated(ugly, "/tmp/p/src/x.ts");

    expect(out).toContain("const x = { a: 1, b: 2 };");
    expect(out).toContain("function f(a: string) {");
  });

  it("formats JSON and YAML", async () => {
    expect(await formatGenerated('{"a":1,"b":[1,2]}', "/tmp/p/x.json")).toBe(
      '{ "a": 1, "b": [1, 2] }\n',
    );
    expect(await formatGenerated("a:   1\nb:  2\n", "/tmp/p/x.yml")).toBe("a: 1\nb: 2\n");
  });

  it("leaves a file Prettier has no parser for to the normalizer (.env)", async () => {
    // .env has no Prettier parser — it must still be tidied, not mangled.
    const out = await formatGenerated("PORT=3000   \n\n\n\nDEBUG=true", "/tmp/p/.env");
    expect(out).toBe("PORT=3000\n\nDEBUG=true\n");
  });

  it("falls back to the normalizer when Prettier cannot parse — generation never fails", async () => {
    const broken = "this is (((not valid typescript\n\n\n";
    const out = await formatGenerated(broken, "/tmp/p/src/broken.ts");

    expect(out).toBe("this is (((not valid typescript\n"); // normalized, still written
  });

  it("honours the TARGET project's .prettierrc over our defaults", async () => {
    // A user generating into their own repo should get their house style, the
    // way `nx generate` respects the workspace's config.
    const project = await tmpProject();
    await fs.writeJson(path.join(project, ".prettierrc"), {
      singleQuote: true,
      semi: false,
      tabWidth: 4,
    });

    const out = await formatGenerated(`import x from "y";\nconst a = 1;\n`, path.join(project, "src/a.ts"));

    expect(out).toContain("import x from 'y'"); // their quotes
    expect(out).not.toContain(";"); // their semi: false
  });

  it("uses our defaults when the project has no config", async () => {
    const project = await tmpProject();
    const out = await formatGenerated(`const a = 'x';\n`, path.join(project, "src/a.ts"));

    expect(out).toBe('const a = "x";\n'); // double quotes, semicolon
  });
});

// Every combination that matters: none, each alone, and all together.
const INTEGRATIONS = ["redis", "rabbitmq", "mongoose", "prisma-pg", "ws"];
const COMBOS: string[][] = [[], ...INTEGRATIONS.map((i) => [i]), INTEGRATIONS];
const comboName = (c: string[]) => (c.length ? c.join("+") : "none");

/** Every template rendered by `scaffold`, with the data shape it passes. */
const SCAFFOLD_TEMPLATES = [
  "env.ejs",
  "docker-compose.yml.ejs",
  "tsconfig.json.ejs",
  "tsup.config.ts.ejs",
  "src/app.ts.ejs",
  "src/main.ts.ejs",
  "src/config/env.ts.ejs",
  "src/modules/auth/auth.module.ts.ejs",
  "src/modules/auth/auth.service.ts.ejs",
  "src/modules/auth/auth.controller.ts.ejs",
  "src/modules/auth/models/user.model.ts.ejs",
  "src/modules/auth/schemas/auth.request.ts.ejs",
  "src/modules/auth/schemas/auth.response.ts.ejs",
  "test/auth.e2e.ts.ejs",
];

const data = (integrations: string[]) => ({
  name: "my-app",
  framework: "fastify",
  packageManager: "npm",
  integrations,
});

/**
 * Renders a template exactly as the CLI would: the dest path drives Prettier's
 * parser choice, so it must be the real target name (`src/main.ts`), not the
 * template's (`src/main.ts.ejs`).
 */
const render = (tpl: string, integrations: string[]) =>
  renderTemplate(
    path.join(templatesDir, tpl),
    data(integrations),
    // strip `.ejs` -> the file we'd actually write
    path.join("/tmp/generated-project", tpl.replace(/\.ejs$/, "")),
  );

/** Lines that are non-empty but contain only whitespace — the ghost-line signature. */
const ghostLines = (s: string) =>
  s.split("\n").filter((l) => l !== "" && l.trim() === "");

describe("shipped templates render clean output", () => {
  for (const combo of COMBOS) {
    describe(`integrations: ${comboName(combo)}`, () => {
      it.each(SCAFFOLD_TEMPLATES)("%s has no ghost whitespace", async (tpl) => {
        const out = await render(tpl, combo);

        expect(ghostLines(out)).toEqual([]);
        expect(out).not.toMatch(/\n{3,}/); // no double blank lines
        expect(out.endsWith("\n")).toBe(true);
        expect(out).not.toMatch(/^\n/); // no leading blank line
        expect(out).not.toContain("<%"); // fully rendered
      });
    });
  }
});

describe("conditional content appears only when selected", () => {
  it("main.ts imports a provider only for its integration", async () => {
    expect(await render("src/main.ts.ejs", [])).not.toContain("connectRabbitMQ");
    expect(await render("src/main.ts.ejs", ["rabbitmq"])).toContain("await connectRabbitMQ();");
  });

  it("main.ts binds `server` only when websockets need it (no unused variable)", async () => {
    const without = await render("src/main.ts.ejs", []);
    expect(without).toContain("app.start(Number(env.PORT));");
    expect(without).not.toContain("const server");

    const withWs = await render("src/main.ts.ejs", ["ws"]);
    expect(withWs).toContain("const server = app.start(Number(env.PORT));");
    expect(withWs).toContain("attachSockets(server);");
  });

  it("app.ts only gains the socket wiring for ws", async () => {
    expect(await render("src/app.ts.ejs", [])).not.toContain("attachSockets");
    expect(await render("src/app.ts.ejs", ["ws"])).toContain("export function attachSockets");
  });

  it("env schema only declares the vars its integrations need", async () => {
    const none = await render("src/config/env.ts.ejs", []);
    expect(none).not.toContain("REDIS_URL");
    expect(await render("src/config/env.ts.ejs", ["redis"])).toContain("REDIS_URL");
  });

  it("the e2e suite drops its db hooks — and their imports — when there is no db", async () => {
    const none = await render("test/auth.e2e.ts.ejs", []);
    expect(none).not.toContain("beforeAll("); // no empty hook left behind
    expect(none).not.toContain("connectPrisma");
    // …and vitest is not asked for hooks the file never calls (no unused imports).
    // Note the double quotes: the template is authored with single quotes, and
    // Prettier normalizes them — which is exactly why it runs.
    expect(none).toContain('import { describe, expect, it } from "vitest";');

    const withDb = await render("test/auth.e2e.ts.ejs", ["prisma-pg"]);
    expect(withDb).toContain("await connectPrisma();");
    expect(withDb).toContain("await prisma.$disconnect();");
  });
});

describe("docker-compose.yml is structurally valid", () => {
  const compose = (integrations: string[]) => render("docker-compose.yml.ejs", integrations);

  it("omits depends_on entirely when no service is depended on (was: `depends_on: null`)", async () => {
    const out = await compose([]);
    // The original bug: `depends_on:` was emitted with an empty list, which
    // Compose rejects with "services.app.depends_on must be a array".
    expect(out).not.toContain("depends_on");
  });

  it("lists exactly the services selected", async () => {
    const out = await compose(["redis", "mongoose"]);
    expect(out).toContain("depends_on:");
    expect(out).toContain("- redis");
    expect(out).toContain("- mongo");
    expect(out).not.toContain("- postgres");
    expect(out).toContain("  redis:");
    expect(out).toContain("  mongo:");
    expect(out).not.toContain("  postgres:");
  });

  it("never emits a key with an empty block", async () => {
    for (const combo of COMBOS) {
      const out = await compose(combo);
      // A key whose value is a block must be followed by a deeper-indented line.
      const lines = out.split("\n").filter((l) => l !== "");
      lines.forEach((line, i) => {
        if (!/^\s*[\w-]+:\s*$/.test(line)) return;
        const indent = line.match(/^\s*/)![0].length;
        const next = lines[i + 1];
        expect(next, `"${line.trim()}" has an empty block (${comboName(combo)})`).toBeDefined();
        expect(next!.match(/^\s*/)![0].length, `"${line.trim()}" (${comboName(combo)})`).toBeGreaterThan(indent);
      });
    }
  });
});

describe("templates are authored with whitespace control", () => {
  it("no logic tag shares a line with emitted content", async () => {
    // The root cause, guarded at the source: `<% if (x) { %>text<% } %>` on one
    // line leaves that line's newline behind when x is false. A block tag must
    // own its line and slurp with `-%>`.
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name.endsWith(".ejs")) files.push(p);
      }
    };
    await walk(templatesDir);
    expect(files.length).toBeGreaterThan(20); // sanity: we actually found them

    const offenders: string[] = [];
    for (const file of files) {
      const src = await fs.readFile(file, "utf-8");
      src.split("\n").forEach((line, i) => {
        // Only a tag that OPENS a line can strand that line's newline/indent when
        // it renders to nothing — it must therefore slurp with `-%>`. A tag used
        // mid-line (e.g. `import { app<% if (ws) { %>, attachSockets<% } %> }`)
        // is fine: the surrounding text is emitted either way, so there is no
        // ghost line to leave behind.
        if (!/^\s*<%[^=]/.test(line)) return;
        if (!/-%>\s*$/.test(line)) {
          offenders.push(`${path.relative(templatesDir, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no template carries CRLF line endings", async () => {
    // 18 templates were once saved as CRLF, putting a `\r` at the end of every
    // generated line. `.gitattributes` pins them to LF; this catches a stray one.
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.name.endsWith(".ejs")) files.push(p);
      }
    };
    await walk(templatesDir);

    const crlf = files.filter((f) => fs.readFileSync(f, "utf-8").includes("\r"));
    expect(crlf.map((f) => path.relative(templatesDir, f))).toEqual([]);
  });
});
