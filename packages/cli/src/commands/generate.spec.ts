// ──────────────────────────────────────────────────────────────────
// `nural generate` — schematic resolution, file emission, and the auto-wiring
// that edits a user's app.ts / main.ts.
//
// These run the REAL command against a REAL temp project directory (no fs mock):
// `generateCommand` only touches `process.cwd()` and the shipped templates, so a
// chdir into a scratch dir exercises the same path a user hits. The auto-wiring
// is plain string surgery over the user's source file — the most fragile thing
// here, and the reason these tests exist.
// ──────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "path";
import os from "os";

// The command prints through these; silence them so the suite output stays readable.
vi.mock("../ui/index.js", async () => {
  const actual = await vi.importActual<typeof import("../ui/index.js")>("../ui/index.js");
  return {
    ...actual,
    CliLogger: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn() },
    CliPrompts: { select: vi.fn(), input: vi.fn() },
  };
});

import { generateCommand } from "./generate.js";
import { CliLogger, CliPrompts } from "../ui/index.js";

const logger = CliLogger as unknown as Record<string, ReturnType<typeof vi.fn>>;
const prompts = CliPrompts as unknown as Record<string, ReturnType<typeof vi.fn>>;

let tmp: string;
let origCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  origCwd = process.cwd();
  // realpath: macOS's /var/… tmpdir symlinks to /private/var/…, and the command
  // resolves paths from `process.cwd()`. Keep both spellings identical.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nuraljs-cli-gen-")));
  process.chdir(tmp);
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  process.chdir(origCwd);
  await fs.remove(tmp);
});

const read = (p: string) => fs.readFile(path.join(tmp, p), "utf-8");
const exists = (p: string) => fs.existsSync(path.join(tmp, p));

/** A minimal app.ts like the one `nural new` scaffolds. */
const APP_TS = `import { Nuraljs } from "@nuraljs/core";
import { authModule } from "./modules/auth/auth.module";

export const app = new Nuraljs({ framework: "fastify" });
app.registerModule(authModule);
`;

/** A minimal main.ts like the one `nural new` scaffolds. */
const MAIN_TS = `import { app } from "./app";

async function bootstrap() {
  await app.start(3000);
}

bootstrap();
`;

describe("generate — resource schematic", () => {
  it("emits the full module: model, request/response schemas, service, controller, module", async () => {
    await generateCommand("resource", "product");

    for (const f of [
      "src/modules/product/models/product.model.ts",
      "src/modules/product/schemas/product.request.ts",
      "src/modules/product/schemas/product.response.ts",
      "src/modules/product/product.service.ts",
      "src/modules/product/product.controller.ts",
      "src/modules/product/product.module.ts",
    ]) {
      expect(exists(f), `${f} should exist`).toBe(true);
    }
  });

  it("renders the templates with the name cased correctly", async () => {
    await generateCommand("resource", "product");
    const service = await read("src/modules/product/product.service.ts");

    // The template data is { name: "Product", className, fileName, camelName } —
    // if a template ever renders a raw EJS tag, this catches it.
    expect(service).not.toContain("<%");
    expect(service).toMatch(/Product/);
  });

  it("lowercases the file name and capitalizes the class (`Product` -> product.*)", async () => {
    await generateCommand("resource", "Product");

    // Read the real directory entries: `existsSync` would answer case-
    // insensitively on macOS/Windows and hide a casing bug.
    expect(await fs.readdir(path.join(tmp, "src/modules"))).toEqual(["product"]);
    expect(await fs.readdir(path.join(tmp, "src/modules/product"))).toContain(
      "product.service.ts",
    );
    // The class inside is capitalized even though the path is not.
    expect(await read("src/modules/product/product.service.ts")).toMatch(/Product/);
  });

  it("wires the module from the controller namespace, not hardcoded handler names", async () => {
    await generateCommand("resource", "product");
    const module = await read("src/modules/product/product.module.ts");
    const controller = await read("src/modules/product/product.controller.ts");

    // The module imports the controller as a namespace and registers every
    // exported route via Object.values — so it can never name a handler the
    // controller doesn't export (the TS2724 class of bug).
    expect(module).toContain(`import * as ProductController from "./product.controller";`);
    expect(module).toContain("routes: Object.values(ProductController)");

    // Guard against a regression to per-handler named imports: the module must
    // not re-declare handler names that would drift from the controller.
    expect(module).not.toMatch(/import \{[^}]*\} from "\.\/product\.controller"/);

    // Sanity: the controller is the sole source of those handler names.
    expect(controller).toMatch(/export const getProducts\b/);
  });

  it("refuses to overwrite an existing module", async () => {
    await generateCommand("resource", "product");
    const before = await read("src/modules/product/product.service.ts");

    await generateCommand("resource", "product"); // again

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/already exists/));
    expect(await read("src/modules/product/product.service.ts")).toBe(before); // untouched
  });
});

describe("generate — schematic resolution", () => {
  it("treats a bare name as the resource shorthand (`nural g product`)", async () => {
    await generateCommand("product", ""); // no schematic given

    expect(exists("src/modules/product/product.module.ts")).toBe(true);
    expect(prompts.select).not.toHaveBeenCalled(); // resolved without asking
  });

  it("does NOT treat a real schematic name as a resource name", async () => {
    prompts.input.mockResolvedValue("audit");
    await generateCommand("middleware", ""); // schematic given, name missing

    expect(prompts.input).toHaveBeenCalled(); // asked for the name instead
    expect(exists("src/common/middleware/audit.middleware.ts")).toBe(true);
    expect(exists("src/modules/middleware")).toBe(false); // not scaffolded as a resource
  });

  it("prompts for both when neither is given", async () => {
    prompts.select.mockResolvedValue("filter");
    prompts.input.mockResolvedValue("http");
    await generateCommand("", "");

    expect(exists("src/common/filters/http.filter.ts")).toBe(true);
  });

  it("rejects an unknown schematic without writing anything", async () => {
    await generateCommand("controller", "product"); // not a schematic here

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Unknown schematic/));
    expect(exists("src")).toBe(false); // nothing created at all
  });
});

describe("generate — granular schematics", () => {
  it.each([
    ["middleware", "src/common/middleware/audit.middleware.ts"],
    ["filter", "src/common/filters/audit.filter.ts"],
    ["provider", "src/providers/audit.provider.ts"],
  ])("%s lands at its conventional path", async (schematic, expected) => {
    await generateCommand(schematic, "audit");
    expect(exists(expected)).toBe(true);
    expect(await read(expected)).not.toContain("<%"); // template actually rendered
  });

  it("refuses to overwrite an existing file", async () => {
    await generateCommand("middleware", "audit");
    await fs.outputFile(path.join(tmp, "src/common/middleware/audit.middleware.ts"), "// mine");

    await generateCommand("middleware", "audit");

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/already exists/));
    expect(await read("src/common/middleware/audit.middleware.ts")).toBe("// mine");
  });
});

describe("generate — auto-wiring a module into app.ts", () => {
  beforeEach(async () => {
    await fs.outputFile(path.join(tmp, "src/app.ts"), APP_TS);
  });

  it("adds the import and registers the module after the last registration", async () => {
    await generateCommand("resource", "product");
    const app = await read("src/app.ts");

    expect(app).toContain(`import { productModule } from "./modules/product/product.module";`);
    expect(app).toContain("app.registerModule(productModule);");
    // Order matters: the new registration must come after the existing one.
    expect(app.indexOf("registerModule(productModule)")).toBeGreaterThan(
      app.indexOf("registerModule(authModule)"),
    );
    // …and the import must precede its use.
    expect(app.indexOf("import { productModule }")).toBeLessThan(
      app.indexOf("app.registerModule(productModule)"),
    );
  });

  it("is idempotent — a second generate does not double-register", async () => {
    await generateCommand("resource", "product");
    await fs.remove(path.join(tmp, "src/modules/product")); // let it regenerate
    await generateCommand("resource", "product");

    const app = await read("src/app.ts");
    expect(app.match(/registerModule\(productModule\)/g)).toHaveLength(1);
    expect(app.match(/import \{ productModule \}/g)).toHaveLength(1);
  });

  it("still registers when app.ts has no existing registerModule call", async () => {
    await fs.outputFile(
      path.join(tmp, "src/app.ts"),
      `import { Nuraljs } from "@nuraljs/core";\nexport const app = new Nuraljs({});\n`,
    );
    await generateCommand("resource", "product");

    const app = await read("src/app.ts");
    expect(app).toContain("app.registerModule(productModule);");
  });

  it("formats the file it edited, so the wiring matches the project's own style", async () => {
    // The project's house style: single quotes, no semicolons.
    await fs.writeJson(path.join(tmp, ".prettierrc"), { singleQuote: true, semi: false });
    await generateCommand("resource", "product");

    const app = await read("src/app.ts");
    expect(app).toContain("import { productModule } from './modules/product/product.module'");
    expect(app).toContain("app.registerModule(productModule)");
    expect(app).not.toContain(";"); // our insert follows their style, not ours
  });

  it("warns instead of crashing when app.ts is missing", async () => {
    await fs.remove(path.join(tmp, "src/app.ts"));
    await generateCommand("resource", "product");

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/src\/app\.ts/));
    expect(exists("src/modules/product/product.module.ts")).toBe(true); // files still emitted
  });
});

describe("generate — auto-wiring a provider into main.ts", () => {
  beforeEach(async () => {
    await fs.outputFile(path.join(tmp, "src/main.ts"), MAIN_TS);
  });

  it("adds the import and registers the provider before app.start()", async () => {
    await generateCommand("provider", "cache");
    const main = await read("src/main.ts");

    expect(main).toContain(`import { cacheProvider } from "./providers/cache.provider";`);
    expect(main).toContain("await app.registerProvider(cacheProvider);");
    // The registration must happen BEFORE the server starts, or it's useless.
    expect(main.indexOf("registerProvider(cacheProvider)")).toBeLessThan(
      main.indexOf("app.start("),
    );
  });

  it("is idempotent across repeated generates", async () => {
    await generateCommand("provider", "cache");
    await fs.remove(path.join(tmp, "src/providers/cache.provider.ts"));
    await generateCommand("provider", "cache");

    const main = await read("src/main.ts");
    expect(main.match(/registerProvider\(cacheProvider\)/g)).toHaveLength(1);
  });

  it("falls back to a TODO comment when app.start() is absent", async () => {
    await fs.outputFile(path.join(tmp, "src/main.ts"), `import { app } from "./app";\n`);
    await generateCommand("provider", "cache");

    const main = await read("src/main.ts");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/app\.start\(\)/));
    expect(main).toContain("// TODO");
    expect(main).toContain("registerProvider(cacheProvider)");
  });

  it("warns instead of crashing when main.ts is missing", async () => {
    await fs.remove(path.join(tmp, "src/main.ts"));
    await generateCommand("provider", "cache");

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/src\/main\.ts/));
    expect(exists("src/providers/cache.provider.ts")).toBe(true);
  });

  it("does not wire a middleware/filter into main.ts (providers only)", async () => {
    await generateCommand("middleware", "audit");
    expect(await read("src/main.ts")).toBe(MAIN_TS); // untouched
  });
});
