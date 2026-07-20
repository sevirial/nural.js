import { describe, it, expect } from "vitest";
import { requireEngine } from "./optional-engine";

describe("requireEngine — lazy optional-engine loader", () => {
  it("resolves an installed engine to a callable factory", () => {
    // fastify is a devDependency of core, so it resolves here.
    const factory = requireEngine<() => unknown>("fastify", "should not throw");
    expect(typeof factory).toBe("function");
  });

  it("throws the friendly message (not a raw MODULE_NOT_FOUND) when absent", () => {
    const friendly =
      "Nuraljs: the Fictional engine was selected but the 'nuraljs-nonexistent-engine-xyz' package is not installed.";
    expect(() =>
      requireEngine("nuraljs-nonexistent-engine-xyz", friendly),
    ).toThrowError(friendly);
  });

  it("does not leak the underlying resolver error", () => {
    try {
      requireEngine("nuraljs-nonexistent-engine-xyz", "FRIENDLY ONLY");
      throw new Error("expected requireEngine to throw");
    } catch (e) {
      expect((e as Error).message).toBe("FRIENDLY ONLY");
      expect((e as Error).message).not.toMatch(/MODULE_NOT_FOUND|Cannot find/);
    }
  });
});
