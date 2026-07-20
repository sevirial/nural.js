import chalk from "chalk";
import ora, { Ora } from "ora";

/**
 * Consistent console output + a single shared spinner for the whole CLI.
 */
export class CliLogger {
  private static spinner: Ora | null = null;

  static info(message: string) {
    console.log(chalk.blue(message));
  }

  static success(message: string) {
    console.log(chalk.green(`  ✔ ${message}`));
  }

  static warn(message: string) {
    console.log(chalk.yellow(`  ⚠ ${message}`));
  }

  static error(message: string) {
    console.error(chalk.red(`  ❌ ${message}`));
  }

  static dim(message: string) {
    console.log(chalk.dim(message));
  }

  static newline() {
    console.log();
  }

  // Spinner logic
  static startSpinner(text: string) {
    if (this.spinner) {
      this.spinner.text = text;
    } else {
      this.spinner = ora(text).start();
    }
  }

  static updateSpinner(text: string) {
    if (this.spinner) {
      this.spinner.text = text;
    }
  }

  static succeedSpinner(text?: string) {
    if (this.spinner) {
      this.spinner.succeed(text ? chalk.green(text) : undefined);
      this.spinner = null;
    } else if (text) {
      this.success(text);
    }
  }

  static failSpinner(text?: string) {
    if (this.spinner) {
      this.spinner.fail(text ? chalk.red(text) : undefined);
      this.spinner = null;
    } else if (text) {
      this.error(text);
    }
  }

  static stopSpinner() {
    if (this.spinner) {
      this.spinner.stop();
      this.spinner = null;
    }
  }
}

// Re-export chalk for custom inline styling when needed
export { chalk };
