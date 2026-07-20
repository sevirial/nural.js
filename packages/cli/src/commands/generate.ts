import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { CliLogger, CliPrompts, chalk } from "../ui/index.js";
import { formatGenerated, renderTemplate } from "../core/render.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Schematics this CLI can generate. */
const SCHEMATICS = ["resource", "middleware", "provider", "filter"] as const;

// Helper to find templates (resource vs granular), resilient to dev/prod layout.
const templatePath = (folder: "resource" | "granular", name: string) => {
  // 1. Production path: the bundle is flattened to dist/, so templates are siblings.
  const distPath = path.join(__dirname, "templates", folder, name);
  if (fs.existsSync(distPath)) return distPath;

  // 2. Dev path: running from source, this file is src/commands/, so templates
  //    are one level up at src/templates/.
  const localSrcPath = path.join(__dirname, "../templates", folder, name);
  if (fs.existsSync(localSrcPath)) return localSrcPath;

  return distPath; // Default to prod path for error messages
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const camelCase = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export async function generateCommand(schematic: string, name: string) {
  const cwd = process.cwd();

  // 1. Resolve schematic + name (support `g product` → resource shorthand,
  //    and interactive prompts when either is missing).
  if (!name) {
    if (schematic && !SCHEMATICS.includes(schematic as any)) {
      // `nural g product` -> treat the single arg as a resource name
      name = schematic;
      schematic = "resource";
    } else {
      if (!schematic) {
        schematic = await CliPrompts.select(
          "What do you want to generate?",
          [...SCHEMATICS],
        );
      }
      if (!name) {
        name = await CliPrompts.input("What is the name?");
      }
    }
  }

  if (!SCHEMATICS.includes(schematic as any)) {
    CliLogger.error(`Unknown schematic '${schematic}'.`);
    CliLogger.info(`Available: ${SCHEMATICS.join(", ")}`);
    return;
  }

  const fileName = name.toLowerCase();
  const className = capitalize(fileName);
  const camelName = camelCase(fileName);
  const data = { name: className, className, fileName, camelName };

  console.log(chalk.blue(`✨ Generating ${schematic}: ${chalk.bold(className)}`));

  try {
    // 2. Resource generation (full module)
    if (schematic === "resource") {
      const targetDir = path.join(cwd, "src/modules", fileName);
      if (fs.existsSync(targetDir)) {
        CliLogger.error(`Module '${fileName}' already exists.`);
        return;
      }

      await fs.ensureDir(path.join(targetDir, "models"));
      await fs.ensureDir(path.join(targetDir, "schemas"));

      const files = [
        { tpl: "model.ts.ejs", out: `models/${fileName}.model.ts` },
        { tpl: "schema.request.ts.ejs", out: `schemas/${fileName}.request.ts` },
        { tpl: "schema.response.ts.ejs", out: `schemas/${fileName}.response.ts` },
        { tpl: "service.ts.ejs", out: `${fileName}.service.ts` },
        { tpl: "controller.ts.ejs", out: `${fileName}.controller.ts` },
        { tpl: "module.ts.ejs", out: `${fileName}.module.ts` },
      ];

      for (const file of files) {
        const template = templatePath("resource", file.tpl);
        if (!fs.existsSync(template)) {
          CliLogger.error(`Template not found: ${file.tpl}`);
          continue;
        }
        const dest = path.join(targetDir, file.out);
        await fs.outputFile(dest, await renderTemplate(template, data, dest));
        CliLogger.success(`Created src/modules/${fileName}/${file.out}`);
      }

      await registerModuleInApp(cwd, fileName, camelName);
      return;
    }

    // 3. Granular generation (middleware / provider / filter)
    let destPath = "";
    let tplName = "";

    if (schematic === "middleware") {
      await fs.ensureDir(path.join(cwd, "src/common/middleware"));
      destPath = path.join(cwd, "src/common/middleware", `${fileName}.middleware.ts`);
      tplName = "middleware.ts.ejs";
    } else if (schematic === "filter") {
      await fs.ensureDir(path.join(cwd, "src/common/filters"));
      destPath = path.join(cwd, "src/common/filters", `${fileName}.filter.ts`);
      tplName = "filter.ts.ejs";
    } else if (schematic === "provider") {
      await fs.ensureDir(path.join(cwd, "src/providers"));
      destPath = path.join(cwd, "src/providers", `${fileName}.provider.ts`);
      tplName = "provider.ts.ejs";
    }

    if (fs.existsSync(destPath)) {
      CliLogger.error(`File already exists at ${path.relative(cwd, destPath)}`);
      return;
    }

    const content = await renderTemplate(templatePath("granular", tplName), data, destPath);
    await fs.outputFile(destPath, content);
    CliLogger.success(`Created ${path.relative(cwd, destPath)}`);

    if (schematic === "provider") {
      await registerProviderInMain(cwd, fileName, camelName);
    }
  } catch (error) {
    CliLogger.error("Generation failed.");
    console.error(error);
  }
}

/**
 * Automatically injects provider registration into src/main.ts
 */
async function registerProviderInMain(cwd: string, fileName: string, camelName: string) {
  const mainPath = path.join(cwd, "src/main.ts");

  if (!fs.existsSync(mainPath)) {
    CliLogger.warn("Could not find src/main.ts. Please register the provider manually.");
    return;
  }

  let content = await fs.readFile(mainPath, "utf-8");
  const providerName = `${camelName}Provider`;
  const importPath = `./providers/${fileName}.provider`;

  // Check if already registered
  if (content.includes(providerName)) {
    return;
  }

  console.log(chalk.blue(`  ⚙ Wiring up ${providerName} in main.ts...`));

  // A. Add Import Statement
  const lastImportIdx = content.lastIndexOf("import ");
  const nextLineIdx = content.indexOf("\n", lastImportIdx);
  const importStatement = `import { ${providerName} } from "${importPath}";`;

  if (lastImportIdx !== -1) {
    content =
      content.slice(0, nextLineIdx + 1) +
      importStatement +
      "\n" +
      content.slice(nextLineIdx + 1);
  } else {
    content = importStatement + "\n" + content;
  }

  // B. Register Provider before app.start(...)
  const registerLine = `  await app.registerProvider(${providerName});`;
  const startRegex = /app\.start\(/;
  const match = startRegex.exec(content);

  if (match) {
    const insertPos = match.index;
    content =
      content.slice(0, insertPos) +
      registerLine +
      "\n\n  " +
      content.slice(insertPos);
  } else {
    CliLogger.warn("Could not find 'app.start()' in main.ts. Added provider registration at the end.");
    content += `\n// TODO: Register this provider inside your async startup function\n// await app.registerProvider(${providerName});\n`;
  }

  // Format the file we just edited, so our inserted lines match the project's
  // own style rather than ours (the same reason Nx formats every file its
  // generators touch). A no-op when the file is already clean.
  await fs.writeFile(mainPath, await formatGenerated(content, mainPath));
  CliLogger.success(`Registered ${providerName} successfully!`);
}

/**
 * Automatically injects the module registration into src/app.ts
 */
async function registerModuleInApp(cwd: string, fileName: string, camelName: string) {
  const appPath = path.join(cwd, "src/app.ts");

  if (!fs.existsSync(appPath)) {
    CliLogger.warn("Could not find src/app.ts. Please register the module manually.");
    return;
  }

  let appContent = await fs.readFile(appPath, "utf-8");
  const moduleName = `${camelName}Module`;
  const importPath = `./modules/${fileName}/${fileName}.module`;

  // Check if already registered
  if (appContent.includes(moduleName)) {
    return;
  }

  console.log(chalk.blue(`  ⚙ Wiring up ${moduleName} in app.ts...`));

  // A. Add Import Statement
  const lastImportIdx = appContent.lastIndexOf("import ");
  const nextLineIdx = appContent.indexOf("\n", lastImportIdx);
  const importStatement = `import { ${moduleName} } from "${importPath}";`;

  if (lastImportIdx !== -1) {
    appContent =
      appContent.slice(0, nextLineIdx + 1) +
      importStatement +
      "\n" +
      appContent.slice(nextLineIdx + 1);
  } else {
    appContent = importStatement + "\n" + appContent;
  }

  // B. Register Module after the last existing registration (or at EOF)
  const registerLine = `app.registerModule(${moduleName});`;
  const registerRegex = /app\.registerModule\(([^)]+)\);/g;
  let match;
  let lastMatchIndex = -1;
  let lastMatchLength = 0;

  while ((match = registerRegex.exec(appContent)) !== null) {
    lastMatchIndex = match.index;
    lastMatchLength = match[0].length;
  }

  if (lastMatchIndex !== -1) {
    const insertPos = lastMatchIndex + lastMatchLength;
    appContent =
      appContent.slice(0, insertPos) + "\n" + registerLine + appContent.slice(insertPos);
  } else {
    appContent += `\n${registerLine}\n`;
  }

  // Format the file we just edited — see the note in `registerProviderInMain`.
  await fs.writeFile(appPath, await formatGenerated(appContent, appPath));
  CliLogger.success(`Registered ${moduleName} successfully!`);
}
