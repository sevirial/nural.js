import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import { CliLogger, chalk } from "../ui/index.js";

export async function buildCommand(options: { ignoreTsErrors?: boolean }) {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  const tsupConfig = path.join(cwd, "tsup.config.ts");

  if (!fs.existsSync(pkgPath)) {
    CliLogger.error("package.json not found. Are you in a Nuraljs project?");
    process.exit(1);
  }

  console.log(chalk.bold.blue("\n  📦 Building for production...\n"));

  // 1. Type Checking (Strict by Default)
  CliLogger.startSpinner("Running type checks...");
  try {
    // We capture stdout to print it nicely on failure
    await execa("tsc", ["--noEmit"], { cwd, preferLocal: true });
    CliLogger.succeedSpinner("Type checks passed.");
  } catch (error: any) {
    CliLogger.failSpinner("Type check failed.");

    // 🟢 Show the actual errors
    if (error.stdout) {
      console.log("\n" + chalk.red(error.stdout.trim()));
    }

    // 🟢 Strict Exit Logic
    if (!options.ignoreTsErrors) {
      console.error(chalk.bold.red("\n❌ Build aborted due to TypeScript errors."));
      CliLogger.dim("  To force a build, run: nural build --ignore-ts-errors");
      process.exit(1);
    }

    CliLogger.warn("\n⚠  Proceeding with build despite errors (--ignore-ts-errors active)\n");
  }

  // 2. Build Process (TSUP)
  CliLogger.startSpinner("Compiling assets...");
  try {
    const buildArgs = ["--env.NODE_ENV", "production"];

    if (!fs.existsSync(tsupConfig)) {
      buildArgs.push("src/main.ts", "--format", "cjs", "--clean", "--minify");
    }

    await execa("tsup", buildArgs, {
      cwd,
      preferLocal: true,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "production" },
    });

    CliLogger.succeedSpinner("Build complete!");

    const distFile = path.join(cwd, "dist/main.js");
    if (fs.existsSync(distFile)) {
      const stats = fs.statSync(distFile);
      const size = (stats.size / 1024).toFixed(2);
      CliLogger.dim(`\n  Output: dist/main.js (${size} KB)`);
    }
  } catch (error) {
    CliLogger.failSpinner("Build failed.");
    process.exit(1);
  }
}
