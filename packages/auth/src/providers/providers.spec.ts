import { describe, it, expect, vi, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { z } from "zod";
import { httpJson } from "./http";
import { createState, createNonce, createPkcePair, verifyState, requireCodeVerifier } from "./pkce";
import { createJwksVerifier } from "./jwks";
import { createGithubProvider } from "./github";
import { createGoogleProvider } from "./google";
import { createOIDCProvider } from "./oidc";

// ──────────────────────────────────────────────────────────────────────────
// Fetch mocking. httpJson only touches res.ok/res.status/res.json()/res.text(),
// all of which a real undici `Response` provides — so we hand back real
// Responses and route by URL. A handler may also inspect the abort signal to
// simulate a timeout.
// ──────────────────────────────────────────────────────────────────────────
type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response;

function installFetch(handler: FetchHandler): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  });
  vi.stubGlobal("fetch", fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch that never resolves until its request is aborted (timeout sim). */
function hangingFetch(): FetchHandler {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ──────────────────────────────────────────────────────────────────────────
describe("pkce / state helpers", () => {
  it("createPkcePair produces an S256 challenge over the verifier", () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = createPkcePair();
    expect(codeChallengeMethod).toBe("S256");
    const expected = crypto.createHash("sha256").update(codeVerifier).digest().toString("base64url");
    expect(codeChallenge).toBe(expected);
    // base64url, no padding
    expect(codeChallenge).not.toContain("=");
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it("createState / createNonce are high-entropy and unique", () => {
    expect(createState()).not.toBe(createState());
    expect(createNonce()).not.toBe(createNonce());
    expect(createState().length).toBeGreaterThanOrEqual(43);
  });

  it("verifyState accepts a match and rejects mismatch / missing", () => {
    expect(() => verifyState("abc", "abc")).not.toThrow();
    expect(() => verifyState("abc", "xyz")).toThrow(/state mismatch/);
    expect(() => verifyState(undefined, "abc")).toThrow(/no state/);
    expect(() => verifyState("abc", undefined)).toThrow(/no expected state/);
    // length mismatch must not throw a RangeError from timingSafeEqual
    expect(() => verifyState("abcd", "abc")).toThrow(/state mismatch/);
  });

  it("requireCodeVerifier rejects an empty verifier", () => {
    expect(() => requireCodeVerifier("")).toThrow(/code verifier is required/);
    expect(() => requireCodeVerifier(undefined)).toThrow(/code verifier is required/);
    expect(requireCodeVerifier("v")).toBe("v");
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("httpJson", () => {
  const schema = z.object({ ok: z.boolean() });

  it("returns the validated body on 2xx", async () => {
    installFetch(() => json({ ok: true }));
    await expect(httpJson("https://x/y", {}, schema, { baseDelayMs: 0 })).resolves.toEqual({ ok: true });
  });

  it("throws on a non-ok 4xx without retrying", async () => {
    const fn = installFetch(() => json({ error: "bad" }, 400));
    await expect(httpJson("https://x/y", {}, schema, { baseDelayMs: 0, label: "T" })).rejects.toThrow(
      /T failed: HTTP 400/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx then succeeds", async () => {
    let n = 0;
    const fn = installFetch(() => (++n < 2 ? json({}, 503) : json({ ok: true })));
    await expect(httpJson("https://x/y", {}, schema, { baseDelayMs: 0, retries: 2 })).resolves.toEqual({
      ok: true,
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a network error then succeeds", async () => {
    let n = 0;
    const fn = installFetch(() => {
      if (++n < 2) throw new Error("ECONNRESET");
      return json({ ok: true });
    });
    await expect(httpJson("https://x/y", {}, schema, { baseDelayMs: 0 })).resolves.toEqual({ ok: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent 5xx", async () => {
    const fn = installFetch(() => json({}, 500));
    await expect(httpJson("https://x/y", {}, schema, { baseDelayMs: 0, retries: 2 })).rejects.toThrow(
      /HTTP 500/,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("aborts on timeout and surfaces a timeout error", async () => {
    installFetch(hangingFetch());
    await expect(
      httpJson("https://x/y", {}, schema, { baseDelayMs: 0, retries: 0, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it("rejects a 2xx body that fails schema validation (no retry)", async () => {
    const fn = installFetch(() => json({ ok: "not-a-boolean" }));
    await expect(httpJson("https://x/y", {}, schema, { baseDelayMs: 0, label: "T" })).rejects.toThrow(
      /unexpected response shape/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("github provider", () => {
  const cfg = {
    clientId: "gh-id",
    clientSecret: "gh-secret",
    redirectUri: "https://app/cb",
  };
  const ok = {
    code: "c",
    state: "s",
    expectedState: "s",
    codeVerifier: "v",
  };

  it("getAuthUrl embeds state + PKCE challenge and never a blank state", () => {
    const url = createGithubProvider(cfg).getAuthUrl({ state: "st8", codeChallenge: "chal" }) as string;
    const q = new URL(url).searchParams;
    expect(q.get("state")).toBe("st8");
    expect(q.get("code_challenge")).toBe("chal");
    expect(q.get("code_challenge_method")).toBe("S256");
  });

  it("exchangeCode rejects a state mismatch before any fetch", async () => {
    const fn = installFetch(() => json({}));
    await expect(
      createGithubProvider(cfg).exchangeCode({ ...ok, state: "a", expectedState: "b" }),
    ).rejects.toThrow(/state mismatch/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("exchangeCode requires a PKCE verifier", async () => {
    const fn = installFetch(() => json({}));
    await expect(createGithubProvider(cfg).exchangeCode({ ...ok, codeVerifier: "" })).rejects.toThrow(
      /code verifier is required/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns a normalized profile, fetching the verified primary email", async () => {
    installFetch((url) => {
      if (url.includes("access_token")) return json({ access_token: "tok" });
      if (url.endsWith("/user")) return json({ id: 42, login: "octo", name: "Octo", email: null, avatar_url: "a" });
      if (url.endsWith("/user/emails"))
        return json([
          { email: "old@x.com", primary: false, verified: true },
          { email: "octo@x.com", primary: true, verified: true },
        ]);
      throw new Error(`unexpected ${url}`);
    });
    const profile = await createGithubProvider(cfg).exchangeCode(ok);
    expect(profile).toMatchObject({ providerId: "42", email: "octo@x.com", name: "Octo" });
  });

  it("throws on an OAuth error body (200 with error)", async () => {
    installFetch(() => json({ error: "bad_verification_code", error_description: "expired" }));
    await expect(createGithubProvider(cfg).exchangeCode(ok)).rejects.toThrow(/GitHub OAuth error: expired/);
  });

  it("fails explicitly when no verified email is available (no coercion to '')", async () => {
    installFetch((url) => {
      if (url.includes("access_token")) return json({ access_token: "tok" });
      if (url.endsWith("/user")) return json({ id: 1, login: "octo", name: null, email: null, avatar_url: "a" });
      if (url.endsWith("/user/emails")) return json([{ email: "x@x.com", primary: true, verified: false }]);
      throw new Error(url);
    });
    await expect(createGithubProvider(cfg).exchangeCode(ok)).rejects.toThrow(/no accessible verified email/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("google provider", () => {
  const cfg = { clientId: "g-id", clientSecret: "g-secret", redirectUri: "https://app/cb" };
  const ok = { code: "c", state: "s", expectedState: "s", codeVerifier: "v" };

  it("getAuthUrl includes response_type, state and PKCE", () => {
    const url = createGoogleProvider(cfg).getAuthUrl({ state: "s1", codeChallenge: "c1" }) as string;
    const q = new URL(url).searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("state")).toBe("s1");
    expect(q.get("code_challenge")).toBe("c1");
  });

  it("returns a normalized profile", async () => {
    installFetch((url) => {
      if (url.includes("/token")) return json({ access_token: "tok" });
      if (url.includes("userinfo"))
        return json({ id: "gid", email: "u@x.com", verified_email: true, name: "U", picture: "p" });
      throw new Error(url);
    });
    await expect(createGoogleProvider(cfg).exchangeCode(ok)).resolves.toMatchObject({
      providerId: "gid",
      email: "u@x.com",
      name: "U",
    });
  });

  it("rejects an unverified email by default (account-linking takeover defence)", async () => {
    installFetch((url) => {
      if (url.includes("/token")) return json({ access_token: "tok" });
      if (url.includes("userinfo")) return json({ id: "gid", email: "u@x.com", verified_email: false, name: "U" });
      throw new Error(url);
    });
    await expect(createGoogleProvider(cfg).exchangeCode(ok)).rejects.toThrow(/not verified/);
  });

  it("allows an unverified email only when explicitly opted out", async () => {
    installFetch((url) => {
      if (url.includes("/token")) return json({ access_token: "tok" });
      if (url.includes("userinfo")) return json({ id: "gid", email: "u@x.com", verified_email: false, name: "U" });
      throw new Error(url);
    });
    await expect(
      createGoogleProvider({ ...cfg, requireVerifiedEmail: false }).exchangeCode(ok),
    ).resolves.toMatchObject({ email: "u@x.com" });
  });

  it("rejects state mismatch and missing verifier", async () => {
    installFetch(() => json({}));
    await expect(
      createGoogleProvider(cfg).exchangeCode({ ...ok, expectedState: "other" }),
    ).rejects.toThrow(/state mismatch/);
    await expect(createGoogleProvider(cfg).exchangeCode({ ...ok, codeVerifier: "" })).rejects.toThrow(
      /code verifier is required/,
    );
  });

  it("fails explicitly on a profile with no email", async () => {
    installFetch((url) => {
      if (url.includes("/token")) return json({ access_token: "tok" });
      if (url.includes("userinfo")) return json({ id: "gid", name: "U" });
      throw new Error(url);
    });
    await expect(createGoogleProvider(cfg).exchangeCode(ok)).rejects.toThrow(/no email/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// OIDC: a real RSA-signed id_token verified against a mocked JWKS endpoint.
// ──────────────────────────────────────────────────────────────────────────
describe("oidc provider (id_token validation)", () => {
  const ISSUER = "https://idp.example";
  const CLIENT_ID = "oidc-client";
  const KID = "test-key-1";
  const FIXED_MS = 1_700_000_000_000;
  const nowFn = () => FIXED_MS;

  const keypair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keypair.publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
  const jwks = { keys: [jwk] };

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

  function signIdToken(
    claims: Record<string, unknown>,
    opts: { alg?: string; key?: crypto.KeyObject; kid?: string } = {},
  ): string {
    const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
    const input = `${b64(header)}.${b64(claims)}`;
    const sig = crypto.sign("sha256", Buffer.from(input), opts.key ?? keypair.privateKey);
    return `${input}.${sig.toString("base64url")}`;
  }

  const baseClaims = (over: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    sub: "user-123",
    aud: CLIENT_ID,
    exp: Math.floor(FIXED_MS / 1000) + 3600,
    iat: Math.floor(FIXED_MS / 1000),
    nonce: "n0nce",
    email: "u@idp.example",
    email_verified: true,
    name: "OIDC User",
    ...over,
  });

  const discovery = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    userinfo_endpoint: `${ISSUER}/userinfo`,
  };

  function installOidcFetch(idToken: string, withAccessToken = false): void {
    installFetch((url) => {
      if (url.endsWith("/.well-known/openid-configuration")) return json(discovery);
      if (url === discovery.token_endpoint)
        return json({ id_token: idToken, ...(withAccessToken ? { access_token: "at" } : {}) });
      if (url === discovery.jwks_uri) return json(jwks);
      if (url === discovery.userinfo_endpoint)
        return json({ sub: "user-123", email: "u@idp.example", email_verified: true, name: "OIDC User" });
      throw new Error(`unexpected ${url}`);
    });
  }

  const provider = () =>
    createOIDCProvider({
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "sec",
      redirectUri: "https://app/cb",
      now: nowFn,
    });

  const ok = { code: "c", state: "s", expectedState: "s", codeVerifier: "v", expectedNonce: "n0nce" };

  it("getAuthUrl discovers endpoints and includes nonce + PKCE", async () => {
    installFetch((url) => {
      if (url.endsWith("openid-configuration")) return json(discovery);
      throw new Error(url);
    });
    const url = await provider().getAuthUrl({ state: "s", codeChallenge: "chal", nonce: "n0nce" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(`${ISSUER}/authorize`);
    expect(parsed.searchParams.get("nonce")).toBe("n0nce");
    expect(parsed.searchParams.get("code_challenge")).toBe("chal");
    expect(parsed.searchParams.get("scope")).toContain("openid");
  });

  it("accepts a valid, correctly-signed id_token", async () => {
    installOidcFetch(signIdToken(baseClaims()));
    await expect(provider().exchangeCode(ok)).resolves.toMatchObject({
      providerId: "user-123",
      email: "u@idp.example",
      name: "OIDC User",
    });
  });

  it("rejects a tampered signature", async () => {
    const token = signIdToken(baseClaims());
    const tampered = token.slice(0, -4) + (token.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    installOidcFetch(tampered);
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/bad signature|malformed|undecodable/);
  });

  it("rejects a token signed by the wrong key", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    installOidcFetch(signIdToken(baseClaims(), { key: other.privateKey }));
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/bad signature/);
  });

  it("rejects an audience mismatch", async () => {
    installOidcFetch(signIdToken(baseClaims({ aud: "someone-else" })));
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/audience mismatch/);
  });

  it("rejects an issuer mismatch", async () => {
    installOidcFetch(signIdToken(baseClaims({ iss: "https://evil.example" })));
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/issuer mismatch/);
  });

  it("rejects a nonce mismatch", async () => {
    installOidcFetch(signIdToken(baseClaims({ nonce: "different" })));
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/nonce mismatch/);
  });

  it("rejects an expired token", async () => {
    installOidcFetch(signIdToken(baseClaims({ exp: Math.floor(FIXED_MS / 1000) - 3600 })));
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/expired/);
  });

  it("rejects the 'none' algorithm", async () => {
    const header = { alg: "none", kid: KID, typ: "JWT" };
    const token = `${b64(header)}.${b64(baseClaims())}.`;
    installOidcFetch(token);
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/unsupported alg 'none'/);
  });

  it("rejects state mismatch and missing verifier before touching the network", async () => {
    const fn = installFetch(() => json(discovery));
    await expect(provider().exchangeCode({ ...ok, expectedState: "x" })).rejects.toThrow(/state mismatch/);
    await expect(provider().exchangeCode({ ...ok, codeVerifier: "" })).rejects.toThrow(
      /code verifier is required/,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("falls back to userinfo when the id_token omits email (and checks sub match)", async () => {
    const claims: Record<string, unknown> = baseClaims();
    delete claims["email"];
    delete claims["name"];
    installOidcFetch(signIdToken(claims), /* withAccessToken */ true);
    await expect(provider().exchangeCode(ok)).resolves.toMatchObject({
      email: "u@idp.example",
      name: "OIDC User",
    });
  });

  it("rejects an unverified id_token email by default (account-linking takeover defence)", async () => {
    installOidcFetch(signIdToken(baseClaims({ email_verified: false })));
    await expect(provider().exchangeCode(ok)).rejects.toThrow(/no verified email/);
  });

  it("allows an unverified email only when explicitly opted out", async () => {
    installOidcFetch(signIdToken(baseClaims({ email_verified: false })));
    const relaxed = createOIDCProvider({
      issuerUrl: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: "sec",
      redirectUri: "https://app/cb",
      now: nowFn,
      requireVerifiedEmail: false,
    });
    await expect(relaxed.exchangeCode(ok)).resolves.toMatchObject({ email: "u@idp.example" });
  });

  it("getAuthUrl refuses to build a URL without a nonce by default (replay defence)", async () => {
    installFetch((url) => {
      if (url.endsWith("openid-configuration")) return json(discovery);
      throw new Error(url);
    });
    await expect(
      provider().getAuthUrl({ state: "s", codeChallenge: "chal" }),
    ).rejects.toThrow(/nonce is required/);
  });

  it("exchangeCode fails closed without an expectedNonce by default", async () => {
    installOidcFetch(signIdToken(baseClaims()));
    await expect(
      provider().exchangeCode({ ...ok, expectedNonce: undefined }),
    ).rejects.toThrow(/expectedNonce is required/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe("jwks verifier cache", () => {
  const ISSUER = "https://idp.example";
  const KID = "k1";
  const keypair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...keypair.publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = () => 1_700_000_000_000;

  function token(): string {
    const header = { alg: "RS256", kid: KID, typ: "JWT" };
    const claims = { iss: ISSUER, sub: "s", aud: "aud", exp: Math.floor(now() / 1000) + 60, nonce: "n" };
    const input = `${b64(header)}.${b64(claims)}`;
    const sig = crypto.sign("sha256", Buffer.from(input), keypair.privateKey);
    return `${input}.${sig.toString("base64url")}`;
  }

  it("fetches JWKS once and serves subsequent verifies from cache", async () => {
    const fn = installFetch(() => json({ keys: [jwk] }));
    const v = createJwksVerifier({ now });
    const params = {
      idToken: token(),
      jwksUri: `${ISSUER}/jwks`,
      issuer: ISSUER,
      audience: "aud",
      expectedNonce: "n",
    };
    await expect(v.verifyIdToken(params)).resolves.toMatchObject({ sub: "s" });
    await expect(v.verifyIdToken(params)).resolves.toMatchObject({ sub: "s" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
