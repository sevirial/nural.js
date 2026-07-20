/**
 * Zero-Dependency Logger
 * Lightweight, colorful, and powerful logging system
 */

// ANSI Color Codes
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export interface LoggerConfig {
  /** Enable/disable logging */
  enabled?: boolean;
  /** Minimum log level */
  minLevel?: "log" | "error" | "warn" | "debug";
  /** Show timestamp */
  timestamp?: boolean;
}

/**
 * Logger class for specialized context logging
 */
export class Logger {
  private context: string;
  private config: LoggerConfig;

  constructor(context: string = "System", config: LoggerConfig = {}) {
    this.context = context;
    this.config = { enabled: true, timestamp: true, ...config };
  }

  private getTimestamp() {
    if (!this.config.timestamp) return "";
    return new Date().toISOString();
  }

  private print(level: string, message: string, color: string) {
    if (this.config.enabled === false) return;

    const pid = process.pid;
    const timestamp = this.getTimestamp();
    const ctx = `[${colors.yellow}${this.context}${colors.reset}]`;

    // Format: [Nuraljs] 1234 - 10/20/2025... [Context] Message
    process.stdout.write(
      `${colors.green}[Nuraljs]${colors.reset} ${colors.gray}${pid}${colors.reset}  - ` +
        `${timestamp}   ${ctx} ${color}${message}${colors.reset}\n`,
    );
  }

  log(message: string) {
    this.print("LOG", message, colors.green);
  }

  error(message: string, trace?: string) {
    this.print("ERROR", message, colors.red);
    if (trace) process.stderr.write(`${colors.red}${trace}${colors.reset}\n`);
  }

  warn(message: string) {
    this.print("WARN", message, colors.yellow);
  }

  debug(message: string) {
    this.print("DEBUG", message, colors.magenta);
  }
}
