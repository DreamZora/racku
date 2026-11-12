/**
 * Structured errors that survive the backplane.
 *
 * `Error` loses custom properties under structured clone, so errors cross threads as plain
 * {@link WireError} objects and are revived into {@link RackError} on arrival.
 *
 * @decision .agents/decisions/261112_043035-backplane-protocol.md#error-model
 */

/** Framework error codes. Device-defined codes must not start with `RACK_`. */
export type RackErrorCode =
  | "RACK_TIMEOUT"
  | "RACK_CANCELLED"
  | "RACK_LINK_DOWN"
  | "RACK_NO_ROUTE"
  | "RACK_INVALID_INPUT"
  | "RACK_INVALID_OUTPUT"
  | "RACK_INVALID_CONFIG"
  | "RACK_DEVICE_FAULT"
  | "RACK_MANIFEST"
  | "RACK_SWAP_REJECTED"
  | "RACK_HOOK_FAILED";

/** Plain-object form of an error as it travels between threads. */
export interface WireError {
  code: string;
  message: string;
  data?: unknown;
}

/**
 * An error with a stable code and optional structured-cloneable data.
 *
 * Devices throw `RackError` to give callers a code they can branch on; any other thrown
 * value reaches the caller as `RACK_DEVICE_FAULT`.
 */
export class RackError extends Error {
  /** Stable machine-readable code, `RACK_*` for framework errors. */
  readonly code: string;
  /** Optional structured-cloneable details. */
  readonly data: unknown;

  /**
   * @param code Error code; device codes must not start with `RACK_`.
   * @param message Human-readable message.
   * @param data Optional structured-cloneable details; dropped at the backplane if not cloneable.
   */
  constructor(code: RackErrorCode | (string & {}), message: string, data?: unknown) {
    super(message);
    this.name = "RackError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Reports whether a value is a {@link RackError} instance.
 *
 * Errors from another thread arrive as {@link WireError} objects; revive them with
 * {@link fromWireError} before testing them.
 *
 * @param value Any caught value.
 * @returns `true` when the value is a `RackError`.
 */
export function isRackError(value: unknown): value is RackError {
  return value instanceof RackError;
}

/**
 * Converts any thrown value into its wire form.
 *
 * `RackError`s keep their code and data; anything else becomes `RACK_DEVICE_FAULT` with
 * the original message. Data that cannot be structured-cloned is dropped.
 *
 * @param error The caught value.
 * @returns A structured-cloneable error object.
 */
export function toWireError(error: unknown): WireError {
  if (error instanceof RackError) {
    const wire: WireError = { code: error.code, message: error.message };
    if (error.data !== undefined && isCloneable(error.data)) wire.data = error.data;
    return wire;
  }
  const message = error instanceof Error ? error.message : describeThrown(error);
  return { code: "RACK_DEVICE_FAULT", message };
}

function describeThrown(value: unknown): string {
  try {
    return String(value);
  } catch {
    // `String()` throws for values without a primitive conversion, such as
    // `Object.create(null)`; the `[object Type]` tag keeps the conversion total.
    return Object.prototype.toString.call(value);
  }
}

/**
 * Revives a wire error into a {@link RackError}.
 *
 * @param wire The plain error object received from another thread.
 * @returns A `RackError` with the same code, message, and data.
 */
export function fromWireError(wire: WireError): RackError {
  return new RackError(wire.code, wire.message, wire.data);
}

/**
 * Reports whether a value survives `structuredClone`.
 *
 * @param value The value to test.
 * @returns `true` when cloning does not throw.
 */
export function isCloneable(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    // DataCloneError: the value holds functions, symbols, or other uncloneable parts.
    return false;
  }
}
