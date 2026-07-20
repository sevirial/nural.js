import type { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// httpJson — the single hardened fetch used by every OAuth/OIDC provider.
//
// The original providers called bare `fetch(...)` with no timeout, no retry,
// no `.ok` check on some paths, and a trusting `as SomeType` cast on the JSON
// body. This helper closes all four gaps in one place:
//   • AbortController timeout per attempt (default 10s).
//   • Bounded retry with exponential backoff + jitter, but ONLY for transient
//     failures — network errors, timeouts, HTTP 5xx, and 429. A 4xx (other
//     than 429) is a deterministic client error and is never retried.
//   • `.ok` enforced: a non-ok response throws with the status (and a bounded,
//     best-effort body snippet for the developer — OAuth error bodies are
//     `{error, error_description}`, which carry no secret of ours).
//   • The success body is Zod-validated against `schema`; an unexpected shape
//     throws instead of flowing on as a lie-shaped cast.
//
// Contract: resolves with the validated `z.infer<T>` on a 2xx whose body
// matches `schema`; otherwise throws a plain `Error` with a non-secret message.
// ──────────────────────────────────────────────────────────────────────────

export interface HttpJsonOptions {
  /** Per-attempt timeout in ms before the request is aborted. Default 10_000. */
  timeoutMs?: number;
  /** Extra attempts after the first, for transient failures. Default 2 (→ ≤3 total). */
  retries?: number;
  /** Base backoff delay in ms; grows as `base * 2**attempt` + jitter. Default 200. */
  baseDelayMs?: number;
  /** Label used to prefix error messages (e.g. "GitHub token exchange"). */
  label?: string;
}

/** Longest body snippet echoed into a non-ok error message. */
const MAX_ERROR_DETAIL = 200;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function describeFetchError(err: unknown, timeoutMs: number): string {
  if (isAbortError(err)) return `request timed out after ${timeoutMs}ms`;
  if (err instanceof Error) return err.message;
  return "network error";
}

/** Best-effort, bounded, non-throwing read of an error response body. */
async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    const trimmed = text.length > MAX_ERROR_DETAIL ? `${text.slice(0, MAX_ERROR_DETAIL)}…` : text;
    return ` — ${trimmed.replace(/\s+/g, " ").trim()}`;
  } catch {
    return "";
  }
}

function backoffDelay(attempt: number, base: number): number {
  const expo = base * 2 ** attempt;
  return expo + Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpJson<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  opts: HttpJsonOptions = {},
): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, baseDelayMs = 200, label = "HTTP request" } = opts;

  let lastTransient = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1, baseDelayMs));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      // Network error or timeout — transient, retry if attempts remain.
      lastTransient = describeFetchError(err, timeoutMs);
      if (attempt < retries) continue;
      throw new Error(`${label} failed: ${lastTransient}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const transient = res.status >= 500 || res.status === 429;
      if (transient && attempt < retries) {
        lastTransient = `HTTP ${res.status}`;
        continue;
      }
      throw new Error(`${label} failed: HTTP ${res.status}${await safeErrorDetail(res)}`);
    }

    // 2xx — parse + validate. Neither is retryable: the server answered.
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error(`${label} failed: response was not valid JSON`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      throw new Error(`${label} failed: unexpected response shape (${detail})`);
    }
    return parsed.data;
  }

  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error(`${label} failed: ${lastTransient || "exhausted retries"}`);
}
