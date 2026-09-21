import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.js';

/**
 * A replica identity is an opaque, *stable* binary value: it never derives from
 * a process-local counter or clock value that another replica could reuse.
 *
 * Equality compares bytes individually (unsigned) and timing-safe, ordering is
 * the unsigned lexicographic byte order, and the wire/JSON form is lowercase
 * hex — ASCII hex order coincides with byte order, so sorting hex strings
 * yields exactly the same deterministic order as sorting the raw bytes.
 */
export class ReplicaId implements Comparable<ReplicaId> {
  /** Raw identity bytes, treated as unsigned. */
  readonly bytes: Uint8Array;
  /** Lowercase hex encoding, cached because it is the wire representation. */
  readonly hex: string;

  protected constructor(bytes: Uint8Array, hex: string) {
    this.bytes = bytes;
    this.hex = hex;
  }

  /** Wrap an existing binary identity (copied defensively). */
  static fromBytes(bytes: Uint8Array): ReplicaId {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      fail('BAD_REPLICA_ID', 'replica id must be a non-empty byte sequence');
    }
    if (bytes.length > 256) {
      fail('BAD_REPLICA_ID', `replica id is ${bytes.length} bytes, max is 256`);
    }
    const copy = Uint8Array.from(bytes);
    return new ReplicaId(copy, toHex(copy));
  }

  /** Decode a lowercase (or uppercase) hex identity. */
  static fromHex(hex: string): ReplicaId {
    if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) {
      fail('BAD_REPLICA_ID', 'replica id hex must be a non-empty even-length string');
    }
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      fail('BAD_REPLICA_ID', 'replica id hex contains non-hexadecimal characters');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return new ReplicaId(bytes, hex.toLowerCase());
  }

  /** Mint a fresh 16-byte random identity. */
  static random(): ReplicaId {
    return ReplicaId.fromBytes(randomBytes(16));
  }

  equals(other: ReplicaId): boolean {
    return this.bytes.length === other.bytes.length && timingSafeEqual(this.bytes, other.bytes);
  }

  compareTo(other: ReplicaId): number {
    const a = this.bytes;
    const b = other.bytes;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = a[i]! - b[i]!;
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  toString(): string {
    return this.hex;
  }
}

interface Comparable<T> {
  compareTo(other: T): number;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
