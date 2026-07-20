import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import os from "os";

export async function infoCommand() {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");

  console.log(chalk.bold("\n  Nuraljs CLI Information\n"));

  console.log(chalk.blue("  System:"));
  console.log(`    OS: ${os.type()} ${os.release()} ${os.arch()}`);
  console.log(`    Node: ${process.version}`);

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = await fs.readJson(pkgPath);
      console.log(chalk.blue("\n  Project:"));
      console.log(`    Name: ${pkg.name}`);
      console.log(`    Version: ${pkg.version}`);

      console.log(chalk.blue("\n  Dependencies:"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const coreDeps = ["@nuraljs/core", "fastify", "express", "zod", "typescript"];

      coreDeps.forEach((dep) => {
        if (allDeps[dep]) {
          console.log(`    ${dep}: ${allDeps[dep]}`);
        }
      });

      // Surface any other scoped @nuraljs/* dependencies (e.g. plugins).
      Object.keys(allDeps).forEach((key) => {
        if (key.startsWith("@nuraljs/") && key !== "@nuraljs/core") {
          console.log(`    ${key}: ${allDeps[key]}`);
        }
      });
    } catch {
      // Silently continue if invalid package.json
    }
  } else {
    console.log(chalk.yellow("\n  (Not inside a Nuraljs project)"));
  }
  console.log("");
}
