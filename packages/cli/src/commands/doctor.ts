import dotenv from "dotenv";
import fs from "fs-extra";
import net from "net";
import path from "path";
import { CliLogger, chalk } from "../ui/index.js";

// Helper to check TCP connection (Database/Redis)
const checkConnection = (host: string, port: number, _name: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000); // 2s timeout

    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });

    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
};

// Helper to parse Connection Strings
const parseUrl = (url: string) => {
  try {
    // Handle cases like "postgres://..." or "redis://..."
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
    };
  } catch {
    return null;
  }
};

export async function doctorCommand() {
  console.log(chalk.bold.hex("#6366f1")("\n  🩺 Nuraljs Doctor\n"));

  CliLogger.startSpinner("Checking system...");
  const issues: string[] = [];

  // 1. System Checks
  const nodeVersion = process.version;
  const isNodeCompatible = parseInt(nodeVersion.slice(1).split(".")[0]!) >= 18;

  if (isNodeCompatible) {
    CliLogger.succeedSpinner(`Node.js Version: ${chalk.green(nodeVersion)}`);
  } else {
    CliLogger.failSpinner(`Node.js Version: ${chalk.red(nodeVersion)} (Requires v18+)`);
    issues.push("Upgrade Node.js to v18 or later.");
  }

  // 2. Project Checks
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  const envPath = path.join(cwd, ".env");

  if (fs.existsSync(pkgPath)) {
    CliLogger.succeedSpinner(`Project Root: ${chalk.dim("Verified")}`);
  } else {
    CliLogger.failSpinner(`Project Root: ${chalk.red("Not found")}`);
    issues.push("Run this command inside a Nuraljs project.");
    CliLogger.stopSpinner();
    printSummary(issues);
    return;
  }

  // 3. Environment Config Check
  let envVars: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    CliLogger.succeedSpinner(`Configuration (.env): ${chalk.green("Found")}`);
    envVars = dotenv.parse(fs.readFileSync(envPath));
  } else {
    CliLogger.stopSpinner();
    CliLogger.warn(`Configuration (.env): ${chalk.yellow("Missing")}`);
    issues.push("Create a .env file (copy .env.example).");
  }

  // 4. Infrastructure Checks (Smart Detection)
  CliLogger.info("\n Infrastructure Checks:");

  // Check Redis
  if (envVars["REDIS_URL"]) {
    const redis = parseUrl(envVars["REDIS_URL"]);
    if (redis) {
      const isUp = await checkConnection(redis.host, redis.port, "Redis");
      if (isUp) console.log(`  ${chalk.green("✔")} Redis (${redis.host}:${redis.port})`);
      else {
        console.log(`  ${chalk.red("✖")} Redis (${redis.host}:${redis.port}) - Unreachable`);
        issues.push(`Redis is down or unreachable at ${envVars["REDIS_URL"]}`);
      }
    }
  }

  // Check Database (Postgres/MySQL via DATABASE_URL)
  if (envVars["DATABASE_URL"]) {
    const db = parseUrl(envVars["DATABASE_URL"]);
    if (db) {
      const isUp = await checkConnection(db.host, db.port, "Database");
      if (isUp) console.log(`  ${chalk.green("✔")} Database (${db.host}:${db.port})`);
      else {
        console.log(`  ${chalk.red("✖")} Database (${db.host}:${db.port}) - Unreachable`);
        issues.push(`Database is unreachable at ${db.host}:${db.port}`);
      }
    }
  }

  // Check MongoDB
  if (envVars["MONGO_URL"]) {
    const mongo = parseUrl(envVars["MONGO_URL"]);
    if (mongo) {
      const isUp = await checkConnection(mongo.host, mongo.port, "MongoDB");
      if (isUp) console.log(`  ${chalk.green("✔")} MongoDB (${mongo.host}:${mongo.port})`);
      else {
        console.log(`  ${chalk.red("✖")} MongoDB (${mongo.host}:${mongo.port}) - Unreachable`);
        issues.push(`MongoDB is unreachable at ${mongo.host}:${mongo.port}`);
      }
    }
  }

  printSummary(issues);
}

function printSummary(issues: string[]) {
  console.log("");
  if (issues.length === 0) {
    CliLogger.success("Everything looks healthy! You are ready to code.");
  } else {
    CliLogger.warn(`Found ${issues.length} issue(s):`);
    issues.forEach((issue) => CliLogger.error(issue));
    CliLogger.info("Fix these issues to ensure a smooth development experience.");
  }
  console.log("");
}
