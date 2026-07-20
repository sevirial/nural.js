import { describe, it, expect } from "vitest";
import * as crypto from "node:crypto";
import { pack } from "msgpackr";
import { z } from "zod";
import { createBinaryTokenEngine, DEFAULT_MAX_TOKEN_BYTES } from "./binary-token-engine";
import { createLocalKeyProvider } from "../kms/local-provider";

describe("BinaryTokenEngine (ChaCha20-Poly1305)", () => {
  const SessionSchema = z.object({
    id: z.string(),
    role: z.enum(["ADMIN", "USER"]),
  });

  const keys = [
    { id: 2, secret: "this_is_the_new_super_secret_key!" },
    { id: 1, secret: "old_legacy_key_that_is_still_ok!!" },
  ];

  const createEngine = (keyList = keys, expiresInSeconds = 3600) =>
    createBinaryTokenEngine({
      schema: SessionSchema,
      keyProvider: createLocalKeyProvider(keyList),
      expiresInSeconds,
    });

  const now = () => Math.floor(Date.now() / 1000);

  /**
   * Forges a well-formed, authentically-encrypted token with *arbitrary* claims,
   * mirroring the engine's wire format + HKDF-SHA256 key derivation. This lets us
   * exercise claim validation (missing `exp`, future `nbf`, bad `iss`/`aud`, etc.)
   * and version handling without going through `sign` (which always stamps them).
   */
  const forge = (
    claims: Record<string, unknown>,
    opts: { keyId?: number; secret?: string; version?: number } = {}
  ): string => {
    const keyId = opts.keyId ?? keys[0]!.id;
    const secret = opts.secret ?? keys[0]!.secret;
    // The KMS provider derives the wire key: HKDF-SHA256 over SHA-256(secret),
    // salted with the 4-byte BE key id. The engine uses that key verbatim.
    const ikm = crypto.createHash("sha256").update(secret).digest();
    const salt = Buffer.alloc(4);
    salt.writeUInt32BE(keyId, 0);
    const encKey = Buffer.from(
      crypto.hkdfSync("sha256", ikm, salt, Buffer.from("nuraljs-auth-token"), 32)
    );

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("chacha20-poly1305", encKey, nonce, {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([cipher.update(pack(claims)), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const packet = Buffer.alloc(1 + 4 + 12 + 16 + ciphertext.length);
    packet.writeUInt8(opts.version ?? 0x02, 0);
    packet.writeUInt32BE(keyId, 1);
    nonce.copy(packet, 5);
    authTag.copy(packet, 17);
    ciphertext.copy(packet, 33);
    return packet.toString("base64url");
  };

  const valid = { id: "user_1", role: "USER" as const };

  it("should encrypt and decrypt a valid payload seamlessly", async () => {
    const engine = createEngine();
    const payload = { id: "user_123", role: "ADMIN" as const };

    const token = await engine.sign(payload);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(50);

    const decrypted = await engine.verify(token);
    expect(decrypted.id).toBe("user_123");
    expect(decrypted.role).toBe("ADMIN");
  });

  it("should cleanly reject payloads that violate the Zod Schema", async () => {
    const engine = createEngine();
    const invalidPayload = { id: "user_123", role: "SUPER_ADMIN" };

    await expect(
      // @ts-expect-error Testing invalid runtime input
      engine.sign(invalidPayload)
    ).rejects.toThrowError();
  });

  it("should support zero-downtime key rotation (decrypting older tokens)", async () => {
    // Engine with ONLY the old key signs a token
    const oldEngine = createEngine([keys[1]!]);
    const tokenFromOld = await oldEngine.sign({ id: "user_456", role: "USER" });

    // The current engine has both keys — should decrypt the old token
    const currentEngine = createEngine();
    const decrypted = await currentEngine.verify(tokenFromOld);
    expect(decrypted.id).toBe("user_456");
    expect(decrypted.role).toBe("USER");
  });

  it("should reject tokens with unknown Key IDs", async () => {
    const rogueEngine = createEngine([
      { id: 99, secret: "rogue_key_from_another_server!!!!" },
    ]);
    const rogueToken = await rogueEngine.sign({ id: "user_789", role: "USER" });

    const engine = createEngine();
    await expect(engine.verify(rogueToken)).rejects.toThrowError(
      /Unknown Key ID/
    );
  });

  it("should reject tampered or corrupted tokens", async () => {
    const engine = createEngine();
    const validToken = await engine.sign({ id: "user_tampered", role: "USER" });

    // Corrupt the middle of the token (messing up AuthTag or Ciphertext)
    const corrupted =
      validToken.substring(0, 20) + "A" + validToken.substring(21);

    await expect(engine.verify(corrupted)).rejects.toThrowError(
      /Invalid signature or corrupted token/
    );
  });

  it("should reject expired tokens", async () => {
    // Create an engine with 0-second expiration
    const engine = createEngine(keys, 0);
    const token = await engine.sign({ id: "user_expired", role: "USER" });

    // Token is immediately expired
    await expect(engine.verify(token)).rejects.toThrowError(
      /Token expired/
    );
  });

  it("should produce different tokens for the same payload (nonce uniqueness)", async () => {
    const engine = createEngine();
    const payload = { id: "user_same", role: "ADMIN" as const };

    const token1 = await engine.sign(payload);
    const token2 = await engine.sign(payload);

    expect(token1).not.toBe(token2);
  });

  it("should stamp iat and jti on every signed token", async () => {
    // A round-trip proves the extra claims are carried and stripped by the
    // user schema; the forge-based tests below assert their enforcement.
    const engine = createEngine();
    const token = await engine.sign({ id: "user_claims", role: "USER" });
    await expect(engine.verify(token)).resolves.toEqual({
      id: "user_claims",
      role: "USER",
    });
  });

  describe("mandatory exp (no never-expiring path)", () => {
    it("rejects an authentic token that carries no exp claim", async () => {
      const engine = createEngine();
      const token = forge({ ...valid, iat: now(), jti: crypto.randomUUID() });
      await expect(engine.verify(token)).rejects.toThrowError(/Missing expiration/);
    });

    it("rejects a token whose exp is not a number", async () => {
      const engine = createEngine();
      const token = forge({ ...valid, exp: "soon" });
      await expect(engine.verify(token)).rejects.toThrowError(/Missing expiration/);
    });
  });

  describe("clock-skew tolerance boundaries", () => {
    it("treats a just-past-exp token as expired with zero tolerance", async () => {
      const engine = createEngine();
      const token = forge({ ...valid, exp: now() - 1 });
      await expect(engine.verify(token)).rejects.toThrowError(/Token expired/);
    });

    it("forgives drift within the tolerance window", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        clockToleranceSeconds: 60,
      });
      // Expired 30s ago, but within the 60s skew window → accepted.
      const token = forge({ ...valid, exp: now() - 30 });
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });

    it("still rejects once drift exceeds the tolerance window", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        clockToleranceSeconds: 60,
      });
      const token = forge({ ...valid, exp: now() - 120 });
      await expect(engine.verify(token)).rejects.toThrowError(/Token expired/);
    });
  });

  describe("nbf (not-before)", () => {
    it("rejects a token that is not yet valid", async () => {
      const engine = createEngine();
      const token = forge({ ...valid, exp: now() + 3600, nbf: now() + 1000 });
      await expect(engine.verify(token)).rejects.toThrowError(/not yet valid/);
    });

    it("accepts an nbf-bearing token once nbf has passed", async () => {
      const engine = createEngine();
      const token = forge({ ...valid, exp: now() + 3600, nbf: now() - 10 });
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });

    it("stamps nbf when notBeforeSeconds is configured", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        notBeforeSeconds: 1000,
      });
      const token = await engine.sign(valid);
      await expect(engine.verify(token)).rejects.toThrowError(/not yet valid/);
    });
  });

  describe("iss / aud binding", () => {
    const withIssuer = (issuer: string) =>
      createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        issuer,
      });
    const withAudience = (audience: string) =>
      createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        audience,
      });

    it("round-trips when iss matches", async () => {
      const engine = withIssuer("nural-auth");
      const token = await engine.sign(valid);
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });

    it("rejects a mismatched issuer", async () => {
      const signer = withIssuer("issuer-a");
      const verifier = withIssuer("issuer-b");
      const token = await signer.sign(valid);
      await expect(verifier.verify(token)).rejects.toThrowError(/Issuer mismatch/);
    });

    it("rejects when iss is required but absent", async () => {
      const engine = withIssuer("nural-auth");
      const token = forge({ ...valid, exp: now() + 3600 });
      await expect(engine.verify(token)).rejects.toThrowError(/Issuer mismatch/);
    });

    it("round-trips when aud matches", async () => {
      const engine = withAudience("api.nural.dev");
      const token = await engine.sign(valid);
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });

    it("rejects a mismatched audience", async () => {
      const signer = withAudience("api-a");
      const verifier = withAudience("api-b");
      const token = await signer.sign(valid);
      await expect(verifier.verify(token)).rejects.toThrowError(/Audience mismatch/);
    });

    it("does not enforce iss/aud when unconfigured", async () => {
      const engine = createEngine();
      const token = forge({ ...valid, exp: now() + 3600, iss: "whoever", aud: "whatever" });
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });
  });

  describe("jti revocation hook", () => {
    it("rejects a revoked jti", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        isRevoked: async () => true,
      });
      const token = await engine.sign(valid);
      await expect(engine.verify(token)).rejects.toThrowError(/Token revoked/);
    });

    it("passes a jti that is not revoked", async () => {
      const revoked = new Set<string>();
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        isRevoked: (jti) => revoked.has(jti),
      });
      const token = await engine.sign(valid);
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });

    it("fails closed when a hook is set but the token has no jti", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        isRevoked: async () => false,
      });
      const token = forge({ ...valid, exp: now() + 3600 });
      await expect(engine.verify(token)).rejects.toThrowError(/Missing token id/);
    });
  });

  describe("version accept-list", () => {
    it("rejects an unknown version byte", async () => {
      const engine = createEngine();
      const legacy = forge({ ...valid, exp: now() + 3600 }, { version: 0x01 });
      await expect(engine.verify(legacy)).rejects.toThrowError(/Unsupported version/);
    });

    it("rejects a reserved future version byte", async () => {
      const engine = createEngine();
      const future = forge({ ...valid, exp: now() + 3600 }, { version: 0x03 });
      await expect(engine.verify(future)).rejects.toThrowError(/Unsupported version/);
    });
  });

  describe("maxTokenBytes input bound (Sprint SF1 — audit L4)", () => {
    it("rejects an over-length token before decoding it", async () => {
      const engine = createEngine();
      await expect(engine.verify("A".repeat(DEFAULT_MAX_TOKEN_BYTES + 1))).rejects.toThrowError(
        /Token too long/,
      );
    });

    it("accepts a normally-sized token (the default cap is generous)", async () => {
      const engine = createEngine();
      const token = await engine.sign(valid);
      expect(token.length).toBeLessThan(DEFAULT_MAX_TOKEN_BYTES);
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
    });

    it("honours a custom cap, measured in bytes", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        maxTokenBytes: 16,
      });
      const token = await engine.sign(valid); // a real token is far longer than 16 bytes
      await expect(engine.verify(token)).rejects.toThrowError(/Token too long/);
    });

    it("maxTokenBytes: 0 disables the bound", async () => {
      const engine = createBinaryTokenEngine({
        schema: SessionSchema,
        keyProvider: createLocalKeyProvider(keys),
        expiresInSeconds: 3600,
        maxTokenBytes: 0,
      });
      const token = await engine.sign(valid);
      await expect(engine.verify(token)).resolves.toMatchObject(valid);
      // Still rejected on its merits, not its length.
      await expect(engine.verify("A".repeat(20_000))).rejects.toThrowError(/NuraljsBinaryToken:/);
    });
  });

  describe("truncated / garbage base64url fuzz", () => {
    const engine = createEngine();
    const cases = [
      "",
      "A",
      "AAAA",
      "not-a-real-token",
      "!!!!!!!!!!!!",
      "$".repeat(80),
      crypto.randomBytes(10).toString("base64url"),
      crypto.randomBytes(40).toString("base64url"),
      crypto.randomBytes(200).toString("base64url"),
    ];

    it.each(cases)("rejects garbage input %#", async (input) => {
      await expect(engine.verify(input)).rejects.toThrowError(/NuraljsBinaryToken:/);
    });

    it("rejects a valid token truncated mid-ciphertext", async () => {
      const token = await engine.sign(valid);
      const raw = Buffer.from(token, "base64url");
      const truncated = raw.subarray(0, raw.length - 4).toString("base64url");
      await expect(engine.verify(truncated)).rejects.toThrowError(
        /Invalid signature or corrupted token/
      );
    });
  });
});
