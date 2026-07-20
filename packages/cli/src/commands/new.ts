import inquirer from "inquirer";
import { scaffold } from "../core/scaffold.js";

export async function newCommand(projectName: string) {
  const answers = await inquirer.prompt([
    {
      type: "list",
      name: "framework",
      message: "Which underlying engine would you like to use?",
      choices: ["Fastify (Recommended)", "Express"],
      default: "Fastify (Recommended)",
    },
    {
      type: "list",
      name: "packageManager",
      message: "Which package manager do you use?",
      choices: ["npm", "pnpm", "yarn", "bun"],
      default: "npm",
    },
    {
      type: "checkbox",
      name: "integrations",
      message: "Which integrations do you need?",
      choices: [
        { name: "Redis", value: "redis" },
        { name: "WebSockets (WS)", value: "ws" },
        { name: "RabbitMQ", value: "rabbitmq" },
        { name: "PostgreSQL (Prisma)", value: "prisma-pg" },
        { name: "MongoDB (Mongoose)", value: "mongoose" },
      ],
    },
  ]);

  await scaffold(projectName, answers);
}
