import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import { CliLogger, chalk } from "../ui/index.js";

export async function routesCommand() {
  const cwd = process.cwd();

  // Define paths
  const scriptPath = path.join(cwd, ".nural-routes.ts");
  const dataPath = path.join(cwd, ".nural-routes-data.json");

  CliLogger.startSpinner("Scanning application routes...");

  // 1. Script to extract routes (Writes to file to avoid log noise)
  const scriptContent = `
    import { app } from "./src/app";
    import fs from "fs";

    async function extract() {
      try {
        const routes = app.getRoutes().map(r => ({
          method: r.method,
          path: r.path,
          summary: r.summary || "",
          protected: !!(r.security && r.security.length > 0) || !!(r.middleware && r.middleware.length > 0)
        }));

        fs.writeFileSync(${JSON.stringify(dataPath)}, JSON.stringify(routes));
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    }

    extract();
  `;

  try {
    await fs.writeFile(scriptPath, scriptContent);

    // 2. Run script using local tsx
    await execa("tsx", [scriptPath], {
      cwd,
      preferLocal: true,
      env: { ...process.env, NODE_ENV: "development" },
    });

    if (!fs.existsSync(dataPath)) {
      throw new Error("Route data file was not generated.");
    }

    const routes = await fs.readJson(dataPath);
    CliLogger.stopSpinner();

    // ---------------------------------------------------------
    // 🎨 UI Logic: Dynamic Calculation for Perfect Alignment
    // ---------------------------------------------------------

    if (routes.length === 0) {
      CliLogger.warn("\n  No routes registered yet.\n");
      return;
    }

    // Calculate dynamic column widths (with padding)
    const methodColWidth =
      Math.max(...routes.map((r: any) => r.method.length), "METHOD".length) + 4;
    const pathColWidth =
      Math.max(...routes.map((r: any) => r.path.length), "PATH".length) + 6;
    const authColWidth = "AUTH".length + 6;

    console.log(""); // Spacing

    // Print Header
    console.log(
      chalk.dim("  ") +
        chalk.bold("METHOD".padEnd(methodColWidth)) +
        chalk.bold("PATH".padEnd(pathColWidth)) +
        chalk.bold("AUTH".padEnd(authColWidth)) +
        chalk.bold("SUMMARY"),
    );

    // Print Divider
    const totalWidth = methodColWidth + pathColWidth + authColWidth + 40;
    console.log(chalk.dim("  " + "─".repeat(Math.min(totalWidth, 100))));

    // Print Rows
    routes.forEach((r: any) => {
      // Colorize Methods
      let methodStr = r.method.toUpperCase();
      if (r.method === "GET") methodStr = chalk.green(methodStr);
      else if (r.method === "POST") methodStr = chalk.yellow(methodStr);
      else if (r.method === "PATCH" || r.method === "PUT") methodStr = chalk.blue(methodStr);
      else if (r.method === "DELETE") methodStr = chalk.red(methodStr);

      // Format Auth Status
      const authStatus = r.protected ? chalk.green("Locked") : chalk.dim("Public");

      // Print Row
      console.log(
        "  " +
          methodStr.padEnd(methodColWidth + (methodStr.length - r.method.length)) +
          r.path.padEnd(pathColWidth) +
          authStatus.padEnd(authColWidth + (authStatus.length - 6)) +
          chalk.dim(r.summary),
      );
    });

    console.log(""); // Final spacing
  } catch (error: any) {
    CliLogger.failSpinner("Failed to load routes.");
    if (error.stderr) CliLogger.dim(error.stderr);
  } finally {
    if (fs.existsSync(scriptPath)) await fs.unlink(scriptPath);
    if (fs.existsSync(dataPath)) await fs.unlink(dataPath);
  }
}
