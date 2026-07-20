// ──────────────────────────────────────────────────────────────────────────
// Shared OAuth-exchange observability wrapper (Sprint 6, T6.1).
//
// Wraps a provider's `exchangeCode` so every authorization-code exchange emits a
// secret-free `oauth.exchange` audit event (success or failure). Never logs the
// code, tokens, client secret, or profile payload — only the provider name, the
// resulting subject id on success, and a non-secret failure reason (the typed
// error code) on failure.
// ──────────────────────────────────────────────────────────────────────────

import { isAuthError } from "../errors";
import { createAuditor, type AuthObservability } from "../observability";
import type { ExchangeParams, OAuthProfile } from "./types";

/** Wraps `exchange` with `oauth.exchange` audit + metrics for `provider`. */
export function auditedExchange(
  provider: string,
  observability: AuthObservability | undefined,
  exchange: (params: ExchangeParams) => Promise<OAuthProfile>,
): (params: ExchangeParams) => Promise<OAuthProfile> {
  const audit = createAuditor(observability);
  return async (params: ExchangeParams): Promise<OAuthProfile> => {
    try {
      const profile = await exchange(params);
      audit.record({
        type: "oauth.exchange",
        outcome: "success",
        provider,
        userId: profile.providerId,
      });
      return profile;
    } catch (error: unknown) {
      const reason = isAuthError(error) ? error.code : "oauth_exchange_failed";
      audit.record({ type: "oauth.exchange", outcome: "failure", provider, reason });
      throw error;
    }
  };
}
