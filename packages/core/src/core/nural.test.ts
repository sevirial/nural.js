/**
 * Nuraljs router — prefix/path joining.
 *
 * `joinPaths` runs at registration for every module route. It must tolerate an
 * empty or omitted `path` (mount at the module prefix root) instead of throwing
 * a `TypeError` and taking the server down at startup — the crash reported when
 * a route declared `path: ""`.
 */

import { describe, it, expect } from "vitest";
import { Nuraljs } from "./nural";
import type { AnyRouteConfig } from "../types/route";

const route = (path: string): AnyRouteConfig =>
  ({ method: "GET", path, handler: () => ({ ok: true }) }) as AnyRouteConfig;

/** Final joined paths of a module's routes, in registration order. */
const registeredPaths = (
  prefix: string | undefined,
  paths: Array<string | undefined>,
): string[] => {
  const app = new Nuraljs({ framework: "fastify", logErrors: false } as never);
  app.registerModule({
    prefix,
    routes: paths.map((p) => route(p as string)),
  });
  return app.getRoutes().map((r) => r.path);
};

describe("Nuraljs — prefix/path joining", () => {
  it("mounts an empty path at the module prefix root without crashing", () => {
    expect(registeredPaths("/carts", [""])).toEqual(["/carts"]);
  });

  it("treats a lone slash the same as an empty path (no trailing slash)", () => {
    expect(registeredPaths("/carts", ["/"])).toEqual(["/carts"]);
  });

  it("joins a normal path onto the prefix", () => {
    expect(registeredPaths("/carts", ["/:id"])).toEqual(["/carts/:id"]);
  });

  it("falls back to '/' when both prefix and path are empty", () => {
    expect(registeredPaths("", [""])).toEqual(["/"]);
    expect(registeredPaths(undefined, [undefined])).toEqual(["/"]);
  });

  it("handles a mix of root and nested paths under one prefix", () => {
    expect(registeredPaths("/carts", ["", "/:id", "items"])).toEqual([
      "/carts",
      "/carts/:id",
      "/carts/items",
    ]);
  });
});
