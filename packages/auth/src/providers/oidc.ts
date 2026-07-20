import { z } from "zod";
import type { AuthProvider, AuthorizeParams, ExchangeParams, OAuthProfile } from "./types";
import { httpJson } from "./http";
import { verifyState, requireCodeVerifier } from "./pkce";
import { createJwksVerifier, type IdTokenClaims } from "./jwks";
import { auditedExchange } from "./observe";
import { parseAuthConfig } from "../config";
import type { AuthObservability } from "../observability";

export interface OIDCConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Extra scopes beyond the default `openid profile email`. */
  scopes?: string[];
  /** Allowed clock skew (seconds) for id_token exp/nbf. Default 60. */
  clockSkewSec?: number;
  /** JWKS cache lifetime (ms). Default 10 minutes. */
  jwksCacheTtlMs?: number;
  /**
   * Require an OIDC `nonce` end-to-end (replay defence). When true (default),
   * `getAuthUrl` refuses to build a URL without a `nonce` and `exchangeCode`
   * refuses to run without an `expectedNonce` — so an id_token can never be
   * replayed across authorization requests. Set false only for a provider that
   * cannot issue a nonce (rare, and weaker).
   */
  requireNonce?: boolean;
  /**
   * Require the resolved email to be verified by the IdP (`email_verified`).
   * When true (default), an unverified email is never returned as identity —
   * blocking account-linking takeover where a consumer keys accounts on email.
   */
  requireVerifiedEmail?: boolean;
  /** Injectable clock (ms epoch) for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Optional observability wiring — emits `oauth.exchange` audit events. */
  observability?: AuthObservability;
}

const OIDCConfigSchema = z
  .object({
    issuerUrl: z.string().min(1, "issuerUrl is required"),
    clientId: z.string().min(1, "clientId is required"),
    clientSecret: z.string().min(1, "clientSecret is required"),
    redirectUri: z.string().min(1, "redirectUri is required"),
    scopes: z.array(z.string()).optional(),
    clockSkewSec: z.number().nonnegative().optional(),
    jwksCacheTtlMs: z.number().positive().optional(),
    requireNonce: z.boolean().optional(),
    requireVerifiedEmail: z.boolean().optional(),
    now: z
      .custom<() => number>((v) => v === undefined || typeof v === "function", "now must be a function")
      .optional(),
    observability: z.custom<AuthObservability>().optional(),
  })
  .passthrough();

const discoverySchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    jwks_uri: z.string(),
    userinfo_endpoint: z.string().optional(),
  })
  .passthrough();
type OIDCEndpoints = z.infer<typeof discoverySchema>;

const tokenResponseSchema = z
  .object({
    access_token: z.string().optional(),
    id_token: z.string(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

const userInfoSchema = z
  .object({
    sub: z.string(),
    email: z.string().optional(),
    // Some IdPs serialize this as the string "true"/"false"; accept both.
    email_verified: z.union([z.boolean(), z.string()]).optional(),
    name: z.string().optional(),
    picture: z.string().optional(),
  })
  .passthrough();

/** True only for a strictly-affirmative `email_verified` (`true` or `"true"`). */
function isEmailVerified(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Creates a generic OpenID Connect provider with auto-discovery.
 *
 * Fetches the `.well-known/openid-configuration` document on first use and
 * caches the endpoints. Unlike a bare OAuth flow, `exchangeCode` proves
 * identity from the **signed id_token**: it verifies the JWT against the
 * issuer's JWKS and validates `iss`/`aud`/`exp`/`nonce` before trusting any
 * claim. The userinfo endpoint is used only as a fallback for optional
 * display fields.
 *
 * @example
 * ```ts
 * const oidc = createOIDCProvider({
 *   issuerUrl: "https://accounts.google.com",
 *   clientId: process.env.OIDC_CLIENT_ID!,
 *   clientSecret: process.env.OIDC_CLIENT_SECRET!,
 *   redirectUri: "http://localhost:3000/auth/oidc/callback",
 * });
 * ```
 */
export function createOIDCProvider(config: OIDCConfig): AuthProvider {
  parseAuthConfig("createOIDCProvider", OIDCConfigSchema, config);
  const requireNonce = config.requireNonce ?? true;
  const requireVerifiedEmail = config.requireVerifiedEmail ?? true;
  let endpoints: OIDCEndpoints | null = null;
  const jwks = createJwksVerifier({
    ttlMs: config.jwksCacheTtlMs,
    now: config.now,
  });

  const discover = async (): Promise<OIDCEndpoints> => {
    if (endpoints) return endpoints;
    endpoints = await httpJson(
      `${config.issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`,
      { method: "GET" },
      discoverySchema,
      { label: "OIDC discovery" },
    );
    return endpoints;
  };

  return {
    name: "oidc",

    getAuthUrl: async ({ state, codeChallenge, nonce }: AuthorizeParams): Promise<string> => {
      // Nonce is what binds the id_token to this authorization. Required by
      // default (replay defence); a missing nonce fails closed rather than
      // silently issuing a replayable id_token.
      if (requireNonce && !nonce) {
        throw new Error(
          "OIDC error: a nonce is required (requireNonce) — generate one with createNonce() and pass it to getAuthUrl",
        );
      }
      const ep = await discover();
      const scope = ["openid", "profile", "email", ...(config.scopes ?? [])].join(" ");
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      if (nonce) params.set("nonce", nonce);
      return `${ep.authorization_endpoint}?${params.toString()}`;
    },

    exchangeCode: auditedExchange("oidc", config.observability, async ({
      code,
      state,
      expectedState,
      codeVerifier,
      expectedNonce,
    }: ExchangeParams): Promise<OAuthProfile> => {
      verifyState(state, expectedState);
      const verifier = requireCodeVerifier(codeVerifier);
      // Fail closed if a nonce was mandated but none was issued for this flow —
      // without it the id_token `nonce` check below cannot bind the token.
      if (requireNonce && !expectedNonce) {
        throw new Error(
          "OIDC error: an expectedNonce is required (requireNonce) — pass the nonce originally issued to getAuthUrl",
        );
      }
      const ep = await discover();

      // 1. Exchange the code; the response MUST carry an id_token.
      const tokens = await httpJson(
        ep.token_endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: config.redirectUri,
            grant_type: "authorization_code",
            code_verifier: verifier,
          }),
        },
        tokenResponseSchema,
        { label: "OIDC token exchange" },
      );
      if (tokens.error) {
        throw new Error(`OIDC error: ${tokens.error_description ?? tokens.error}`);
      }

      // 2. Verify the id_token: signature (JWKS) + iss/aud/exp/nonce.
      const claims: IdTokenClaims = await jwks.verifyIdToken({
        idToken: tokens.id_token,
        jwksUri: ep.jwks_uri,
        issuer: ep.issuer,
        audience: config.clientId,
        expectedNonce,
        clockSkewSec: config.clockSkewSec,
      });

      // 3. Prefer id_token claims; fall back to userinfo for missing display fields.
      // An email is only trusted as identity when the IdP marked it verified
      // (unless the consumer explicitly opted out via requireVerifiedEmail:false).
      const claimEmailOk =
        !requireVerifiedEmail || isEmailVerified(claims.email_verified);
      let email =
        claimEmailOk && typeof claims.email === "string" ? claims.email : undefined;
      let name = typeof claims.name === "string" ? claims.name : undefined;
      let picture = typeof claims.picture === "string" ? claims.picture : undefined;

      if ((!email || !name) && tokens.access_token && ep.userinfo_endpoint) {
        const info = await httpJson(
          ep.userinfo_endpoint,
          { headers: { Authorization: `Bearer ${tokens.access_token}` } },
          userInfoSchema,
          { label: "OIDC userinfo fetch" },
        );
        // The userinfo `sub` must match the id_token `sub` (OIDC §5.3.2).
        if (info.sub !== claims.sub) {
          throw new Error("OIDC error: userinfo subject does not match id_token");
        }
        const infoEmailOk =
          !requireVerifiedEmail || isEmailVerified(info.email_verified);
        if (!email && infoEmailOk) email = info.email;
        name = name ?? info.name;
        picture = picture ?? info.picture;
      }

      if (!email) {
        throw new Error(
          requireVerifiedEmail
            ? "OIDC error: no verified email present in id_token or userinfo"
            : "OIDC error: no email present in id_token or userinfo",
        );
      }

      // 4. Return the normalized profile (sub is guaranteed by id_token validation).
      return {
        providerId: claims.sub,
        email,
        name: name ?? email,
        picture,
        raw: claims,
      };
    }),
  };
}
