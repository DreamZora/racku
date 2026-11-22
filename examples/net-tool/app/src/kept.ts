/**
 * The messages that the window keeps of each socket: the newest, up to a count and a size, so
 * that a peer that sends without end doesn't fill the window's memory.
 *
 * @decision .agents/decisions/261122_011655-security-review-fixes.md#net-tool-and-ci
 */

/** The most messages the window keeps per socket. */
export const KEPT = 10_000;
/** The most bytes of messages the window keeps per socket: 8 MiB. */
export const KEPT_BYTES = 8 * 1024 * 1024;

/**
 * Adds a message to a socket's list, and drops the oldest while the list holds more than
 * {@link KEPT} messages or more than {@link KEPT_BYTES} bytes.
 *
 * @param list The socket's messages, oldest first, which this changes.
 * @param message The new message.
 * @param held The bytes that the list held before.
 * @returns The bytes that the list holds now.
 */
export function keep<T extends { bytes: Uint8Array }>(list: T[], message: T, held: number): number {
  list.push(message);
  let bytes = held + message.bytes.byteLength;
  let dropped = 0;
  while (list.length - dropped > KEPT || bytes > KEPT_BYTES) {
    bytes -= (list[dropped] as T).bytes.byteLength;
    dropped++;
  }
  if (dropped > 0) list.splice(0, dropped);
  return bytes;
}
