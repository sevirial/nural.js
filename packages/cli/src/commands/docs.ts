import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import { CliLogger, chalk } from "../ui/index.js";

export async function docsCommand(options: { output?: string }) {
  const cwd = process.cwd();
  const outputPath = options.output || "openapi.json";
  const absOutputPath = path.resolve(cwd, outputPath);

  CliLogger.startSpinner("Generating OpenAPI specification...");

  // 1. Create a temporary script that boots the app and dumps the spec
  const scriptContent = `
    import { app } from "./src/app";
    import fs from "fs";

    async function generate() {
      try {
        const spec = app.getOpenApiSpec();
        const dest = ${JSON.stringify(absOutputPath)}; // Safely inject path

        fs.writeFileSync(dest, JSON.stringify(spec, null, 2));
        console.log("Spec written successfully");
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    }

    generate();
  `;

  const scriptPath = path.join(cwd, ".nural-gen-docs.ts");

  try {
    // 2. Write the temporary script
    await fs.writeFile(scriptPath, scriptContent);

    // 3. Execute with tsx
    await execa("tsx", [scriptPath], {
      cwd,
      preferLocal: true,
      env: { ...process.env, NODE_ENV: "development" },
    });

    CliLogger.succeedSpinner(`Spec generated at ${chalk.bold(outputPath)}`);
  } catch (error: any) {
    CliLogger.failSpinner("Failed to generate documentation.");
    if (error.stderr) CliLogger.dim(error.stderr);
    if (error.stdout) CliLogger.info(error.stdout);
  } finally {
    // 4. Cleanup
    if (fs.existsSync(scriptPath)) {
      await fs.unlink(scriptPath);
    }
  }
}
