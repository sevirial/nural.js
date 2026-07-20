import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { z } from "zod";
import { createStaticKeyProvider } from "./static-provider";
import { createBinaryTokenEngine } from "../token/binary-token-engine";

/** Independent re-derivation of the wire key — locks the exact HKDF params. */
const expectedKey = (secret: string, keyId: number): Buffer => {
  const ikm = crypto.createHash("sha256").update(secret).digest();
  const salt = Buffer.alloc(4);
  salt.writeUInt32BE(keyId, 0);
  return Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("nuraljs-auth-token"), 32),
  );
};

describe("createStaticKeyProvider", () => {
  const secret = "a_sufficiently_long_static_secret!";

  it("resolves key id 1 as primary with a 32-byte HKDF-derived key", async () => {
    const provider = createStaticKeyProvider(secret);
    const primary = await provider.getPrimaryKey();

    expect(primary.id).toBe(1);
    expect(primary.secret).toHaveLength(32);
    // Params must match Sprint 1 exactly, or previously-signed tokens break.
    expect(Buffer.compare(primary.secret, expectedKey(secret, 1))).toBe(0);
  });

  it("returns the key only for id 1", async () => {
    const provider = createStaticKeyProvider(secret);
    expect((await provider.getKey(1))?.id).toBe(1);
    expect(await provider.getKey(2)).toBeUndefined();
  });

  it("rejects a secret shorter than 16 chars (Zod-validated)", () => {
    expect(() => createStaticKeyProvider("too_short")).toThrow(
      /createStaticKeyProvider.*16 characters/,
    );
  });

  it("rejects a non-string secret", () => {
    // Deliberately bypass the type to exercise runtime validation.
    expect(() => createStaticKeyProvider(123 as unknown as string)).toThrow(
      /createStaticKeyProvider/,
    );
  });

  it("signs and verifies a token end-to-end through the engine", async () => {
    const schema = z.object({ id: z.string() });
    const engine = createBinaryTokenEngine({
      schema,
      keyProvider: createStaticKeyProvider(secret),
      expiresInSeconds: 60,
    });

    const token = await engine.sign({ id: "user_1" });
    const payload = await engine.verify(token);
    expect(payload.id).toBe("user_1");
  });
});
