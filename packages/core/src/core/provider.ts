/**
 * Providers
 *
 * A functional way to define infrastructure services (DB, Redis, message
 * brokers, …) with lifecycle management. A provider owns a single client
 * instance: `setup()` builds it on registration, `teardown()` disposes it on
 * graceful shutdown. Zero classes, zero decorators — just a factory that
 * returns a small descriptor the app can `registerProvider()`.
 */

import { Logger } from "./logger";

const logger = new Logger("Provider");

/**
 * Author-facing provider definition.
 */
export interface ProviderConfig<T> {
  /** Unique provider name (used in logs and diagnostics). */
  name: string;
  /**
   * Called once when the provider is registered. Return the initialized
   * client/connection instance.
   */
  setup: () => Promise<T> | T;
  /**
   * Called on graceful shutdown to dispose the instance created by `setup`.
   */
  teardown?: (instance: T) => Promise<void> | void;
}

/**
 * Runtime provider descriptor produced by {@link defineProvider}.
 */
export interface NuraljsProvider<T> {
  name: string;
  /** Access the initialized instance (throws if accessed before `init`). */
  getInstance: () => T;
  /** Initialize the instance by running `setup`. */
  init: () => Promise<void>;
  /** Dispose the instance by running `teardown` (no-op if never initialized). */
  destroy: () => Promise<void>;
}

/**
 * Define a lifecycle-managed provider.
 *
 * @example
 * ```typescript
 * export const redisProvider = defineProvider({
 *   name: "Redis",
 *   setup: async () => {
 *     const client = new Redis(process.env.REDIS_URL);
 *     return client;
 *   },
 *   teardown: async (client) => client.quit(),
 * });
 *
 * // In main.ts bootstrap():
 * await app.registerProvider(redisProvider);
 * ```
 */
export function defineProvider<T>(config: ProviderConfig<T>): NuraljsProvider<T> {
  let instance: T | null = null;
  return {
    name: config.name,
    getInstance: () => {
      if (instance === null) {
        throw new Error(`Provider '${config.name}' not initialized.`);
      }
      return instance;
    },
    init: async () => {
      logger.log(`🔌 [${config.name}] Connecting...`);
      instance = await config.setup();
    },
    destroy: async () => {
      if (instance !== null && config.teardown) {
        logger.log(`🔌 [${config.name}] Disconnecting...`);
        await config.teardown(instance);
        instance = null;
      }
    },
  };
}
