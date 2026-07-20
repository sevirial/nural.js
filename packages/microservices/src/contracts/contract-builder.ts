import { z } from "zod";

export interface MicroserviceContract<
  P extends z.ZodTypeAny,
  R extends z.ZodTypeAny | z.ZodVoid = z.ZodVoid
> {
  readonly topic: string;
  readonly request: P;
  readonly response: R;
}

/**
 * Defines a strictly typed network boundary contract.
 * Shared between the emitting Client and the consuming Microservice.
 */
export const defineContract = <
  P extends z.ZodTypeAny,
  R extends z.ZodTypeAny | z.ZodVoid = z.ZodVoid
>(config: {
  topic: string;
  request: P;
  response: R;
}): MicroserviceContract<P, R> => {
  return config;
};
