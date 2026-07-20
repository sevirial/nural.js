/**
 * OpenAPI Compat Shim
 *
 * Pre-rewrite, Nuraljs depended on `@asteasolutions/zod-to-openapi`, whose
 * `extendZodWithOpenApi(z)` monkey-patched Zod's prototype at boot so every
 * schema gained an `.openapi(metadata)` method. That method attached OpenAPI
 * metadata later consumed when generating the spec.
 *
 * Zod 4 ships a native `.meta()` that stores the same arbitrary metadata on a
 * schema and is understood by `z.toJSONSchema`. This shim preserves the old
 * authoring API — `Schema.object({...}).openapi({...})` and the
 * `extendZodWithOpenApi` export — by forwarding `.openapi()` → `.meta()`, so
 * downstream consumers (`examples`, `cli` templates, `@nuraljs/auth`,
 * `microservices`) keep compiling without pulling in the external package.
 *
 * Runtime note: Zod 4 no longer hangs its methods off a single shared prototype
 * that sits in every schema's chain (each schema type — `ZodString`,
 * `ZodObject`, `ZodOptional`, … — has its own prototype whose parent is
 * `Object.prototype`, and instance methods like `.meta` are assigned per
 * instance). So rather than pollute `Object.prototype`, we add `.openapi` to
 * each exported `Zod*` class prototype, which every instance of that type
 * inherits.
 */

import { z } from "zod";

type OpenApiMetadata = Record<string, unknown>;

// NOTE: no `declare module "zod"` type augmentation here. Zod 4's `ZodType` is a
// variance-annotated 3-parameter generic, and a cross-module declaration merge
// onto it is rejected by TS (TS2428) and brittle across Zod patch releases. It
// is also unnecessary in this repo: no compiled `.ts` calls `.openapi()` (the
// sole authoring use is the CLI's `.ejs` scaffold template, which emits
// end-user code, not code type-checked here). The runtime method below keeps
// `.openapi()` working; the follow-up (F.1) migrates the template to `.meta()`,
// at which point this shim's `.openapi()` can be retired entirely.

/**
 * `.openapi()` implementation forwarded onto Zod schema prototypes.
 *
 * Mirrors the two call shapes the old library accepted:
 *  - `.openapi(metadata)`
 *  - `.openapi(refId, metadata)` — the `refId` becomes `meta.id`.
 *
 * Returns the metadata-tagged schema so calls stay chainable, exactly like the
 * original method.
 */
function openapi(
  this: z.ZodType,
  arg1: string | OpenApiMetadata,
  arg2?: OpenApiMetadata,
): z.ZodType {
  const metadata: OpenApiMetadata =
    typeof arg1 === "string" ? { id: arg1, ...(arg2 ?? {}) } : arg1;
  return (this as unknown as { meta(m: OpenApiMetadata): z.ZodType }).meta(
    metadata,
  );
}

let extended = false;

/**
 * Adds a chainable `.openapi()` method to every Zod schema by patching each
 * exported `Zod*` class prototype. Idempotent, and skips any prototype that
 * already exposes `.openapi` (e.g. the real library was also loaded).
 *
 * Signature kept `(zod: typeof z)` for drop-in compatibility with the old
 * `@asteasolutions/zod-to-openapi` export.
 */
export function extendZodWithOpenApi(zod: typeof z): void {
  if (extended) return;
  extended = true;

  const registry = zod as unknown as Record<string, unknown>;
  for (const key of Object.keys(registry)) {
    if (!key.startsWith("Zod")) continue;
    const ctor = registry[key] as { prototype?: object } | undefined;
    const proto = ctor?.prototype;
    if (proto && !("openapi" in proto)) {
      Object.defineProperty(proto, "openapi", {
        value: openapi,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }
}
