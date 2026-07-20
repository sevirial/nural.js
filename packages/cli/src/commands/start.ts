import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import { CliLogger } from "../ui/index.js";

export async function startCommand(options: { debug?: boolean; watch?: boolean }) {
  const cwd = process.cwd();
  const distPath = path.join(cwd, "dist/main.js");

  // 1. Pre-flight Check
  if (!fs.existsSync(distPath)) {
    CliLogger.error("dist/main.js not found.");
    CliLogger.warn("Run 'nural build' first.");
    process.exit(1);
  }

  CliLogger.success(`\n  🚀 Starting production server...`);

  const args = [];

  // 2. Handle Debug Mode
  if (options.debug) {
    CliLogger.warn("🐞 Debug mode enabled (--inspect)");
    args.push("--inspect");
  }

  args.push("dist/main.js");

  // 3. Execution
  try {
    await execa("node", args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
    });
  } catch (error: any) {
    if (error.signal !== "SIGINT") {
      CliLogger.error("\nApplication crashed.");
      process.exit(1);
    }
  }
}
