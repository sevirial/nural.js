import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import { execa } from "execa";
import { fileURLToPath } from "url";
import {
  DEFAULT_PRETTIER_OPTIONS,
  formatGenerated,
  renderTemplate,
} from "./render.js";

// Helper to resolve template path
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const templatePath = (name: string) => {
  // Check if running from dist (templates are siblings) or src (templates are up one level)
  const distPath = path.join(__dirname, "templates", name);
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  return path.join(__dirname, "../templates", name);
};

export async function scaffold(name: string, options: any) {
  const projectPath = path.resolve(process.cwd(), name);
  const spinner = ora(
    `Creating project structure in ${chalk.bold(name)}...`,
  ).start();

  try {
    if (fs.existsSync(projectPath)) {
      spinner.fail(`Directory ${chalk.bold(name)} already exists.`);
      process.exit(1);
    }

    // 1. Create Directory
    await fs.ensureDir(projectPath);

    // 2. Prepare Template Data
    const data = {
      name,
      framework: options.framework.includes("Fastify") ? "fastify" : "express",
      packageManager: options.packageManager,
      integrations: options.integrations || [],
    };

    // 3. Render Templates
    // For now, we'll manually list files. A improved version would walk the templates dir.

    // 3. Render Templates

    // Package.json (Programmatic for better formatting)
    const pkgJson: any = {
      name: name,
      version: "0.0.1",
      description: "Nuraljs Project",
      scripts: {
        dev: "nural dev",
        build: "nural build",
        start: "nural start",
        test: "nural test",
        format: 'prettier --write "src/**/*.ts" "test/**/*.ts"',
      },
      dependencies: {
        "@nuraljs/core": "^1.0.0",
        dotenv: "^17.3.1",
      },
      devDependencies: {
        "@nuraljs/cli": "^1.0.0",
        tsx: "^4.7.1",
        tsup: "^8.0.2",
        typescript: "^5.3.3",
        "@types/node": "^25.2.3",
        vitest: "^1.3.1",
        "@nuraljs/testing": "^1.0.0",
        prettier: "^3.9.5",
      },
    };

    if (data.framework === "fastify") {
      pkgJson.dependencies.fastify = "^5.7.4";
    } else {
      pkgJson.dependencies.express = "^5.2.1";
      pkgJson.devDependencies["@types/express"] = "^5.0.0";
    }

    if (data.integrations.includes("redis")) {
      pkgJson.dependencies.ioredis = "^5.3.2";
    }
    if (data.integrations.includes("ws")) {
      pkgJson.dependencies["socket.io"] = "^4.7.4";
    }
    if (data.integrations.includes("rabbitmq")) {
      pkgJson.dependencies.amqplib = "^0.10.3";
      pkgJson.devDependencies["@types/amqplib"] = "^0.10.1";
    }
    if (data.integrations.includes("prisma-pg")) {
      pkgJson.dependencies["@prisma/client"] = "^7.3.0";
      pkgJson.dependencies["@prisma/adapter-pg"] = "^7.3.0";
      pkgJson.dependencies["pg"] = "^8.11.3";
      pkgJson.devDependencies.prisma = "^7.3.0";
      pkgJson.devDependencies["@types/pg"] = "^8.11.0";
      pkgJson.scripts["db:generate"] = "prisma generate";
      pkgJson.scripts["db:migrate"] = "prisma migrate dev";
    }
    if (data.integrations.includes("mongoose")) {
      pkgJson.dependencies.mongoose = "^9.2.1";
    }

    // Formatted through the same pipeline as everything else, so the project's
    // package.json matches the style of the code beside it.
    const pkgPath = path.join(projectPath, "package.json");
    await fs.outputFile(
      pkgPath,
      await formatGenerated(JSON.stringify(pkgJson, null, 2), pkgPath),
    );

    // TSConfig
    const tsConfigPath = path.join(projectPath, "tsconfig.json");
    await fs.outputFile(
      tsConfigPath,
      await renderTemplate(templatePath("tsconfig.json.ejs"), data, tsConfigPath),
    );

    // .prettierrc — the very options this CLI formats generated code with, so the
    // style is a file the user owns rather than a constant buried in our source.
    // `nural generate` resolves it from the project, so editing it steers all
    // future codegen. Delete it and our defaults (identical) apply instead.
    await fs.outputFile(
      path.join(projectPath, ".prettierrc"),
      `${JSON.stringify(DEFAULT_PRETTIER_OPTIONS, null, 2)}\n`,
    );

    // .env
    const envPath = path.join(projectPath, ".env");
    const envFile = await renderTemplate(templatePath("env.ejs"), data, envPath);
    await fs.outputFile(envPath, envFile);
    await fs.outputFile(path.join(projectPath, ".env.example"), envFile);

    // Source Files Structure
    const dirs = [
      "src/common/exceptions",
      "src/common/middleware",
      "src/common/utils",
      "src/config",
      "src/modules/auth/models",
      "src/modules/auth/schemas",
      "src/modules/users",
      "src/providers",
      "test/e2e" // Proper E2E test folder
    ];
    for (const dir of dirs) {
      await fs.ensureDir(path.join(projectPath, dir));
    }

    const templates = [
      // Config & Main
      { src: "src/config/env.ts.ejs", dest: "src/config/env.ts" },
      { src: "src/app.ts.ejs", dest: "src/app.ts" },
      { src: "src/main.ts.ejs", dest: "src/main.ts" },

      // Auth Module - Models
      { src: "src/modules/auth/models/user.model.ts.ejs", dest: "src/modules/auth/models/user.model.ts" },
      // { src: "src/modules/auth/models/token.model.ts.ejs", dest: "src/modules/auth/models/token.model.ts" },

      // Auth Module - Schemas (Request/Response Split)
      { src: "src/modules/auth/schemas/auth.request.ts.ejs", dest: "src/modules/auth/schemas/auth.request.ts" },
      { src: "src/modules/auth/schemas/auth.response.ts.ejs", dest: "src/modules/auth/schemas/auth.response.ts" },

      // Auth Module - Core
      { src: "src/modules/auth/auth.service.ts.ejs", dest: "src/modules/auth/auth.service.ts" },
      { src: "src/modules/auth/auth.controller.ts.ejs", dest: "src/modules/auth/auth.controller.ts" },
      { src: "src/modules/auth/auth.module.ts.ejs", dest: "src/modules/auth/auth.module.ts" },

      // Docker
      { src: "docker-compose.yml.ejs", dest: "docker-compose.yml" },

      // Tests
      { src: "test/auth.e2e.ts.ejs", dest: "test/e2e/auth.e2e.ts" },

      // Build Config
      { src: "tsup.config.ts.ejs", dest: "tsup.config.ts" },
    ];

    for (const file of templates) {
      const dest = path.join(projectPath, file.dest);
      await fs.outputFile(dest, await renderTemplate(templatePath(file.src), data, dest));
    }

    // Framework-aware `req`/`res` typing. Fastify is the default engine, so a
    // Fastify project needs nothing. Only the legacy Express path overrides the
    // default — scaffold that declaration so Express users get correct types
    // without hand-writing it.
    if (data.framework === "express") {
      const envDest = path.join(projectPath, "src/nural-env.d.ts");
      await fs.outputFile(
        envDest,
        await renderTemplate(templatePath("src/nural-env.d.ts.ejs"), data, envDest),
      );
    }

    // Handle Integrations (Providers) — each selected integration contributes one
    // provider file, rendered from the same pipeline as everything else.
    const providers: Record<string, string> = {
      redis: "redis",
      rabbitmq: "rabbitmq",
      mongoose: "mongoose",
      "prisma-pg": "prisma",
    };
    for (const [integration, provider] of Object.entries(providers)) {
      if (!data.integrations.includes(integration)) continue;
      const dest = path.join(projectPath, `src/providers/${provider}.ts`);
      await fs.outputFile(
        dest,
        await renderTemplate(templatePath(`src/providers/${provider}.ts.ejs`), data, dest),
      );
    }

    if (data.integrations.includes("prisma-pg")) {
      // Also create schema.prisma
      await fs.ensureDir(path.join(projectPath, "prisma"));
      const prismaSchema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
}
`;
      await fs.outputFile(
        path.join(projectPath, "prisma/schema.prisma"),
        prismaSchema,
      );

      // Create prisma.config.ts for v7
      const prismaConfig = `import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  },
});
`;
      await fs.outputFile(
        path.join(projectPath, "prisma.config.ts"),
        prismaConfig,
      );
    }

    spinner.succeed(`Project ${chalk.bold(name)} created!`);

    // 4. Install Dependencies
    console.log(
      chalk.blue(`\nInstalling dependencies with ${options.packageManager}...`),
    );
    const installSpinner = ora("Installing dependencies...").start();

    try {
      const installArgs = ["install"];
      if (options.packageManager === "pnpm") {
        installArgs.push("--ignore-workspace");
      }
      await execa(options.packageManager, installArgs, { cwd: projectPath });
      installSpinner.succeed(
        chalk.green("Dependencies installed successfully!"),
      );
    } catch (error) {
      installSpinner.fail(chalk.red("Failed to install dependencies."));
      console.error(error);
    }

    if (data.integrations.includes("prisma-pg")) {
      const prismaSpinner = ora("Generating Prisma Client...").start();
      try {
        const manager = options.packageManager;
        let cmd = manager;
        let args = ["run", "db:generate"];

        if (manager === "npm") {
          // npm run is default
        } else if (manager === "yarn") {
          // yarn run is default
        }

        // Universal 'run' command works for npm, pnpm, yarn, bun
        await execa(manager, ["run", "db:generate"], { cwd: projectPath });
        prismaSpinner.succeed(chalk.green("Prisma Client generated!"));
      } catch (error) {
        prismaSpinner.fail(chalk.red("Failed to generate Prisma Client."));
        console.error(error);
      }
    }

    console.log(chalk.green(`\n✔ Ready to go!`));
    console.log(chalk.cyan(`  cd ${name}`));
    console.log(chalk.cyan(`  ${options.packageManager} run dev`));
  } catch (error) {
    spinner.fail("Failed to scaffold project.");
    console.error(error);
    process.exit(1);
  }
}
