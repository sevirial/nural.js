import { z } from "zod";
import type { AuthProvider, AuthorizeParams, ExchangeParams, OAuthProfile } from "./types";
import { httpJson } from "./http";
import { verifyState, requireCodeVerifier } from "./pkce";
import { auditedExchange } from "./observe";
import { parseAuthConfig } from "../config";
import type { AuthObservability } from "../observability";

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
  /** Optional observability wiring — emits `oauth.exchange` audit events. */
  observability?: AuthObservability;
}

const GithubConfigSchema = z
  .object({
    clientId: z.string().min(1, "clientId is required"),
    clientSecret: z.string().min(1, "clientSecret is required"),
    redirectUri: z.string().min(1, "redirectUri is required"),
    scopes: z.array(z.string()).optional(),
    observability: z.custom<AuthObservability>().optional(),
  })
  .passthrough();

// GitHub returns 200 even on error, carrying `{ error, error_description }`.
const tokenResponseSchema = z
  .object({
    access_token: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

const profileSchema = z
  .object({
    id: z.number(),
    login: z.string(),
    name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    avatar_url: z.string().optional(),
  })
  .passthrough();

const emailsSchema = z.array(
  z.object({
    email: z.string(),
    primary: z.boolean().optional(),
    verified: z.boolean().optional(),
    visibility: z.string().nullable().optional(),
  }),
);

/**
 * Creates a GitHub OAuth provider.
 *
 * @example
 * ```ts
 * const github = createGithubProvider({
 *   clientId: process.env.GITHUB_CLIENT_ID!,
 *   clientSecret: process.env.GITHUB_CLIENT_SECRET!,
 *   redirectUri: "http://localhost:3000/auth/github/callback",
 * });
 * ```
 */
export function createGithubProvider(config: GithubConfig): AuthProvider {
  parseAuthConfig("createGithubProvider", GithubConfigSchema, config);
  return {
    name: "github",

    /**
     * Generate the GitHub login URL. `state` (anti-CSRF) and the PKCE
     * `codeChallenge` are required; the caller persists the matching
     * `state`/`codeVerifier` and replays them on the callback.
     */
    getAuthUrl: ({ state, codeChallenge }: AuthorizeParams): string => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes?.join(" ") ?? "user:email",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `https://github.com/login/oauth/authorize?${params.toString()}`;
    },

    /**
     * Exchange the authorization code for a normalized user profile.
     * Verifies `state` and requires the PKCE `codeVerifier` before trading.
     * Wrapped with `oauth.exchange` audit logging.
     */
    exchangeCode: auditedExchange("github", config.observability, async ({
      code,
      state,
      expectedState,
      codeVerifier,
    }: ExchangeParams): Promise<OAuthProfile> => {
      verifyState(state, expectedState);
      const verifier = requireCodeVerifier(codeVerifier);

      // 1. Exchange code for a GitHub access token.
      const tokens = await httpJson(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: config.redirectUri,
            code_verifier: verifier,
          }),
        },
        tokenResponseSchema,
        { label: "GitHub token exchange" },
      );
      if (tokens.error || !tokens.access_token) {
        throw new Error(`GitHub OAuth error: ${tokens.error_description ?? tokens.error ?? "no access_token"}`);
      }
      const accessToken = tokens.access_token;

      // 2. Fetch the user profile.
      const profile = await httpJson(
        "https://api.github.com/user",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "nuraljs-auth",
          },
        },
        profileSchema,
        { label: "GitHub profile fetch" },
      );

      // 3. GitHub emails may be private — fetch the verified primary separately.
      let email = profile.email ?? null;
      if (!email) {
        const emails = await httpJson(
          "https://api.github.com/user/emails",
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "nuraljs-auth",
            },
          },
          emailsSchema,
          { label: "GitHub emails fetch" },
        );
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        email = primary?.email ?? null;
      }
      if (!email) {
        throw new Error("GitHub OAuth error: account has no accessible verified email");
      }

      // 4. Return the normalized profile.
      return {
        providerId: profile.id.toString(),
        email,
        name: profile.name ?? profile.login,
        picture: profile.avatar_url,
        raw: profile,
      };
    }),
  };
}
