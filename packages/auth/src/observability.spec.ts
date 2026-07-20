import { describe, it, expect, vi } from "vitest";
import {
  createAuditor,
  enforceRateLimit,
  noopMetrics,
  type AuthLogger,
  type AuthMetrics,
  type AuthAuditEvent,
} from "./observability";
import { RateLimitError } from "./errors";

/** A logger spy that records every line it is handed, per level. */
function recordingLogger() {
  const lines: { level: string; message: string }[] = [];
  const push = (level: string) => (message: string) => lines.push({ level, message });
  const logger: AuthLogger = {
    log: push("log"),
    warn: push("warn"),
    error: (m) => lines.push({ level: "error", message: m }),
    debug: push("debug"),
  };
  return { logger, lines, all: () => lines.map((l) => l.message).join("\n") };
}

describe("createAuditor", () => {
  it("logs a success event at log level and a failure at warn level", () => {
    const { logger, lines } = recordingLogger();
    const audit = createAuditor({ logger });

    audit.record({ type: "token.sign", outcome: "success", userId: "u1" });
    audit.record({ type: "token.verify_fail", outcome: "failure", reason: "token_expired" });

    expect(lines).toHaveLength(2);
    expect(lines[0]!.level).toBe("log");
    expect(lines[0]!.message).toContain("token.sign");
    expect(lines[0]!.message).toContain("u1");
    expect(lines[1]!.level).toBe("warn");
    expect(lines[1]!.message).toContain("token.verify_fail");
    expect(lines[1]!.message).toContain("token_expired");
  });

  it("serializes ONLY the allow-listed keys — a smuggled extra field never logs", () => {
    const { logger, all } = recordingLogger();
    const audit = createAuditor({ logger });

    // Attach a secret on an extra property the type doesn't declare.
    const event = {
      type: "token.sign",
      outcome: "success",
      userId: "u1",
    } as AuthAuditEvent & Record<string, unknown>;
    event["token"] = "super-secret-token-bytes";
    event["secret"] = "hunter2";

    audit.record(event);

    const logged = all();
    expect(logged).toContain("u1");
    expect(logged).not.toContain("super-secret-token-bytes");
    expect(logged).not.toContain("hunter2");
  });

  it("increments metrics with the event.outcome and non-secret attributes", () => {
    const increment = vi.fn();
    const metrics: AuthMetrics = { increment };
    const audit = createAuditor({ metrics });

    audit.record({
      type: "oauth.exchange",
      outcome: "failure",
      provider: "github",
      reason: "oauth_exchange_failed",
    });

    expect(increment).toHaveBeenCalledWith("oauth.exchange.failure", {
      provider: "github",
      reason: "oauth_exchange_failed",
    });
  });

  it("calls the onAudit sink with the (timestamped) event", () => {
    const onAudit = vi.fn();
    const audit = createAuditor({ onAudit });

    audit.record({ type: "session.revoke", outcome: "success", userId: "u9" });

    expect(onAudit).toHaveBeenCalledTimes(1);
    const event = onAudit.mock.calls[0]![0] as AuthAuditEvent;
    expect(event.type).toBe("session.revoke");
    expect(event.userId).toBe("u9");
    expect(typeof event.at).toBe("number");
  });

  it("is a silent no-op when no wiring is supplied", () => {
    const audit = createAuditor();
    expect(() => audit.record({ type: "token.sign", outcome: "success" })).not.toThrow();
  });

  it("noopMetrics.increment does nothing and never throws", () => {
    expect(() => noopMetrics.increment("x", { a: 1 })).not.toThrow();
  });
});

describe("enforceRateLimit", () => {
  it("is a no-op when no hook is configured", async () => {
    await expect(enforceRateLimit(undefined, { operation: "verify" })).resolves.toBeUndefined();
  });

  it("allows when the hook returns void or true", async () => {
    await expect(enforceRateLimit(() => undefined, { operation: "verify" })).resolves.toBeUndefined();
    await expect(enforceRateLimit(() => true, { operation: "rotate" })).resolves.toBeUndefined();
  });

  it("throws RateLimitError when the hook returns false", async () => {
    await expect(
      enforceRateLimit(() => false, { operation: "exchange", provider: "google" }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("propagates a hook's own thrown error unchanged", async () => {
    const boom = new RateLimitError("custom limit");
    await expect(
      enforceRateLimit(() => {
        throw boom;
      }, { operation: "verify" }),
    ).rejects.toBe(boom);
  });

  it("passes the operation/provider context to the hook", async () => {
    const hook = vi.fn(() => true);
    await enforceRateLimit(hook, { operation: "exchange", provider: "oidc" });
    expect(hook).toHaveBeenCalledWith({ operation: "exchange", provider: "oidc" });
  });
});
