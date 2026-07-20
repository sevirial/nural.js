/**
 * Config Resolver Tests
 */

import { describe, it, expect } from "vitest";
import { resolveDocsConfig, DEFAULT_DOCS_CONFIG } from "./config";
import {
  resolveCorsConfig,
  resolveHelmetConfig,
  DEFAULT_CORS_CONFIG,
  DEFAULT_HELMET_CONFIG,
} from "./middleware";

describe("Configuration Resolvers", () => {
  describe("resolveDocsConfig", () => {
    it("should return defaults for undefined", () => {
      const config = resolveDocsConfig(undefined);
      expect(config).toEqual(DEFAULT_DOCS_CONFIG);
    });

    it("should return defaults for true", () => {
      const config = resolveDocsConfig(true);
      expect(config.enabled).toBe(true);
    });

    it("should disable docs for false", () => {
      const config = resolveDocsConfig(false);
      expect(config.enabled).toBe(false);
    });

    it("should merge partial config with defaults", () => {
      const config = resolveDocsConfig({
        title: "Custom API",
        path: "/api-docs",
      });

      expect(config.openApi.info?.title).toBe("Custom API");
      expect(config.path).toBe("/api-docs");
      expect(config.openApi.info?.version).toBe(
        DEFAULT_DOCS_CONFIG.openApi.info?.version,
      );
    });
  });

  describe("resolveCorsConfig", () => {
    it("should return null for undefined", () => {
      const config = resolveCorsConfig(undefined);
      expect(config).toBeNull();
    });

    it("should return null for false", () => {
      const config = resolveCorsConfig(false);
      expect(config).toBeNull();
    });

    it("should return defaults for true", () => {
      const config = resolveCorsConfig(true);
      expect(config).toEqual(DEFAULT_CORS_CONFIG);
    });

    it("should merge partial config with defaults", () => {
      const config = resolveCorsConfig({
        origin: "https://example.com",
        credentials: true,
      });

      expect(config!.origin).toBe("https://example.com");
      expect(config!.credentials).toBe(true);
      expect(config!.methods).toEqual(DEFAULT_CORS_CONFIG.methods);
    });
  });

  describe("resolveHelmetConfig", () => {
    it("should return null for undefined", () => {
      const config = resolveHelmetConfig(undefined);
      expect(config).toBeNull();
    });

    it("should return null for false", () => {
      const config = resolveHelmetConfig(false);
      expect(config).toBeNull();
    });

    it("should return defaults for true", () => {
      const config = resolveHelmetConfig(true);
      expect(config).toEqual(DEFAULT_HELMET_CONFIG);
    });

    it("should merge partial config with defaults", () => {
      const config = resolveHelmetConfig({
        noSniff: false,
        xssFilter: true,
      });

      expect(config!.noSniff).toBe(false);
      expect(config!.xssFilter).toBe(true);
      expect(config!.hsts).toEqual(DEFAULT_HELMET_CONFIG.hsts);
    });
  });
});
