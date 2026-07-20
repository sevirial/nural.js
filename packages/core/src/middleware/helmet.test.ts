/**
 * Helmet Middleware Tests
 */

import { describe, it, expect } from "vitest";
import { getSecurityHeaders } from "./helmet";
import { DEFAULT_HELMET_CONFIG } from "../types/middleware";

describe("Helmet Middleware", () => {
  describe("getSecurityHeaders", () => {
    it("should return default security headers", () => {
      const headers = getSecurityHeaders(DEFAULT_HELMET_CONFIG);

      expect(headers["X-DNS-Prefetch-Control"]).toBe("off");
      expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Referrer-Policy"]).toBe("no-referrer");
      expect(headers["X-Permitted-Cross-Domain-Policies"]).toBe("none");
    });

    it("should include HSTS header with correct format", () => {
      const headers = getSecurityHeaders(DEFAULT_HELMET_CONFIG);

      expect(headers["Strict-Transport-Security"]).toContain("max-age=");
      expect(headers["Strict-Transport-Security"]).toContain(
        "includeSubDomains",
      );
    });

    it("should disable XSS filter by default", () => {
      const headers = getSecurityHeaders(DEFAULT_HELMET_CONFIG);
      expect(headers["X-XSS-Protection"]).toBe("0");
    });

    it("should enable XSS filter when configured", () => {
      const config = {
        ...DEFAULT_HELMET_CONFIG,
        xssFilter: true,
      };

      const headers = getSecurityHeaders(config);
      expect(headers["X-XSS-Protection"]).toBe("1; mode=block");
    });

    it("should include CSP when configured", () => {
      const config = {
        ...DEFAULT_HELMET_CONFIG,
        contentSecurityPolicy: {
          directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "trusted.com"],
          },
        },
      };

      const headers = getSecurityHeaders(config);
      expect(headers["Content-Security-Policy"]).toContain(
        "default-src 'self'",
      );
      expect(headers["Content-Security-Policy"]).toContain(
        "script-src 'self' trusted.com",
      );
    });

    it("should set Cross-Origin policies", () => {
      const headers = getSecurityHeaders(DEFAULT_HELMET_CONFIG);

      expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    });
  });
});
