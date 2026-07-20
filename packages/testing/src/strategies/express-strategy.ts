import supertest, { Response } from 'supertest';
import type { TestClient, TestResponse } from '../types';

// Supertest accepts various server types (http.Server, express.App, function, etc.)
// We use 'any' here because typing the input to supertest is complex without @types/express
// and strict strict matching of supertest's expected App types.
export function createExpressClient(server: any): TestClient {
  const request = supertest(server);

  const normalize = (res: Response): TestResponse => ({
    status: res.status,
    body: res.body,
    text: res.text,
    headers: res.headers as Record<string, string | string[] | undefined>,
  });

  return {
    get: async (url, headers = {}) => {
      const req = request.get(url);
      Object.entries(headers).forEach(([k, v]) => req.set(k, v));
      return normalize(await req);
    },
    post: async (url, body = {}, headers = {}) => {
      const req = request.post(url).send(body);
      Object.entries(headers).forEach(([k, v]) => req.set(k, v));
      return normalize(await req);
    },
    put: async (url, body = {}, headers = {}) => {
      const req = request.put(url).send(body);
      Object.entries(headers).forEach(([k, v]) => req.set(k, v));
      return normalize(await req);
    },
    patch: async (url, body = {}, headers = {}) => {
      const req = request.patch(url).send(body);
      Object.entries(headers).forEach(([k, v]) => req.set(k, v));
      return normalize(await req);
    },
    delete: async (url, headers = {}) => {
      const req = request.delete(url);
      Object.entries(headers).forEach(([k, v]) => req.set(k, v));
      return normalize(await req);
    },
  };
}