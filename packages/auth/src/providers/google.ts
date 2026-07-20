import { z } from "zod";
import type { AuthProvider, AuthorizeParams, ExchangeParams, OAuthProfile } from "./types";
import { httpJson } from "./http";
import { verifyState, requireCodeVerifier } from "./pkce";
import { auditedExchange } from "./observe";
import { parseAuthConfig } from "../config";
import type { AuthObservability } from "../observability";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
  /**
   * Require Google to have verified the email (`verified_email`). When true
   * (default), an unverified email is never returned as identity — blocking
   * account-linking takeover where a consumer keys accounts on email.
   */
  requireVerifiedEmail?: boolean;
  /** Optional observability wiring — emits `oauth.exchange` audit events. */
  observability?: AuthObservability;
}

const GoogleConfigSchema = z
  .object({
    clientId: z.string().min(1, "clientId is required"),
    clientSecret: z.string().min(1, "clientSecret is required"),
    redirectUri: z.string().min(1, "redirectUri is required"),
    scopes: z.array(z.string()).optional(),
    requireVerifiedEmail: z.boolean().optional(),
    observability: z.custom<AuthObservability>().optional(),
  })
  .passthrough();

const tokenResponseSchema = z
  .object({
    access_token: z.string(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  })
  .passthrough();

const profileSchema = z
  .object({
    id: z.string(),
    email: z.string().optional(),
    // Google's /oauth2/v2/userinfo marks whether it verified the address.
    verified_email: z.union([z.boolean(), z.string()]).optional(),
    name: z.string().optional(),
    picture: z.string().optional(),
  })
  .passthrough();

/**
 * Creates a Google OAuth 2.0 provider.
 *
 * @example
 * ```ts
 * const google = createGoogleProvider({
 *   clientId: process.env.GOOGLE_CLIENT_ID!,
 *   clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
 *   redirectUri: "http://localhost:3000/auth/google/callback",
 * });
 * ```
 */
export function createGoogleProvider(config: GoogleConfig): AuthProvider {
  parseAuthConfig("createGoogleProvider", GoogleConfigSchema, config);
  const requireVerifiedEmail = config.requireVerifiedEmail ?? true;
  return {
    name: "google",

    /**
     * Generate the Google login URL. `state` and the PKCE `codeChallenge`
     * are required.
     */
    getAuthUrl: ({ state, codeChallenge }: AuthorizeParams): string => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: config.scopes?.join(" ") ?? "email profile",
        access_type: "offline",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    },

    /**
     * Exchange the authorization code for a normalized user profile.
     * Verifies `state` and requires the PKCE `codeVerifier`.
     * Wrapped with `oauth.exchange` audit logging.
     */
    exchangeCode: auditedExchange("google", config.observability, async ({
      code,
      state,
      expectedState,
      codeVerifier,
    }: ExchangeParams): Promise<OAuthProfile> => {
      verifyState(state, expectedState);
      const verifier = requireCodeVerifier(codeVerifier);

      // 1. Exchange code for a Google access token.
      const tokens = await httpJson(
        "https://oauth2.googleapis.com/token",
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
        { label: "Google token exchange" },
      );

      // 2. Fetch the user profile.
      const profile = await httpJson(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
        profileSchema,
        { label: "Google profile fetch" },
      );

      if (!profile.email) {
        throw new Error("Google OAuth error: profile has no email");
      }
      // Never trust an unverified email as identity (account-linking takeover).
      if (
        requireVerifiedEmail &&
        profile.verified_email !== true &&
        profile.verified_email !== "true"
      ) {
        throw new Error("Google OAuth error: email is not verified");
      }

      // 3. Return the normalized profile.
      return {
        providerId: profile.id,
        email: profile.email,
        name: profile.name ?? profile.email,
        picture: profile.picture,
        raw: profile,
      };
    }),
  };
}
