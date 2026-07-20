// ──────────────────────────────────────────────────────────────────
// The single entry point for turning a template into a generated file.
//
// Why this exists: EJS emits everything OUTSIDE its tags verbatim — including the
// indentation in front of a tag and the newline that ends the line it sits on. So
// a conditional line that renders nothing still leaves `<indent>` + `\n` behind:
//
//   `  <% if (x) { %>await connect();<% } %>\n`   with x=false  ->  `  \n`
//
// Templates guard against that with EJS's whitespace-control tags (`-%>` slurps
// the trailing newline). But relying on every future template edit to get that
// right is a losing bet — one missed `-` and the artifact ships with ghost lines.
//
// So there are three layers, and generated files are clean if ANY of them holds:
//   1. Template authoring   — `-%>` on every line-owning tag (enforced by a spec).
//   2. `normalizeGenerated` — cheap, dependency-free tidy-up of pure whitespace.
//   3. Prettier             — a real formatter with the final say.
//
// This is the same shape as Nx running `formatFiles()` at the end of every
// generator: template whitespace stops being load-bearing, because the formatter
// decides the final layout. Layer 2 is kept as the fallback for the files
// Prettier has no parser for (`.env`) and for the (unlikely) case where Prettier
// throws — generation must never fail because a formatter was unhappy.
// ──────────────────────────────────────────────────────────────────

import ejs from "ejs";
import path from "path";
import type { BuiltInParserName, Options as PrettierOptions } from "prettier";

/** Parser per extension of the file we are WRITING (templates are `<name>.<ext>.ejs`). */
const PARSERS: Record<string, BuiltInParserName> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "babel",
  ".mjs": "babel",
  ".cjs": "babel",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".md": "markdown",
};

/**
 * Formatting used when the target project has no Prettier config of its own.
 *
 * `scaffold` writes these same options out as the new project's `.prettierrc`,
 * so the style the CLI applies is written down and editable rather than hidden in
 * here — and `generate` reads that file back, so editing it steers future codegen.
 * Deriving both from this one constant is what keeps them from drifting apart.
 */
export const DEFAULT_PRETTIER_OPTIONS: PrettierOptions = {
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  printWidth: 80,
  tabWidth: 2,
};

/**
 * Normalizes generated source: LF endings, no trailing whitespace, no runs of
 * blank lines, no leading blank lines, exactly one trailing newline.
 *
 * The CRLF step matters as much as the rest: a template authored on Windows
 * carries `\r` at every line end, which survives into the generated file as
 * invisible trailing whitespace on every single line. Normalizing here means the
 * output never depends on the line endings of whoever last edited a template.
 *
 * Deliberately conservative — it only removes whitespace that carries no meaning
 * in any language we emit (TS, JSON, YAML, dotenv). It never reindents or
 * rewrites code, which is what makes it a safe fallback for unformattable files.
 */
export function normalizeGenerated(source: string): string {
  return source
    .replace(/\r\n?/g, "\n") // CRLF/CR -> LF, whatever the template was saved as
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, "")) // drop trailing whitespace per line
    .join("\n")
    .replace(/^\n+/, "") // no leading blank lines
    .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs to a single separator
    .replace(/\n*$/, "\n"); // exactly one trailing newline (POSIX)
}

/**
 * Formats generated source with Prettier, honouring the **target project's** own
 * config when it has one — so `nural generate` inside a repo with a
 * `.prettierrc` emits code in that repo's style rather than ours.
 *
 * Falls back to {@link normalizeGenerated} when Prettier has no parser for the
 * file (e.g. `.env`) or fails to parse it. A formatter is a nicety; never let it
 * be the reason a user's file doesn't get written.
 *
 * @param destPath where the file will land — chooses the parser AND locates the
 *                 user's Prettier config.
 */
export async function formatGenerated(source: string, destPath: string): Promise<string> {
  const normalized = normalizeGenerated(source);
  const parser = PARSERS[path.extname(destPath)];
  if (!parser) return normalized;

  // Imported lazily: Prettier is a heavy module, and most CLI invocations
  // (`--version`, `dev`, `build`) never generate a file. Mirrors how the core
  // lazy-loads its server engine.
  const prettier = await import("prettier");
  const userConfig = await prettier.resolveConfig(destPath).catch(() => null);

  try {
    return await prettier.format(normalized, {
      ...DEFAULT_PRETTIER_OPTIONS,
      ...userConfig,
      parser,
    });
  } catch {
    // Unparseable output is a template bug, not a user problem — write the file
    // anyway so they can see (and report) what came out.
    return normalized;
  }
}

/**
 * Renders an EJS template and returns the formatted file contents. Every
 * generated file goes through here, so cleanliness is a property of the pipeline
 * rather than of each template author remembering to write `-%>`.
 *
 * @param destPath where the result will be written (drives parser + config lookup).
 */
export async function renderTemplate(
  templateFile: string,
  data: Record<string, unknown>,
  destPath: string,
): Promise<string> {
  const rendered = await ejs.renderFile(templateFile, data);
  return formatGenerated(String(rendered), destPath);
}
