import type { FastifyInstance, InjectOptions, HTTPMethods } from 'fastify';
import type { TestClient, TestResponse } from '../types';

export function createFastifyClient(app: FastifyInstance): TestClient {
  const normalize = (res: Awaited<ReturnType<FastifyInstance['inject']>>): TestResponse => {
    let body = res.payload;
    try {
      body = JSON.parse(res.payload);
    } catch {
      // Keep as string if not JSON
    }
    
    return {
      status: res.statusCode,
      body,
      text: res.payload,
      headers: res.headers as Record<string, string | string[] | undefined>,
    };
  };

  const run = async (method: HTTPMethods, url: string, payload?: string | object | undefined, headers: Record<string, string> = {}) => {
    await app.ready(); // Ensure plugins are loaded
    const injectOptions: InjectOptions = {
      method: method as InjectOptions['method'],
      url,
      payload: payload as InjectOptions['payload'],
      headers
    };
    const res = await app.inject(injectOptions);
    return normalize(res);
  };

  return {
    get: (url, headers) => run('GET', url, undefined, headers),
    post: (url, body, headers) => run('POST', url, body, headers),
    put: (url, body, headers) => run('PUT', url, body, headers),
    patch: (url, body, headers) => run('PATCH', url, body, headers),
    delete: (url, headers) => run('DELETE', url, undefined, headers),
  };
}