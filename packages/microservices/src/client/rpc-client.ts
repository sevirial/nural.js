import { z } from "zod";
import { MicroserviceContract } from "../contracts/contract-builder";
import { ClientTransport, SendOptions } from "../transports/transport.interface";
import { RpcUnsupportedError, RpcRemoteError } from "../errors";
import { isRpcEnvelope } from "../rpc-envelope";
import { IDEMPOTENCY_HEADER } from "../server/rpc-context";
import { NOOP_TELEMETRY, Telemetry, TELEMETRY_NAMES } from "../telemetry";

export class RpcClient {
  constructor(
    private readonly transport: ClientTransport,
    private readonly telemetry: Telemetry = NOOP_TELEMETRY,
  ) {}

  public async connect(): Promise<void> {
    await this.transport.connect();
  }

  /**
   * Fire and Forget event emission.
   * TypeScript enforces `data` strictly matches the Contract's Zod Schema.
   */
  public async emit<C extends MicroserviceContract<z.ZodTypeAny, z.ZodTypeAny>>(
    contract: C,
    data: z.infer<C["request"]>
  ): Promise<void> {
    // Validate outgoing data just in case
    const validData = contract.request.parse(data);
    await this.transport.emit(contract.topic, validData);
  }

  /**
   * Request-Response RPC call.
   * Enforces input types and returns the strongly-typed Response schema.
   */
  public async send<C extends MicroserviceContract<z.ZodTypeAny, z.ZodTypeAny>>(
    contract: C,
    data: z.infer<C["request"]>,
    options?: SendOptions
  ): Promise<C["response"] extends z.ZodTypeAny ? z.infer<C["response"]> : void> {
    // Fail fast at the call site if the transport can't do RPC (e.g. Kafka),
    // before any validation or network work — a typed, distinguishable error.
    if (!this.transport.capabilities.supportsRpc) {
      throw new RpcUnsupportedError(
        `RPC 'send' for '${contract.topic}' is not supported by this transport (supportsRpc: false). Use 'emit' for event streaming.`,
      );
    }
    if (!contract.response) {
      throw new Error(`Contract for ${contract.topic} does not define a response schema.`);
    }

    const validData = contract.request.parse(data);

    // Attach the idempotency key (if any) as a wire header so the server can
    // dedup a redelivery (Sprint 9).
    const sendOptions = this.withIdempotency(options);

    // Telemetry (Sprint 10): a `client`-kind span both times the call and injects
    // trace context into `headers` so it propagates on the wire (T10.3) to the
    // server's `RpcContext.headers`. No-op when telemetry is not configured.
    const attrs = { topic: contract.topic };
    const headers = { ...(sendOptions?.headers ?? {}) };
    const span = this.telemetry.startSpan(TELEMETRY_NAMES.clientSpan, "client", headers, attrs);
    this.telemetry.recordInFlight(TELEMETRY_NAMES.clientInFlight, 1, attrs);
    const startedAt = Date.now();
    try {
      const rawResponse = await this.transport.send(contract.topic, validData, {
        ...sendOptions,
        headers,
      });

      // Decode the reply envelope (Sprint 9). A remote failure crosses the wire as
      // an error envelope and is rehydrated into a typed `RpcRemoteError` — so a
      // failed RPC rejects with a distinguishable error instead of timing out.
      const payload = this.decodeEnvelope(rawResponse);

      // Validate incoming response. Zod 4 types `.parse()` on a generic schema as
      // `unknown`; narrow it back to the contract's declared response type.
      return contract.response.parse(payload) as C["response"] extends z.ZodTypeAny
        ? z.infer<C["response"]>
        : void;
    } catch (err) {
      span.setError(err);
      this.telemetry.incrementCounter(TELEMETRY_NAMES.clientErrors, attrs);
      throw err;
    } finally {
      this.telemetry.recordLatency(TELEMETRY_NAMES.clientLatency, Date.now() - startedAt, attrs);
      this.telemetry.recordInFlight(TELEMETRY_NAMES.clientInFlight, -1, attrs);
      span.end();
    }
  }

  /** Merges the optional `idempotencyKey` into the wire headers for this call. */
  private withIdempotency(options?: SendOptions): SendOptions | undefined {
    if (!options?.idempotencyKey) return options;
    return {
      ...options,
      headers: { ...(options.headers ?? {}), [IDEMPOTENCY_HEADER]: options.idempotencyKey },
    };
  }

  /**
   * Unwraps an RPC reply envelope. Throws {@link RpcRemoteError} for an error
   * envelope; returns the payload for a success envelope. A non-enveloped body
   * (e.g. a custom transport that does not wrap) passes through unchanged.
   */
  private decodeEnvelope(raw: unknown): unknown {
    if (isRpcEnvelope(raw)) {
      if (raw.ok) return raw.data;
      throw new RpcRemoteError(raw.error);
    }
    return raw;
  }

  public async close(): Promise<void> {
    await this.transport.close();
  }
}

export function createRpcClient(config: {
  transport: ClientTransport;
  /** Optional telemetry sink (client spans/metrics + trace injection). No-op by default. */
  telemetry?: Telemetry;
}): RpcClient {
  return new RpcClient(config.transport, config.telemetry);
}
