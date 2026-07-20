import inquirer from "inquirer";

/**
 * Thin ergonomic wrappers over inquirer for the common prompt shapes.
 */
export class CliPrompts {
  /**
   * Ask the user to select from a list
   */
  static async select(message: string, choices: string[]): Promise<string> {
    const answer = await inquirer.prompt([
      {
        type: "list",
        name: "selection",
        message,
        choices,
      },
    ]);
    return answer.selection;
  }

  /**
   * Ask the user for textual input
   */
  static async input(message: string, defaultVal?: string): Promise<string> {
    const answer = await inquirer.prompt([
      {
        type: "input",
        name: "text",
        message,
        default: defaultVal,
      },
    ]);
    return answer.text;
  }

  /**
   * Ask a yes/no question
   */
  static async confirm(
    message: string,
    defaultVal: boolean = true,
  ): Promise<boolean> {
    const answer = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmed",
        message,
        default: defaultVal,
      },
    ]);
    return answer.confirmed;
  }
}

// Re-export inquirer for generic complex prompt arrays
export { inquirer };
