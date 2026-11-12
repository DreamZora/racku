/**
 * Connectors: named, versioned contracts made of RPC methods and events.
 *
 * @decision .agents/decisions/261112_043034-device-api.md#connectors
 */
import { RackError } from "./errors.ts";
import { isStandardSchema, type StandardSchemaV1 } from "./schema.ts";

/** An RPC member: `input` is validated by the provider before the handler runs. */
export interface RpcSpec<
  I extends StandardSchemaV1 = StandardSchemaV1,
  O extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly kind: "rpc";
  readonly input: I;
  readonly output: O;
}

/** An event member: payloads are validated by the publisher before delivery. */
export interface EventSpec<P extends StandardSchemaV1 = StandardSchemaV1> {
  readonly kind: "event";
  readonly payload: P;
}

/** A connector member. */
export type MemberSpec = RpcSpec | EventSpec;

/** Members of a connector, keyed by member name. */
export type Members = Record<string, MemberSpec>;

/** A connector definition. */
export interface Connector<M extends Members = Members> {
  /** Connector id, `<name>/v<major>`. */
  readonly id: string;
  readonly members: M;
}

/** Serializable connector description reported in FRU data. */
export interface ConnectorInfo {
  id: string;
  members: Record<string, "rpc" | "event">;
}

const CONNECTOR_ID = /^[a-z0-9][a-z0-9.-]*\/v\d+$/;
const MEMBER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Declares an RPC member.
 *
 * @param input Schema for the call input; the provider validates it.
 * @param output Schema for the result; the provider validates it before replying.
 * @returns The RPC member spec.
 */
export function rpc<I extends StandardSchemaV1, O extends StandardSchemaV1>(
  input: I,
  output: O,
): RpcSpec<I, O> {
  if (!isStandardSchema(input) || !isStandardSchema(output)) {
    throw new RackError("RACK_MANIFEST", "rpc() requires Standard Schema input and output schemas");
  }
  return { kind: "rpc", input, output };
}

/**
 * Declares an event member.
 *
 * @param payload Schema for the event payload; the publisher validates it.
 * @returns The event member spec.
 */
export function event<P extends StandardSchemaV1>(payload: P): EventSpec<P> {
  if (!isStandardSchema(payload)) {
    throw new RackError("RACK_MANIFEST", "event() requires a Standard Schema payload schema");
  }
  return { kind: "event", payload };
}

/**
 * Declares a connector.
 *
 * @param id `<name>/v<major>`, for example `kv/v1`; bump the major for incompatible changes.
 * @param members RPC methods and events keyed by a JavaScript identifier.
 * @returns The connector definition.
 * @throws RackError `RACK_MANIFEST` when the id or a member name is malformed.
 */
export function connector<const M extends Members>(id: string, members: M): Connector<M> {
  if (!CONNECTOR_ID.test(id)) {
    throw new RackError("RACK_MANIFEST", `connector id "${id}" must look like "<name>/v<major>"`);
  }
  for (const name of Object.keys(members)) {
    if (!MEMBER_NAME.test(name)) {
      throw new RackError(
        "RACK_MANIFEST",
        `connector ${id}: member "${name}" is not a valid identifier`,
      );
    }
  }
  return { id, members };
}

/**
 * Describes a connector for FRU data and compatibility checks.
 *
 * @param c The connector.
 * @returns Its id and member kinds.
 */
export function describeConnector(c: Connector): ConnectorInfo {
  const members: Record<string, "rpc" | "event"> = {};
  for (const [name, spec] of Object.entries(c.members)) members[name] = spec.kind;
  return { id: c.id, members };
}

/** Input type of an RPC member. */
export type RpcInput<S> =
  S extends RpcSpec<infer I, StandardSchemaV1> ? StandardSchemaV1.InferInput<I> : never;
/** Parsed input type of an RPC member, as seen by the provider. */
export type RpcParsedInput<S> =
  S extends RpcSpec<infer I, StandardSchemaV1> ? StandardSchemaV1.InferOutput<I> : never;
/** Result type of an RPC member, as seen by the caller. */
export type RpcOutput<S> =
  S extends RpcSpec<StandardSchemaV1, infer O> ? StandardSchemaV1.InferOutput<O> : never;
/** Result type an RPC handler returns before output validation. */
export type RpcReturn<S> =
  S extends RpcSpec<StandardSchemaV1, infer O> ? StandardSchemaV1.InferInput<O> : never;
/** Payload type of an event member, as seen by subscribers. */
export type EventPayload<S> =
  S extends EventSpec<infer P> ? StandardSchemaV1.InferOutput<P> : never;
/** Payload type a publisher passes before validation. */
export type EventInput<S> = S extends EventSpec<infer P> ? StandardSchemaV1.InferInput<P> : never;

/** Names of the RPC members of a connector. */
export type RpcNames<M extends Members> = {
  [K in keyof M]: M[K] extends RpcSpec ? K : never;
}[keyof M];
/** Names of the event members of a connector. */
export type EventNames<M extends Members> = {
  [K in keyof M]: M[K] extends EventSpec ? K : never;
}[keyof M];
