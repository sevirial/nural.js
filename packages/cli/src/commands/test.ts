import chalk from "chalk";
import { execa } from "execa";

export async function testCommand(options: {
  watch?: boolean;
  coverage?: boolean;
  e2e?: boolean;
}) {
  const cwd = process.cwd();

  // 1. Determine Test Scope
  const args = ["run"]; // Default to single run

  if (options.watch) {
    args[0] = "watch";
    console.log(chalk.blue("  👀 Starting tests in Watch Mode..."));
  } else {
    console.log(chalk.blue("  🧪 Running tests..."));
  }

  // 2. Handle Coverage
  if (options.coverage) {
    args.push("--coverage");
    console.log(chalk.dim("  📊 Coverage reporting enabled"));
  }

  // 3. Handle E2E vs Unit
  if (options.e2e) {
    console.log(chalk.bold.hex("#6366f1")("  🌐 Mode: End-to-End (E2E)"));
    // Look for files ending in .e2e.ts or inside test/e2e folder
    args.push("**/*.e2e.ts");
  } else {
    // Default: Skip E2E tests in normal runs to keep it fast
    // We explicitly exclude e2e files unless asked
    args.push("--exclude", "**/*.e2e.ts");
  }

  // 4. Set Environment
  const env = {
    ...process.env,
    NODE_ENV: "test",
    FORCE_COLOR: "true",
  };

  try {
    await execa("vitest", args, {
      cwd,
      preferLocal: true,
      stdio: "inherit",
      env,
    });
  } catch (error: any) {
    // Test failure is normal (exit code 1), don't crash the CLI helper
    process.exit(1);
  }
}
