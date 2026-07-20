#!/usr/bin/env node
import { Command } from "commander";
import { newCommand } from "./commands/new.js";
import { generateCommand } from "./commands/generate.js";
import { addCommand } from "./commands/add.js";
import { infoCommand } from "./commands/info.js";
import { devCommand } from "./commands/dev.js";
import { buildCommand } from "./commands/build.js";
import { startCommand } from "./commands/start.js";
import { testCommand } from "./commands/test.js";
import { docsCommand } from "./commands/docs.js";
import { routesCommand } from "./commands/routes.js";
import { consoleCommand } from "./commands/console.js";
import { cleanCommand } from "./commands/clean.js";
import { doctorCommand } from "./commands/doctor.js";
import { completionCommand } from "./commands/completion.js";
import { updateCommand } from "./commands/update.js";
import { tokenInspectCommand } from "./commands/token.js";
import { createRequire } from "module";

// Read the version from package.json rather than hardcoding it — a literal here
// silently lies the moment the package is versioned. `dist/index.js` sits one
// level under the package root, and npm always ships package.json.
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const program = new Command();

program
  .name("nural")
  .description("Nuraljs CLI - The intelligent framework tool")
  .version(version);

program
  .command("new <project-name>")
  .description("Scaffold a new Nuraljs project")
  .action(newCommand);

program
  .command("generate <schematic> [name]")
  .alias("g")
  .description("Generate code (resource, middleware, provider, filter)")
  .action(generateCommand);

program
  .command("add [integration]")
  .description("Add an integration to the project (redis, rabbitmq, mongoose, prisma-pg)")
  .action(addCommand);

program
  .command("info")
  .description("Print environment + project diagnostics (handy for bug reports)")
  .action(infoCommand);

program
  .command("dev")
  .description("Start the development server")
  .option("-w, --watch", "Enable polling mode for WSL/Docker compatibility")
  .action(devCommand);

program
  .command("build")
  .description("Build the application for production")
  .option("--ignore-ts-errors", "Proceed with build even if TypeScript checks fail")
  .action(buildCommand);

program
  .command("start")
  .description("Run the production application")
  .option("--debug", "Run in debug mode (inspector enabled)")
  .action(startCommand);

program
  .command("test")
  .description("Run application tests")
  .option("-w, --watch", "Run in watch mode")
  .option("-c, --coverage", "Generate coverage report")
  .option("--e2e", "Run end-to-end tests only")
  .action(testCommand);

program
  .command("docs")
  .description("Generate a static OpenAPI specification file")
  .option("-o, --output <file>", "Output file path", "openapi.json")
  .action(docsCommand);

program
  .command("routes")
  .alias("list")
  .description("List all registered routes")
  .action(routesCommand);

program
  .command("console")
  .alias("c")
  .alias("tinker")
  .description("Launch an interactive application shell (REPL)")
  .action(consoleCommand);

program
  .command("clean")
  .description("Remove build artifacts and temporary files")
  .action(cleanCommand);

program
  .command("doctor")
  .description("Check your system and project health")
  .action(doctorCommand);

program
  .command("completion")
  .description("Generate shell completion script")
  .action(completionCommand(program));

program
  .command("update")
  .alias("u")
  .description("Update Nuraljs dependencies to the latest version")
  .action(updateCommand);

const token = program
  .command("token")
  .description("Inspect Nuraljs auth tokens (the secure equivalent of jwt.io)");

token
  .command("inspect <token>")
  .description("Decode a token's public envelope; decrypt its claims with your key")
  .option("-s, --secret <secret>", `Signing secret (prefer ${"NURALJS_AUTH_SECRET"} or --key-file)`)
  .option("-k, --key-file <path>", "Read the signing secret from a file")
  .option("--redact", "Show claim keys and types but not their values")
  .option("--json", "Output machine-readable JSON")
  .action(tokenInspectCommand);

program.parse(process.argv);
