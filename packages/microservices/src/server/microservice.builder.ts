import { z } from "zod";
import { MicroserviceContract } from "../contracts/contract-builder";
import { RawMessageHandler, ServerTransport } from "../transports/transport.interface";
import { RpcContext, IDEMPOTENCY_HEADER } from "./rpc-context";
import {
  RpcEnvelope,
  successEnvelope,
  errorEnvelope,
  toErrorEnvelope,
} from "../rpc-envelope";
import { InvalidMessageError } from "../errors";
import { IdempotencyStore } from "../idempotency";
import { NOOP_TELEMETRY, Telemetry, TELEMETRY_NAMES } from "../telemetry";
import { Logger } from "@nuraljs/core";

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class MicroserviceBuilder<Services extends Record<string, unknown> = Record<string, unknown>> {
  private handlers = new Map<string, RawMessageHandler>();
  private logger = new Logger("MicroserviceBuilder");

  constructor(
    private readonly transport: ServerTransport,
    private readonly services: Services = {} as Services,
    private readonly idempotency?: IdempotencyStore,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
    /**
     * Forward a thrown handler's raw `message` to the RPC caller. Off by default
     * — an arbitrary throw can carry secrets/internal detail, so callers receive
     * a stable `code` + a generic message unless the error opts in as safe. Turn
     * on only when every handler's error messages are known to be caller-safe.
     */
    private readonly exposeErrorMessages: boolean = false,
  ) {}

  /**
   * Registers a strongly-typed event handler based on a Contract.
   *
   * Reliability (Sprint 9): the handler invocation is fully guarded. A thrown
   * handler, an invalid request, or a contract-invalid response never vanishes:
   * for an RPC call (`ctx.replyTo` set) a typed **error envelope** is sent back
   * so the caller rejects instead of timing out; for a fire-and-forget message
   * the failure is re-thrown so the transport can dead-letter it (permanent
   * failures via {@link InvalidMessageError} skip straight to the DLQ).
   */
  public handler<C extends MicroserviceContract<z.ZodTypeAny, z.ZodTypeAny | z.ZodVoid>>(
    contract: C,
    handlerFn: (
      ctx: { request: z.infer<C["request"]>; context: RpcContext } & Services
    ) => C["response"] extends z.ZodTypeAny ? Promise<z.infer<C["response"]>> : Promise<void> | void
  ): this {
    const rawHandler: RawMessageHandler = async (data, ctx) => {
      const isRpc = Boolean(ctx.replyTo && this.transport.reply);
      // Namespace the client-supplied idempotency key by topic so a key reused
      // (or deliberately collided) across contracts can never replay another
      // topic's cached reply. Keys are otherwise attacker-influenced wire input.
      const rawIdemKey = ctx.headers?.[IDEMPOTENCY_HEADER];
      const idemKey = rawIdemKey ? `${contract.topic}:${rawIdemKey}` : undefined;

      // Telemetry (Sprint 10): a `server`-kind span extracts the parent trace
      // context from the incoming wire headers (`ctx.headers`, T10.3) and times
      // the handle; latency/in-flight/error metrics are recorded around it. All
      // no-ops when telemetry is not configured.
      const attrs = { topic: contract.topic, transport: ctx.protocol };
      const span = this.telemetry.startSpan(TELEMETRY_NAMES.serverSpan, "server", ctx.headers ?? {}, attrs);
      this.telemetry.recordInFlight(TELEMETRY_NAMES.serverInFlight, 1, attrs);
      const startedAt = Date.now();

      const fail = (reason: string, err?: unknown): void => {
        span.setError(err ?? reason);
        this.telemetry.incrementCounter(TELEMETRY_NAMES.serverErrors, { ...attrs, reason });
      };

      try {
        // Idempotency: replay a previously-recorded outcome for a duplicate
        // delivery without re-running the handler.
        if (this.idempotency && idemKey) {
          const cached = await this.idempotency.get(idemKey);
          if (cached) {
            if (isRpc) await this.reply(ctx, cached, idemKey);
            return;
          }
        }

        // 1) Validate the incoming request against the contract.
        const parsed = contract.request.safeParse(data);
        if (!parsed.success) {
          fail("invalid_request", parsed.error);
          this.logger.error(`Invalid request for topic ${contract.topic}: ${parsed.error.message}`);
          if (isRpc) {
            await this.reply(
              ctx,
              errorEnvelope("invalid_request", "Request failed contract validation"),
              idemKey,
            );
            return;
          }
          // Fire-and-forget: a schema-invalid message is a permanent failure — a
          // retry would fail identically, so it is dead-lettered immediately
          // (replaces the old silent drop).
          throw new InvalidMessageError("invalid_request", `Invalid request for ${contract.topic}`);
        }

        // 2) Invoke the handler under try/catch (replaces the unguarded call).
        let response: unknown;
        try {
          response = await handlerFn({
            request: parsed.data as z.infer<C["request"]>,
            context: ctx,
            ...this.services,
          });
        } catch (err) {
          fail("handler_error", err);
          this.logger.error(`Handler for ${contract.topic} threw: ${errMessage(err)}`);
          if (isRpc) {
            await this.reply(
              ctx,
              toErrorEnvelope(err, { exposeMessage: this.exposeErrorMessages }),
              idemKey,
            );
            return;
          }
          // Fire-and-forget: re-throw so the transport applies retry/DLQ (a
          // transient failure may succeed on redelivery).
          throw err;
        }

        // 3) Fire-and-forget path: nothing to reply/validate; record the outcome.
        if (!isRpc) {
          if (this.idempotency && idemKey) {
            await this.idempotency.set(idemKey, successEnvelope(response ?? null));
          }
          return response;
        }

        // 4) Server-side response validation before reply (Sprint 9, T9.4):
        // the server refuses to put a contract-invalid response on the wire, and
        // the validated value is what is sent (unlisted fields stripped — no leaks).
        const validated = contract.response.safeParse(response);
        if (!validated.success) {
          fail("invalid_response", validated.error);
          this.logger.error(
            `Response for topic ${contract.topic} failed contract validation: ${validated.error.message}`,
          );
          await this.reply(
            ctx,
            errorEnvelope("invalid_response", "Handler produced a contract-invalid response"),
            idemKey,
          );
          return;
        }

        await this.reply(ctx, successEnvelope(validated.data), idemKey);
        return response;
      } finally {
        this.telemetry.recordLatency(TELEMETRY_NAMES.serverLatency, Date.now() - startedAt, attrs);
        this.telemetry.recordInFlight(TELEMETRY_NAMES.serverInFlight, -1, attrs);
        span.end();
      }
    };

    this.handlers.set(contract.topic, rawHandler);
    return this;
  }

  /** Records the outcome (for idempotent replay) then dispatches the RPC reply. */
  private async reply(ctx: RpcContext, envelope: RpcEnvelope, idemKey?: string): Promise<void> {
    if (this.idempotency && idemKey) await this.idempotency.set(idemKey, envelope);
    if (ctx.replyTo && this.transport.reply) await this.transport.reply(ctx, envelope);
  }

  /**
   * Starts the Microservice worker.
   */
  public async listen(): Promise<void> {
    await this.transport.listen(this.handlers);
    this.logger.log(`Microservice Worker listening on ${this.handlers.size} topics.`);
  }

  public async close(): Promise<void> {
    await this.transport.close();
  }
}

export function createMicroservice<Services extends Record<string, unknown> = Record<string, unknown>>(config: {
  transport: ServerTransport;
  inject?: Services;
  /** Optional idempotency store — dedups at-least-once redeliveries by key (Sprint 9). */
  idempotency?: IdempotencyStore;
  /** Optional telemetry sink (server spans/metrics + trace extraction). No-op by default (Sprint 10). */
  telemetry?: Telemetry;
  /**
   * Forward a thrown handler's raw `message` to the RPC caller. Off by default
   * (callers get a stable `code` + generic message). Enable only when every
   * handler's error messages are known to be free of secrets/internal detail.
   */
  exposeErrorMessages?: boolean;
}): MicroserviceBuilder<Services> {
  return new MicroserviceBuilder(
    config.transport,
    config.inject,
    config.idempotency,
    config.telemetry,
    config.exposeErrorMessages ?? false,
  );
}
