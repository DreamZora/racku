/**
 * Converts what the user types and what arrives: bytes to and from text, hex, and base64, which
 * carries bytes in the window's JSON. Plain TypeScript, which runs in the window and in Bun.
 *
 * @decision .agents/decisions/261118_173845-net-tool-example.md#the-window
 */

/** Text to bytes, as UTF-8. */
export function textToBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

/** Bytes to text, with U+FFFD for bytes that aren't UTF-8. */
export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Hex input that isn't pairs of hex digits. */
export class HexError extends Error {
  override name = "HexError";
}

/**
 * Hex to bytes: pairs of hex digits, with optional spaces between pairs.
 *
 * @throws HexError for any other character, or a group with an odd number of digits.
 */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  for (const group of hex.trim().split(/\s+/)) {
    if (group === "") continue;
    const wrong = /[^0-9a-fA-F]/.exec(group);
    if (wrong !== null) throw new HexError(`"${wrong[0]}" isn't a hex digit`);
    if (group.length % 2 === 1) throw new HexError(`"${group}" has an odd number of digits`);
    for (let index = 0; index < group.length; index += 2) {
      bytes.push(Number.parseInt(group.slice(index, index + 2), 16));
    }
  }
  return Uint8Array.from(bytes);
}

/** Bytes to hex, as pairs of lowercase digits separated by spaces. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

/** Bytes to base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Base64 to bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
