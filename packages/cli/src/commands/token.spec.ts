import { describe, it, expect } from "vitest";
import { formatHeaderText, formatDecodedText } from "./token.js";
import type { TokenHeader, DecodedToken } from "@nuraljs/auth";

// Strip ANSI colour so assertions match on plain text.
const plain = (lines: string[]): string => lines.join("\n").replace(/\[[0-9;]*m/g, "");

const header: TokenHeader = {
  version: 0x02,
  versionAccepted: true,
  keyId: 1,
  nonce: "6bd005d3fdc4e027073b3e50",
  authTag: "a394cd0ff8644f24c56a16ea434dee25",
  algorithm: "chacha20-poly1305",
  ciphertextBytes: 143,
  totalBytes: 176,
  encrypted: true,
};

describe("formatHeaderText", () => {
  it("renders the public envelope and never implies the payload is readable", () => {
    const out = plain(formatHeaderText(header));
    expect(out).toContain("key id       1");
    expect(out).toContain("0x02 (accepted)");
    expect(out).toContain("chacha20-poly1305");
    expect(out).toContain("encrypted");
    expect(out).toContain("sealed");
  });

  it("flags an unaccepted version", () => {
    const out = plain(formatHeaderText({ ...header, version: 0x09, versionAccepted: false }));
    expect(out).toContain("0x09 (not accepted)");
  });
});

describe("formatDecodedText", () => {
  const base: DecodedToken = {
    header,
    claims: { id: "u42", role: "ADMIN", jti: "abc", iat: 1_000, exp: 4_600 },
    temporal: {
      issuedAt: 1_000,
      expiresAt: 4_600,
      ageSeconds: 100,
      expiresInSeconds: 3_500,
      expired: false,
    },
  };

  it("shows claim values and a human-readable validity window when valid", () => {
    const out = plain(formatDecodedText(base));
    expect(out).toContain('id: "u42"');
    expect(out).toContain('role: "ADMIN"');
    expect(out).toContain("valid");
    expect(out).toContain("expires in");
  });

  it("marks an expired token in the status line", () => {
    const out = plain(
      formatDecodedText({
        ...base,
        temporal: { ...base.temporal, expired: true, expiresInSeconds: -120 },
      }),
    );
    expect(out).toContain("EXPIRED");
    expect(out).toContain("ago");
  });

  it("hides claim values under --redact but keeps the keys and types", () => {
    const out = plain(formatDecodedText(base, true));
    expect(out).toContain("id: <string>");
    expect(out).not.toContain("u42");
  });
});
