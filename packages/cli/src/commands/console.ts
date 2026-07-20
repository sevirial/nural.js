import { execa } from "execa";
import fs from "fs-extra";
import path from "path";
import { CliLogger, chalk } from "../ui/index.js";

export async function consoleCommand() {
  const cwd = process.cwd();

  // We create a temporary script that boots the app and starts a REPL
  const scriptPath = path.join(cwd, ".nural-console.ts");

  CliLogger.info("  ⚡ Booting Nuraljs Interactive Console...");
  CliLogger.dim("  (Type '.exit' to quit)");

  const scriptContent = `
    import { app } from "./src/app";
    import repl from "repl";

    // 1. Define the REPL
    const r = repl.start({
      prompt: '${chalk.hex("#6366f1")("nural > ")}',
      useGlobal: true
    });

    // 2. Inject Context
    // This allows the user to type 'app' to see the application instance
    Object.defineProperty(r.context, 'app', {
      configurable: false,
      enumerable: true,
      value: app
    });

    // 3. Helper to load providers (optional usage)
    r.context.help = () => {
      console.log("\\n  Available Context:");
      console.log("  - app: The Nuraljs application instance");
      console.log("  - services: Access your business logic (if exported)");
      console.log("\\n  Tip: You can import files using dynamic import:");
      console.log("  const { userService } = await import('./src/modules/users/user.service')");
    };

    // 4. Setup History (Optional, saves up/down arrow history)
    r.setupHistory(".nuraljs_history", (err) => {});
  `;

  try {
    // Write the script
    await fs.writeFile(scriptPath, scriptContent);

    // Run interactively
    // stdio: 'inherit' is CRITICAL here so the user can type!
    await execa("tsx", [scriptPath], {
      cwd,
      preferLocal: true,
      stdio: "inherit",
      env: { ...process.env, NODE_ENV: "development" },
    });
  } catch (error: any) {
    // Don't log error on exit, as .exit causes a "failed" promise in some cases
    if (error.exitCode !== 0) {
      CliLogger.error("Console crashed.");
    }
  } finally {
    // Cleanup
    if (fs.existsSync(scriptPath)) {
      await fs.unlink(scriptPath);
    }
  }
}
