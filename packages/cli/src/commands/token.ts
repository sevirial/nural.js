import chalk from "chalk";
import fs from "fs-extra";
import { CliLogger } from "../ui/index.js";
import type { TokenHeader, DecodedToken } from "@nuraljs/auth";

// ──────────────────────────────────────────────────────────────────────────
// `nural token inspect` — the secure, DX-friendly equivalent of jwt.io for
// Nuraljs binary tokens.
//
// A JWT is base64: paste it into jwt.io and every claim is readable — which is
// exactly why it is *insecure* to put anything sensitive in one. A Nuraljs token
// is ChaCha20-Poly1305-encrypted, so an intercepted token leaks nothing. This
// command restores the lost observability without giving up that property:
//
//   • By default it shows only the PUBLIC envelope (version, key id, nonce, tag,
//     sizes). No key needed; the claims stay sealed. Safe on any token.
//   • With the operator's secret (env / --key-file / --secret) it decrypts and
//     renders the claims LOCALLY — the token is never sent anywhere, unlike a
//     web decoder. That is the security win, made ergonomic.
// ──────────────────────────────────────────────────────────────────────────

/** Environment variable read as a fallback secret (the safest source). */
const SECRET_ENV = "NURALJS_AUTH_SECRET";

export interface TokenInspectOptions {
  /** Raw secret to decrypt with. Discouraged via argv (leaks to shell history/`ps`). */
  secret?: string;
  /** Path to a file whose contents are the secret. Preferred over `--secret`. */
  keyFile?: string;
  /** Emit machine-readable JSON instead of the formatted report. */
  json?: boolean;
  /** When decrypting, show claim keys + value types but not the values (screen-share safe). */
  redact?: boolean;
}

/** Formats a signed epoch-seconds duration as a short human string. */
function humanizeDuration(seconds: number): string {
  const abs = Math.abs(seconds);
  const parts: string[] = [];
  const units: Array<[string, number]> = [
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  let rem = abs;
  for (const [label, size] of units) {
    if (rem >= size || (label === "s" && parts.length === 0)) {
      const value = Math.floor(rem / size);
      if (value > 0 || (label === "s" && parts.length === 0)) parts.push(`${value}${label}`);
      rem %= size;
    }
    if (parts.length === 2) break; // keep it to two units, e.g. "1h 5m"
  }
  return parts.join(" ");
}

/** Renders a UTC epoch-seconds timestamp, or "—" when absent. */
function fmtTime(epochSeconds: number | undefined): string {
  if (typeof epochSeconds !== "number") return "—";
  return `${new Date(epochSeconds * 1000).toISOString()} (${epochSeconds})`;
}

/** The public-envelope report — no key, no claims. */
export function formatHeaderText(header: TokenHeader): string[] {
  const versionNote = header.versionAccepted
    ? chalk.green("accepted")
    : chalk.red("not accepted");
  return [
    chalk.bold("\n  Nuraljs Token — Envelope") + chalk.dim("  (public, no key required)"),
    "",
    `  ${chalk.dim("version")}      0x${header.version.toString(16).padStart(2, "0")} (${versionNote})`,
    `  ${chalk.dim("key id")}       ${header.keyId}`,
    `  ${chalk.dim("algorithm")}    ${header.algorithm}`,
    `  ${chalk.dim("nonce")}        ${header.nonce}`,
    `  ${chalk.dim("auth tag")}     ${header.authTag}`,
    `  ${chalk.dim("payload")}      ${chalk.yellow("encrypted")} — ${header.ciphertextBytes} bytes (sealed)`,
    `  ${chalk.dim("total size")}   ${header.totalBytes} bytes`,
  ];
}

/** The decrypted-claims report — shown only to a caller holding the key. */
export function formatDecodedText(decoded: DecodedToken, redact = false): string[] {
  const { claims, temporal } = decoded;
  const lines: string[] = [chalk.bold("\n  Claims") + chalk.dim("  (decrypted locally)"), ""];

  for (const [key, value] of Object.entries(claims)) {
    if (redact) {
      const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
      lines.push(`  ${chalk.cyan(key)}: ${chalk.dim(`<${type}>`)}`);
    } else {
      lines.push(`  ${chalk.cyan(key)}: ${JSON.stringify(value)}`);
    }
  }

  // Temporal claims, interpreted — the DX jump over raw epoch integers.
  lines.push("", chalk.bold("  Validity"), "");
  lines.push(`  ${chalk.dim("issued (iat)")}   ${fmtTime(temporal.issuedAt)}`);
  lines.push(`  ${chalk.dim("expires (exp)")}  ${fmtTime(temporal.expiresAt)}`);
  if (temporal.notBefore !== undefined) {
    const nbfState = temporal.notYetValid ? chalk.red("not yet valid") : chalk.green("active");
    lines.push(`  ${chalk.dim("not before")}     ${fmtTime(temporal.notBefore)} — ${nbfState}`);
  }

  if (temporal.expiresInSeconds !== undefined) {
    if (temporal.expired) {
      lines.push(
        `  ${chalk.dim("status")}         ${chalk.red("EXPIRED")} ${humanizeDuration(temporal.expiresInSeconds)} ago`,
      );
    } else {
      lines.push(
        `  ${chalk.dim("status")}         ${chalk.green("valid")} — expires in ${humanizeDuration(temporal.expiresInSeconds)}`,
      );
    }
  }
  return lines;
}

/** Resolves the secret from the safest available source, or `undefined`. */
async function resolveSecret(opts: TokenInspectOptions): Promise<string | undefined> {
  if (opts.keyFile) {
    const contents = await fs.readFile(opts.keyFile, "utf8");
    return contents.trim();
  }
  if (opts.secret) return opts.secret;
  const fromEnv = process.env[SECRET_ENV];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export async function tokenInspectCommand(
  token: string,
  opts: TokenInspectOptions = {},
): Promise<void> {
  if (!token || token.trim().length === 0) {
    CliLogger.error("No token provided. Usage: nural token inspect <token>");
    process.exitCode = 1;
    return;
  }

  // Loaded lazily so every other CLI command pays nothing for the auth package.
  let inspectTokenHeader: (t: string) => TokenHeader;
  let decodeToken: (t: string, o: { secret: string }) => DecodedToken;
  try {
    ({ inspectTokenHeader, decodeToken } = await import("@nuraljs/auth"));
  } catch {
    CliLogger.error(
      "Could not load @nuraljs/auth. Install it in this project: `npm install @nuraljs/auth`.",
    );
    process.exitCode = 1;
    return;
  }

  // 1) Public envelope — always available, never needs a key.
  let header: TokenHeader;
  try {
    header = inspectTokenHeader(token.trim());
  } catch (err) {
    CliLogger.error(`Not a valid Nuraljs token: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // 2) Optional decrypt — only when the operator supplies their key.
  const secret = await resolveSecret(opts);
  if (opts.secret) {
    CliLogger.warn(
      "Passing --secret on the command line exposes it to your shell history and `ps`. " +
        `Prefer ${SECRET_ENV} or --key-file.`,
    );
  }

  let decoded: DecodedToken | undefined;
  let decodeError: string | undefined;
  if (secret) {
    try {
      decoded = decodeToken(token.trim(), { secret });
    } catch (err) {
      decodeError = (err as Error).message;
    }
  }

  // ── JSON output (tooling) ──────────────────────────────────────────────
  if (opts.json) {
    const payload: Record<string, unknown> = { header };
    if (decoded) {
      payload["claims"] = opts.redact
        ? Object.fromEntries(
            Object.entries(decoded.claims).map(([k, v]) => [
              k,
              Array.isArray(v) ? "array" : v === null ? "null" : typeof v,
            ]),
          )
        : decoded.claims;
      payload["temporal"] = decoded.temporal;
    }
    if (decodeError) payload["decodeError"] = decodeError;
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // ── Human output ───────────────────────────────────────────────────────
  formatHeaderText(header).forEach((line) => console.log(line));

  if (decoded) {
    formatDecodedText(decoded, opts.redact).forEach((line) => console.log(line));
  } else if (decodeError) {
    CliLogger.newline();
    CliLogger.error(`Could not decrypt: ${decodeError}`);
  } else {
    CliLogger.newline();
    CliLogger.dim(
      `  Payload is encrypted. To read the claims, supply the signing secret via ` +
        `${SECRET_ENV}, --key-file <path>, or --secret <value>.`,
    );
  }

  CliLogger.newline();
  CliLogger.dim("  Inspected entirely offline — the token was never transmitted.");
}
