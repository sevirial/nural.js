# @nuraljs/cli

## 1.2.0

### Minor Changes

- Self-host Scalar UI to completely remove CDN dependencies and fix SRI hash brittleness. Add Nuraljs CLI ASCII dev banner and add Fastify support for `js` response types.

## 1.1.0

### Minor Changes

- fix(cli): wrap generated templates in defineProvider for infrastructure lifecycle management

## 1.0.0

### Major Changes

- **First stable (1.0.0) release.** Project scaffolds now pin `@nuraljs/*` dependencies at `^1.0.0`, and the generated middleware template reads `req.headers` directly (no cast) to match core's typed middleware `req`.

## 0.6.0

### Minor Changes

- **Generated files are now formatted with Prettier — and three template bugs are fixed.**

  Scaffolded projects came out littered with whitespace-only lines, and `nural new` shipped a **`docker-compose.yml` that Docker rejects** (`services.app.depends_on must be a array` — the default project emitted `depends_on:` with an empty list). Three separate causes:

  1. **EJS ghost lines.** EJS emits everything outside its tags verbatim, including the indentation before a tag and the newline ending the line it sits on — so `  <% if (x) { %>await connect();<% } %>` left `"  \n"` behind when `x` was false. Every line-owning tag now slurps its newline with `-%>`.
  2. **CRLF templates.** 18 of 27 templates were committed with Windows line endings, putting a stray `\r` at the end of every generated line (this is what made generated _modules and resources_ look padded). Converted to LF and pinned with `.gitattributes`.
  3. **`generate`'s dev template path** resolved to `src/src/templates`, so its fallback never matched. Invisible in production only because the bundle flattens `__dirname` to `dist/`.

  **Prettier now has the final say.** Every generated file — scaffold, `generate`, `add`, and the programmatic `package.json` — is rendered through one pipeline that formats the output, so template whitespace is no longer load-bearing (the same approach as Nx's `formatFiles()`). It **honours the target project's own `.prettierrc`**, so `nural generate` inside your repo emits code in your house style; our defaults apply only when you have no config. The files `generate` _edits_ (`app.ts`/`main.ts` auto-wiring) are formatted too, so an inserted `registerModule` line matches the surrounding style. Prettier is imported lazily, so commands that generate nothing don't pay for it; if it can't parse a file (or has no parser, e.g. `.env`), generation still succeeds with normalized output.

  **`nural new` now scaffolds Prettier itself** — a `.prettierrc`, the `prettier` devDependency, and a `format` script (as `nest new` does). The generated code was already Prettier-formatted; shipping the config makes that style a file you own and can edit rather than a constant hidden in the CLI. Edit it and `nural generate` follows, because the generator resolves the config from your project — so codegen and `pnpm format` never fight. The shipped `.prettierrc` and the generator's fallback defaults are derived from the same constant, so they cannot drift, and a fresh project passes `prettier --check` on day one. Don't want it? Delete the file: the identical defaults apply, and generated code stays formatted.

  Two smaller changes: the obsolete `version: '3.8'` key is gone from the compose template (Compose v2 warns on it), and generated code no longer carries an unused `server` binding or unused vitest hook imports.

  **Generated output is restyled** (notably quotes and line wrapping) — regenerate or reformat if you diff scaffolds across versions. A freshly scaffolded project now passes `prettier --check` out of the box.

- **The command is `nural` again, not `nuraljs`.** `nural dev`, `nural new my-api`, `nural g resource product`.

  `0.5.0` renamed the executable `nural` → `nuraljs` alongside the package rebrand. That was a mistake of ergonomics: `nuraljs dev` is a mouthful for the thing you type dozens of times a day, and it conflated two identities that are conventionally separate — the **package** you install and the **command** you run. Every comparable tool keeps them distinct: `@angular/cli` → `ng`, `@nestjs/cli` → `nest`. So the package remains **`@nuraljs/cli`**; only the binary changes back.

  **No migration needed.** `@nuraljs/cli` has never been published, so the `nuraljs` bin never reached anyone — this is a clean rename rather than a breaking change, and no alias is kept.

  **What moved with it:** the `bin` entry, the program name in `--help`, the shell-completion script (function, markers, and the `complete -F … nural` registration), the REPL prompt (`nural >`), the `dev`/`build`/`start`/`test` scripts written into scaffolded projects, and the CLI's transient scratch files (`.nuraljs-*` → `.nural-*`, kept in sync with what `nural clean` removes). Docs and the website were updated to match; `@nuraljs/*` package names and the `nuraljs.org` domain are untouched.

  Also fixed while in here: `--version` was a hardcoded `"0.5.0"` string that would have silently lied on the next release. It now reads the real version from `package.json`.

## 0.5.0

### Minor Changes

- **Rebrand `@nural/cli` → `@nuraljs/cli` and the `nural` command → `nuraljs` (breaking).** The CLI package and its executable are renamed, and every scaffolded artifact now targets the `nuraljs` family: generated `package.json` deps are `@nuraljs/core@^0.5.0` + `@nuraljs/testing@^0.1.0`, generated imports use `from "@nuraljs/core"`, and the app symbol is `Nuraljs`.

  **What to do.** Reinstall the CLI as `@nuraljs/cli` and invoke it as `nuraljs` (the old `nural` bin is gone). Projects scaffolded with this version wire up `@nuraljs/core` / `@nuraljs/testing` out of the box. No behavior changes beyond the rename.

## 0.3.10

### Patch Changes

- addf8d9: Refactor to monorepo structure and update dependencies.
