import { describe, it, expect } from "vitest";
import { RpcCorrelator, newCorrelationId } from "./rpc-correlation";
import { RpcTimeoutError } from "../errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("newCorrelationId", () => {
  it("returns a v4 UUID", () => {
    expect(newCorrelationId()).toMatch(UUID_RE);
  });
  it("returns a fresh id each call", () => {
    expect(newCorrelationId()).not.toBe(newCorrelationId());
  });
});

describe("RpcCorrelator", () => {
  it("resolves the pending call when a matching reply is delivered", async () => {
    const c = new RpcCorrelator();
    const id = newCorrelationId();
    const p = c.waitFor(id, 1000);
    expect(c.size).toBe(1);
    expect(c.deliver(id, { ok: true })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true });
    expect(c.size).toBe(0);
  });

  it("rejects with a typed RpcTimeoutError after timeoutMs and runs onTimeout", async () => {
    const c = new RpcCorrelator();
    let cleaned = false;
    const p = c.waitFor(newCorrelationId(), 15, () => {
      cleaned = true;
    });
    await expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    expect(cleaned).toBe(true);
    expect(c.size).toBe(0);
  });

  it("deliver returns false for an unknown correlation id", () => {
    const c = new RpcCorrelator();
    expect(c.deliver("nope", 1)).toBe(false);
  });

  it("fail rejects the pending call with the given error", async () => {
    const c = new RpcCorrelator();
    const id = newCorrelationId();
    const p = c.waitFor(id, 1000);
    const err = new Error("publish failed");
    expect(c.fail(id, err)).toBe(true);
    await expect(p).rejects.toBe(err);
  });

  it("rejectAll rejects every pending call and clears the registry", async () => {
    const c = new RpcCorrelator();
    const a = c.waitFor(newCorrelationId(), 1000);
    const b = c.waitFor(newCorrelationId(), 1000);
    c.rejectAll(new Error("closing"));
    await expect(a).rejects.toThrow("closing");
    await expect(b).rejects.toThrow("closing");
    expect(c.size).toBe(0);
  });

  it("a delivered call does not later fire its timeout", async () => {
    const c = new RpcCorrelator();
    const id = newCorrelationId();
    const p = c.waitFor(id, 10);
    c.deliver(id, "fast");
    await expect(p).resolves.toBe("fast");
    // Wait past the original timeout; nothing should re-reject.
    await new Promise((r) => setTimeout(r, 25));
    expect(c.size).toBe(0);
  });
});
