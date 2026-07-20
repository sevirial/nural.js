import fs from "fs-extra";
import path from "path";
import { execa } from "execa";
import { CliLogger, inquirer, chalk } from "../ui/index.js";

// Helper: Fetch latest version from npm registry
async function getLatestVersion(pkg: string): Promise<string | null> {
  try {
    const { stdout } = await execa("npm", ["view", pkg, "version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function updateCommand() {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");

  if (!fs.existsSync(pkgPath)) {
    CliLogger.error("package.json not found.");
    return;
  }

  const pkg = await fs.readJson(pkgPath);
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };

  // 1. Find Nuraljs Packages
  const nuralPkgs = Object.keys(dependencies).filter((d) =>
    d.startsWith("@nuraljs/"),
  );

  if (nuralPkgs.length === 0) {
    CliLogger.warn("No Nuraljs dependencies found in this project.");
    return;
  }

  CliLogger.info(`\n  Checking for updates...`);
  CliLogger.startSpinner("Fetching latest versions...");

  const updates: { name: string; current: string; latest: string }[] = [];

  // 2. Check Versions
  for (const name of nuralPkgs) {
    const current = dependencies[name].replace(/^[\^~]/, ""); // remove ^ or ~
    const latest = await getLatestVersion(name);

    // Skip if we can't find version or if it's a local file: link
    if (!latest || current.startsWith("file:") || current.startsWith("workspace:"))
      continue;

    if (latest !== current) {
      updates.push({ name, current, latest });
    }
  }

  CliLogger.stopSpinner();

  // 3. Report Results
  if (updates.length === 0) {
    CliLogger.success("All Nuraljs packages are up to date!");
    return;
  }

  CliLogger.info("Updates available:");
  updates.forEach((u) => {
    console.log(`  ${u.name}: ${chalk.red(u.current)} -> ${chalk.green(u.latest)}`);
  });
  console.log("");

  // 4. Ask to Update
  const { confirm } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirm",
      message: "Do you want to update these packages now?",
      default: true,
    },
  ]);

  if (!confirm) {
    CliLogger.info("Update cancelled.");
    return;
  }

  // 5. Run Update
  const pkgManager = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))
    ? "pnpm"
    : fs.existsSync(path.join(cwd, "yarn.lock"))
      ? "yarn"
      : "npm";

  CliLogger.startSpinner("Updating packages...");

  try {
    const args = pkgManager === "npm" ? ["install"] : ["add"];
    // Add packages with @latest tag
    const pkgsToUpdate = updates.map((u) => `${u.name}@latest`);

    // For safety, we just run install/add which updates the lockfile and package.json
    await execa(pkgManager, [...args, ...pkgsToUpdate], { cwd });

    CliLogger.succeedSpinner("Packages updated successfully!");
  } catch (error) {
    CliLogger.failSpinner("Failed to update packages.");
  }
}
