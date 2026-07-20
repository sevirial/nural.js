/**
 * Exception Filters
 *
 * A functional hook that runs when a route handler throws. A filter receives
 * the error plus the request/response so it can shape a custom response, or
 * re-`throw` to defer to the next filter / the built-in error handler. This is
 * the authoring helper only; it plugs into the existing error pipeline rather
 * than replacing it.
 */

/**
 * Exception filter handler signature.
 *
 * @param error   The thrown error.
 * @param req     The underlying request.
 * @param res     The underlying response (call `.status().send()` to handle).
 * @param context Route context (e.g. `handlerName`); loosely typed so filters
 *                stay portable across the Fastify/Express adapters.
 */
export type ExceptionFilterHandler<
  Err = unknown,
  Req = unknown,
  Res = unknown,
  Ctx = Record<string, unknown>,
> = (error: Err, req: Req, res: Res, context: Ctx) => Promise<void> | void;

/**
 * Define a type-safe exception filter.
 *
 * @example
 * ```typescript
 * export const authFilter = defineExceptionFilter(async (err, req, res, ctx) => {
 *   if (err instanceof UnauthorizedException) {
 *     res.status(401).send({ success: false, error: "You shall not pass!" });
 *     return;
 *   }
 *   throw err; // defer to the next filter / default handler
 * });
 * ```
 */
export function defineExceptionFilter<
  Err = unknown,
  Req = unknown,
  Res = unknown,
  Ctx = Record<string, unknown>,
>(fn: ExceptionFilterHandler<Err, Req, Res, Ctx>) {
  return fn;
}
