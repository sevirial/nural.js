import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { z } from "zod";
import { createLocalKeyProvider } from "./local-provider";
import { createBinaryTokenEngine } from "../token/binary-token-engine";

const expectedKey = (secret: string, keyId: number): Buffer => {
  const ikm = crypto.createHash("sha256").update(secret).digest();
  const salt = Buffer.alloc(4);
  salt.writeUInt32BE(keyId, 0);
  return Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("nuraljs-auth-token"), 32),
  );
};

describe("createLocalKeyProvider", () => {
  const keys = [
    { id: 2, secret: "this_is_the_new_super_secret_key!" },
    { id: 1, secret: "old_legacy_key_that_is_still_ok!!" },
  ];

  it("treats the first key as primary and derives per-key HKDF keys", async () => {
    const provider = createLocalKeyProvider(keys);
    const primary = await provider.getPrimaryKey();

    expect(primary.id).toBe(2);
    expect(Buffer.compare(primary.secret, expectedKey(keys[0]!.secret, 2))).toBe(0);

    const older = await provider.getKey(1);
    expect(older?.id).toBe(1);
    expect(Buffer.compare(older!.secret, expectedKey(keys[1]!.secret, 1))).toBe(0);
  });

  it("returns undefined for an unknown key id", async () => {
    const provider = createLocalKeyProvider(keys);
    expect(await provider.getKey(99)).toBeUndefined();
  });

  it("rejects an empty key list", () => {
    expect(() => createLocalKeyProvider([])).toThrow(/at least one key/);
  });

  it("rejects duplicate key ids", () => {
    expect(() =>
      createLocalKeyProvider([
        { id: 1, secret: "first_secret_that_is_long_enough!" },
        { id: 1, secret: "second_secret_that_is_long_enough" },
      ]),
    ).toThrow(/unique/);
  });

  it("rejects a secret shorter than 16 chars", () => {
    expect(() =>
      createLocalKeyProvider([{ id: 1, secret: "short" }]),
    ).toThrow(/16 characters/);
  });

  it("rejects a non-integer / out-of-range key id", () => {
    expect(() =>
      createLocalKeyProvider([{ id: 1.5, secret: "a_long_enough_secret_value_here!" }]),
    ).toThrow(/createLocalKeyProvider/);
  });

  it("supports rotation: a token signed under the primary verifies", async () => {
    const schema = z.object({ id: z.string() });
    const engine = createBinaryTokenEngine({
      schema,
      keyProvider: createLocalKeyProvider(keys),
      expiresInSeconds: 60,
    });

    const token = await engine.sign({ id: "user_1" });
    expect((await engine.verify(token)).id).toBe("user_1");
  });
});
