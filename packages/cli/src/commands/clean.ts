import fs from "fs-extra";
import path from "path";
import { CliLogger } from "../ui/index.js";

export async function cleanCommand() {
  const cwd = process.cwd();
  CliLogger.startSpinner("Cleaning project...");

  const paths = [
    "dist",
    "coverage",
    ".turbo",
    ".nural-routes.ts",
    ".nural-routes-data.json",
    ".nural-console.ts",
    ".nural-gen-docs.ts",
  ];

  let deletedCount = 0;

  for (const p of paths) {
    const fullPath = path.join(cwd, p);
    if (fs.existsSync(fullPath)) {
      await fs.remove(fullPath);
      deletedCount++;
    }
  }

  CliLogger.succeedSpinner(`Cleaned ${deletedCount} files/directories.`);
}
