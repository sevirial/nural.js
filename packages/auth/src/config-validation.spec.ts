import { describe, it, expect } from "vitest";
import { createStaticKeyProvider } from "./kms/static-provider";
import { createLocalKeyProvider } from "./kms/local-provider";
import { createCloudKeyProvider } from "./kms/cloud-provider";
import { createSessionManager } from "./session/session-manager";
import { createGithubProvider } from "./providers/github";
import { createGoogleProvider } from "./providers/google";
import { createOIDCProvider } from "./providers/oidc";
import { AuthConfigError, isAuthError } from "./errors";

// Every `createX` factory validates its config with Zod at construction and
// throws a typed `AuthConfigError` (T6.4). The thrown message must never echo a
// secret (Zod issue messages describe the failing path, not the value).

const SECRET = "a-sufficiently-long-secret-value-16+";

describe("config validation — every createX throws a typed AuthConfigError", () => {
  it("createStaticKeyProvider rejects a too-short secret", () => {
    try {
      createStaticKeyProvider("short");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AuthConfigError);
      expect(isAuthError(e) && e.code).toBe("auth_config_invalid");
      expect((e as Error).message).not.toContain("short");
    }
  });

  it("createLocalKeyProvider rejects an empty key list", () => {
    expect(() => createLocalKeyProvider([])).toThrow(AuthConfigError);
  });

  it("createLocalKeyProvider rejects duplicate ids", () => {
    expect(() =>
      createLocalKeyProvider([
        { id: 1, secret: SECRET },
        { id: 1, secret: SECRET },
      ]),
    ).toThrow(AuthConfigError);
  });

  it("createCloudKeyProvider rejects a non-function fetchSecrets", () => {
    const bad = { fetchSecrets: "nope" } as unknown as Parameters<typeof createCloudKeyProvider>[0];
    expect(() => createCloudKeyProvider(bad)).toThrow(AuthConfigError);
  });

  it("createSessionManager rejects an invalid refreshTtlSeconds", () => {
    const auth = { sign: async () => "t" } as unknown as Parameters<typeof createSessionManager>[0];
    const store = {} as unknown as Parameters<typeof createSessionManager>[1];
    expect(() => createSessionManager(auth, store, { refreshTtlSeconds: -1 })).toThrow(
      AuthConfigError,
    );
  });

  it("createGithubProvider rejects a missing clientId", () => {
    const bad = {
      clientId: "",
      clientSecret: "s",
      redirectUri: "https://x/cb",
    } as unknown as Parameters<typeof createGithubProvider>[0];
    expect(() => createGithubProvider(bad)).toThrow(AuthConfigError);
  });

  it("createGoogleProvider rejects a missing redirectUri", () => {
    const bad = {
      clientId: "c",
      clientSecret: "s",
      redirectUri: "",
    } as unknown as Parameters<typeof createGoogleProvider>[0];
    expect(() => createGoogleProvider(bad)).toThrow(AuthConfigError);
  });

  it("createOIDCProvider rejects a missing issuerUrl", () => {
    const bad = {
      issuerUrl: "",
      clientId: "c",
      clientSecret: "s",
      redirectUri: "https://x/cb",
    } as unknown as Parameters<typeof createOIDCProvider>[0];
    expect(() => createOIDCProvider(bad)).toThrow(AuthConfigError);
  });

  it("valid configs construct without throwing", () => {
    expect(() => createStaticKeyProvider(SECRET)).not.toThrow();
    expect(() => createLocalKeyProvider([{ id: 1, secret: SECRET }])).not.toThrow();
    expect(() =>
      createGithubProvider({ clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" }),
    ).not.toThrow();
  });
});
