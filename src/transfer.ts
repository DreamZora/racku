/**
 * Transfer lists: the `ArrayBuffer`s that a call or a result moves to the receiving thread
 * instead of copying them.
 *
 * Both the Worker host and the backplane take a call's buffers when the call is made, so the
 * caller loses them whatever the call's outcome; only an invalid list leaves them attached.
 *
 * @decision .agents/decisions/261116_213839-transfer-and-shared-buffers.md#transfer
 */
import { RackError } from "./errors.ts";

/**
 * Reports why a value cannot be transferred.
 *
 * @param value An entry of a transfer list.
 * @returns A short reason, or `undefined` when the value is an attached, non-shared `ArrayBuffer`.
 */
export function untransferable(value: unknown): string | undefined {
  if (value instanceof SharedArrayBuffer) {
    return "a SharedArrayBuffer is shared, not transferred; leave it out of the list";
  }
  if (!(value instanceof ArrayBuffer)) return "only ArrayBuffers can be transferred";
  if (value.detached) return "the ArrayBuffer is already detached";
  return undefined;
}

/**
 * Checks the `transfer` option of a call and takes a copy of it.
 *
 * @param list The option as the caller passed it.
 * @param where `<need>.<method>` or `<address>.<method>`, for the error message.
 * @returns The buffers the call now owns, or `undefined` when there are none.
 * @throws RackError `RACK_INVALID_INPUT` when the list is not an array of distinct, attached,
 *   non-shared `ArrayBuffer`s; no buffer is detached then.
 */
export function transferList(list: unknown, where: string): ArrayBuffer[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) {
    throw new RackError(
      "RACK_INVALID_INPUT",
      `${where}: transfer must be an array of ArrayBuffers`,
    );
  }
  if (list.length === 0) return undefined;
  const seen = new Set<unknown>();
  for (const [index, entry] of list.entries()) {
    const reason = seen.has(entry) ? "the ArrayBuffer is listed twice" : untransferable(entry);
    if (reason !== undefined) {
      throw new RackError("RACK_INVALID_INPUT", `${where}: transfer[${index}]: ${reason}`);
    }
    seen.add(entry);
  }
  return [...list] as ArrayBuffer[];
}

/**
 * Detaches every buffer in `buffers` that is still attached, as if it had been transferred.
 *
 * @param buffers Buffers a call or a result took; ones already moved are skipped.
 */
export function detach(buffers: readonly ArrayBuffer[]): void {
  const attached = buffers.filter((buffer) => !buffer.detached);
  // Transferring into a clone that is thrown away detaches the buffers without copying them.
  if (attached.length > 0) structuredClone(undefined, { transfer: attached });
}

/**
 * Clones a value while moving `buffers` into the clone, for a call that waits in a queue.
 *
 * @param value The input of the call.
 * @param buffers The buffers the call owns; they are detached once this returns.
 * @returns The clone and the moved buffers, which the clone refers to.
 * @throws DataCloneError when `value` cannot be cloned; no buffer is detached then.
 */
export function moveInto<T>(
  value: T,
  buffers: ArrayBuffer[],
): { value: T; buffers: ArrayBuffer[] } {
  return structuredClone({ value, buffers }, { transfer: buffers });
}
