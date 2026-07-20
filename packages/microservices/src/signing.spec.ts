import { describe, it, expect } from "vitest";
import { createSharedSecretSigner, IDENTITY_SIGNER } from "./signing";
import { InvalidMessageError } from "./errors";

describe("Sprint 10 — message signing / shared-secret auth (T10.4)", () => {
  const payload = JSON.stringify({ topic: "orders.create", data: { id: 42 } });

  it("round-trips: verify(sign(payload)) returns the original payload", () => {
    const signer = createSharedSecretSigner({ secret: "shared-secret" });
    const wire = signer.sign(payload);
    expect(wire).not.toBe(payload); // it is wrapped in a signed envelope
    expect(signer.verify(wire)).toBe(payload);
  });

  it("rejects a TAMPERED payload (bytes changed in flight)", () => {
    const signer = createSharedSecretSigner({ secret: "shared-secret" });
    const env = JSON.parse(signer.sign(payload));
    env.payload = JSON.stringify({ topic: "orders.create", data: { id: 9999 } }); // swap the amount
    const tampered = JSON.stringify(env);

    const err = catchErr(() => signer.verify(tampered));
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect((err as InvalidMessageError).code).toBe("signature_invalid");
    expect((err as InvalidMessageError).retryable).toBe(false); // permanent → DLQ, never retried
  });

  it("rejects a FORGED signature (message signed with a different secret)", () => {
    const attacker = createSharedSecretSigner({ secret: "attacker-secret" });
    const receiver = createSharedSecretSigner({ secret: "the-real-secret" });
    const forged = attacker.sign(payload);

    const err = catchErr(() => receiver.verify(forged));
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect((err as InvalidMessageError).code).toBe("signature_invalid");
  });

  it("rejects an UNSIGNED / non-envelope message", () => {
    const signer = createSharedSecretSigner({ secret: "shared-secret" });
    const err = catchErr(() => signer.verify(payload)); // raw, no envelope
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect((err as InvalidMessageError).code).toBe("signature_missing");
  });

  it("rejects a message whose signature field was stripped", () => {
    const signer = createSharedSecretSigner({ secret: "shared-secret" });
    const env = JSON.parse(signer.sign(payload));
    delete env.sig;
    const err = catchErr(() => signer.verify(JSON.stringify(env)));
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect((err as InvalidMessageError).code).toBe("signature_missing");
  });

  it("enforces an optional replay window via maxAgeMs", () => {
    let clock = 1_000_000;
    const signer = createSharedSecretSigner({ secret: "s", maxAgeMs: 5_000, now: () => clock });
    const wire = signer.sign(payload);
    expect(signer.verify(wire)).toBe(payload); // fresh — ok

    clock += 6_000; // advance past the window
    const err = catchErr(() => signer.verify(wire));
    expect(err).toBeInstanceOf(InvalidMessageError);
    expect((err as InvalidMessageError).code).toBe("signature_expired");
  });

  it("requires a secret", () => {
    expect(() => createSharedSecretSigner({ secret: "" })).toThrow(/secret is required/);
  });

  it("the IDENTITY_SIGNER default is a passthrough (no signing)", () => {
    expect(IDENTITY_SIGNER.sign(payload)).toBe(payload);
    expect(IDENTITY_SIGNER.verify(payload)).toBe(payload);
  });
});

/** Returns whatever `fn` throws (or undefined if it did not throw). */
function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}
