import type { Nuraljs } from '@nuraljs/core';
import type { TestClient, NuraljsInternals } from './types';
import { createExpressClient } from './strategies/express-strategy';
import { createFastifyClient } from './strategies/fastify-strategy';
import type { FastifyInstance } from 'fastify';

/**
 * Creates a universal test client for Nuraljs applications.
 * Works seamlessly with both Express and Fastify.
 * @param app - The initialized Nuraljs application instance
 */
export function createTestClient(app: Nuraljs): TestClient {
  // We access internal properties via strict interface casting
  const internals = app as unknown as NuraljsInternals;
  
  if (internals.isExpress) {
    // For Express, we need the raw server/app
    // Ensure app.server is initialized (even if not listening)
    const server = internals.adapter.server; 
    return createExpressClient(server);
  } else {
    return createFastifyClient(internals.adapter.app as FastifyInstance);
  }
}

export type { TestClient, TestResponse } from './types';