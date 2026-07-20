/**
 * Normalized profile returned by all OAuth providers.
 * Every provider (Google, GitHub, OIDC, etc.) maps its native profile to this shape.
 */
export interface OAuthProfile {
  providerId: string;
  email: string;
  name: string;
  picture?: string;
  raw: Record<string, unknown>;
}

/**
 * Parameters for building a provider's authorize URL.
 *
 * `state` (anti-CSRF) and `codeChallenge` (PKCE S256) are both **required** —
 * the caller generates them (see `createState` / `createPkcePair`), stashes the
 * matching `{ state, codeVerifier, nonce }` in the user's session, and hands
 * them back to `exchangeCode` on the callback. `nonce` is OIDC-only (bound into
 * the id_token) and ignored by plain OAuth providers.
 */
export interface AuthorizeParams {
  state: string;
  codeChallenge: string;
  nonce?: string;
}

/**
 * Parameters for exchanging an authorization code for a profile.
 *
 * The provider verifies `state` against `expectedState` (CSRF/mix-up defence)
 * and sends `codeVerifier` to the token endpoint (PKCE). `expectedNonce` is the
 * OIDC nonce originally issued; the OIDC provider requires the id_token `nonce`
 * to equal it.
 */
export interface ExchangeParams {
  /** Authorization code from the provider redirect. */
  code: string;
  /** `state` returned on the callback (from the redirect query string). */
  state: string;
  /** `state` originally issued (from the user's session/cookie). */
  expectedState: string;
  /** PKCE code verifier matching the challenge sent to `getAuthUrl`. Required. */
  codeVerifier: string;
  /** OIDC only: nonce originally issued; must equal the id_token `nonce`. */
  expectedNonce?: string;
}

/**
 * Interface that all OAuth providers must satisfy.
 *
 * `getAuthUrl` returns `string | Promise<string>` to support both
 * static URL construction (Google, GitHub) and async discovery (OIDC).
 * Callers should always `await` the result for uniform handling.
 */
export interface AuthProvider {
  name: string;
  getAuthUrl(params: AuthorizeParams): string | Promise<string>;
  exchangeCode(params: ExchangeParams): Promise<OAuthProfile>;
}
