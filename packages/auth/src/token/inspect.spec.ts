import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { z } from "zod";
import { createBinaryTokenEngine } from "./binary-token-engine";
import { createStaticKeyProvider } from "../kms/static-provider";
import { inspectTokenHeader, decodeToken } from "./inspect";
import { deriveKeyMaterial } from "../kms/derive";
import { TokenInvalidError } from "../errors";

// A real secret + engine, so the inspector is exercised against genuine tokens
// rather than hand-forged ones — this is the round-trip that proves the two
// share one wire format.
const SECRET = "inspect-secret-that-is-plenty-long-enough";
const Schema = z.object({ id: z.string(), role: z.enum(["ADMIN", "USER"]) });
const engine = createBinaryTokenEngine({
  schema: Schema,
  keyProvider: createStaticKeyProvider(SECRET),
  expiresInSeconds: 3600,
});

describe("inspectTokenHeader — key-free structural view", () => {
  it("reads the public envelope of a real token without any key", async () => {
    const token = await engine.sign({ id: "u1", role: "ADMIN" });
    const header = inspectTokenHeader(token);

    expect(header.version).toBe(0x02);
    expect(header.versionAccepted).toBe(true);
    expect(header.keyId).toBe(1); // static provider's fixed key id
    expect(header.algorithm).toBe("chacha20-poly1305");
    expect(header.encrypted).toBe(true);
    expect(header.nonce).toMatch(/^[0-9a-f]{24}$/); // 12 bytes hex
    expect(header.authTag).toMatch(/^[0-9a-f]{32}$/); // 16 bytes hex
    expect(header.ciphertextBytes).toBeGreaterThan(0);
    expect(header.totalBytes).toBe(33 + header.ciphertextBytes);
  });

  it("never exposes the claims — the header carries no payload fields", async () => {
    const token = await engine.sign({ id: "secret-user", role: "ADMIN" });
    const header = inspectTokenHeader(token);
    expect(JSON.stringify(header)).not.toContain("secret-user");
  });

  it("flags an unaccepted version rather than throwing", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    const packet = Buffer.from(token, "base64url");
    packet.writeUInt8(0x09, 0); // an unknown future version
    const header = inspectTokenHeader(packet.toString("base64url"));
    expect(header.version).toBe(0x09);
    expect(header.versionAccepted).toBe(false);
  });

  it("rejects malformed / too-short / empty input as a typed error", () => {
    for (const bad of ["", "   ", "!!!not-base64!!!", "AAAA"]) {
      expect(() => inspectTokenHeader(bad)).toThrow(TokenInvalidError);
    }
  });
});

describe("decodeToken — authenticated local decode", () => {
  it("decrypts claims from the raw secret (round-trip through the engine)", async () => {
    const token = await engine.sign({ id: "u42", role: "ADMIN" });
    const decoded = decodeToken(token, { secret: SECRET });

    expect(decoded.claims["id"]).toBe("u42");
    expect(decoded.claims["role"]).toBe("ADMIN");
    expect(typeof decoded.claims["jti"]).toBe("string");
    expect(decoded.header.keyId).toBe(1);
  });

  it("interprets the temporal claims relative to nowSeconds", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    const iat = decodeToken(token, { secret: SECRET }).temporal.issuedAt!;

    const decoded = decodeToken(token, { secret: SECRET, nowSeconds: iat + 100 });
    expect(decoded.temporal.ageSeconds).toBe(100);
    expect(decoded.temporal.expiresInSeconds).toBe(3600 - 100);
    expect(decoded.temporal.expired).toBe(false);
  });

  it("reports an expired token as expired instead of rejecting it", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    const exp = decodeToken(token, { secret: SECRET }).temporal.expiresAt!;

    const decoded = decodeToken(token, { secret: SECRET, nowSeconds: exp + 10 });
    expect(decoded.temporal.expired).toBe(true);
    expect(decoded.temporal.expiresInSeconds).toBe(-10);
    expect(decoded.claims["id"]).toBe("u1"); // still decoded — reports, not enforces
  });

  it("accepts a pre-derived 32-byte wire key directly", async () => {
    const token = await engine.sign({ id: "u7", role: "ADMIN" });
    const key = deriveKeyMaterial(SECRET, 1);
    const decoded = decodeToken(token, { key });
    expect(decoded.claims["id"]).toBe("u7");
  });

  it("fails closed on the wrong secret without a decryption oracle", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    let message = "";
    try {
      decodeToken(token, { secret: "a-completely-different-wrong-secret-value" });
    } catch (e) {
      expect(e).toBeInstanceOf(TokenInvalidError);
      message = (e as Error).message;
    }
    // Same message a tampered token yields — no "wrong key" vs "tampered" signal.
    expect(message).toContain("wrong key or the token was tampered");
  });

  it("rejects a tampered ciphertext (AEAD failure)", async () => {
    const token = await engine.sign({ id: "u1", role: "ADMIN" });
    const packet = Buffer.from(token, "base64url");
    const last = packet.length - 1;
    packet.writeUInt8(packet.readUInt8(last) ^ 0xff, last); // flip a ciphertext byte
    expect(() => decodeToken(packet.toString("base64url"), { secret: SECRET })).toThrow(
      TokenInvalidError,
    );
  });

  it("rejects a wrong-length explicit key", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    expect(() => decodeToken(token, { key: crypto.randomBytes(16) })).toThrow(
      TokenInvalidError,
    );
  });

  it("requires a secret or key", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    expect(() => decodeToken(token, {})).toThrow(TokenInvalidError);
    expect(() => decodeToken(token, { secret: "" })).toThrow(TokenInvalidError);
  });

  it("never embeds the secret or wire key in its output", async () => {
    const token = await engine.sign({ id: "u1", role: "USER" });
    const decoded = decodeToken(token, { secret: SECRET });
    const serialized = JSON.stringify(decoded);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(deriveKeyMaterial(SECRET, 1).toString("hex"));
  });
});
