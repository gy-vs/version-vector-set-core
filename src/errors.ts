/**
 * Stable error code tags for invalid structural input.
 *
 * bad-range     counter out of [1, 2^64-1], lo > hi, wrong type, unsafe bigint
 * overlap       decoded segments overlap / are not sorted / touch the prefix
 * bad-id        replica id is empty, too long, or not a byte array / hex string
 * bad-document  serialized document is malformed (wrong shape / types / keys)
 * bad-cursor    an opaque missing-request continuation token is corrupted
 */
export type VectorErrorCode =
  | "bad-range"
  | "overlap"
  | "bad-id"
  | "bad-document"
  | "bad-cursor";

export class VersionVectorError extends Error {
  readonly code: VectorErrorCode;

  constructor(code: VectorErrorCode, message: string) {
    super(message);
    this.name = "VersionVectorError";
    this.code = code;
  }
}

/** Counters are unsigned 64-bit values so they fit every transport we know of. */
export const MAX_COUNTER: bigint = (1n << 64n) - 1n;

/** Replica ids are capped to keep serialized documents self-delimiting. */
export const MAX_ID_BYTES = 255;

const UINT_RE = /^(?:0|[1-9][0-9]*)$/;

/** Parse a decimal string into a validated counter (1 .. 2^64-1). */
export function parseCounter(value: unknown, where: string): bigint {
  if (typeof value !== "string" || value.length === 0 || value.length > 20 || !UINT_RE.test(value)) {
    throw new VersionVectorError("bad-range", `${where}: expected decimal counter string`);
  }
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw new VersionVectorError("bad-range", `${where}: unparseable counter`);
  }
  if (n < 1n || n > MAX_COUNTER) {
    throw new VersionVectorError(
      "bad-range",
      `${where}: counter ${value} out of range [1, 2^64-1]`,
    );
  }
  return n;
}

export function validateCounter(n: bigint, where: string): bigint {
  if (typeof n !== "bigint") {
    throw new VersionVectorError("bad-range", `${where}: counter must be a bigint`);
  }
  if (n < 1n || n > MAX_COUNTER) {
    throw new VersionVectorError("bad-range", `${where}: counter ${n} out of range [1, 2^64-1]`);
  }
  return n;
}

const HEX_RE = /^[0-9a-f]*$/;

/** Parse lowercase hex into a fresh byte array; throws on odd length/non-hex. */
export function parseHexId(hex: unknown): Uint8Array {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new VersionVectorError("bad-id", `replica id must be lowercase even-length hex`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return validateId(bytes);
}

export function validateId(id: Uint8Array): Uint8Array {
  if (!(id instanceof Uint8Array) || id.byteLength === 0 || id.byteLength > MAX_ID_BYTES) {
    throw new VersionVectorError(
      "bad-id",
      `replica id must be 1..${MAX_ID_BYTES} bytes (got ${
        id instanceof Uint8Array ? id.byteLength : typeof id
      })`,
    );
  }
  return id;
}

export function toHex(id: Uint8Array): string {
  let out = "";
  for (const b of id) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Unsigned byte-wise lexicographic comparison, matching canonical sort order. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
