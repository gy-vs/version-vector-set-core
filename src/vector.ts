import {
  compareBytes,
  parseCounter,
  parseHexId,
  toHex,
  validateCounter,
  validateId,
  VersionVectorError,
} from "./errors.js";
import { VectorDiff } from "./diff.js";

/** Half-open discrete counter interval: [lo, hi] inclusive, both bigint. */
export type Segment = readonly [lo: bigint, hi: bigint];

export interface EncodedRange {
  readonly from: string;
  readonly to: string;
}

export interface EncodedEntry {
  readonly id: string;
  readonly prefix: string;
  readonly segments: EncodedRange[];
}

export interface EncodedVector {
  readonly version: 1;
  readonly entries: EncodedEntry[];
}

export interface VectorEntry {
  /** Stable binary replica identity; never empty. */
  readonly id: Uint8Array;
  /** All counters 1..prefix have been observed contiguously. */
  prefix: bigint;
  /** Sorted, disjoint, non-adjacent ranges strictly above the prefix. */
  segments: Segment[];
}

/**
 * Structural set of "which events has this member of the replica group seen".
 *
 * Each replica keeps a contiguous prefix plus a small list of discrete
 * segments for events that arrived out of order. Memory is O(number of
 * gaps), never O(largest counter).
 *
 * Entries are kept in byte-wise sorted id order so serialization is
 * deterministic.
 */
export class VersionVector {
  private readonly entries: VectorEntry[] = [];

  // ---------------------------------------------------------------- storage

  /** Lower-bound binary search: index of first entry with id >= target. */
  private indexOf(id: Uint8Array): number {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(this.entries[mid]!.id, id) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private entryOr(id: Uint8Array, create: boolean): VectorEntry | undefined {
    const idx = this.indexOf(id);
    const found = this.entries[idx];
    if (found && compareBytes(found.id, id) === 0) return found;
    if (!create) return undefined;
    const entry: VectorEntry = { id: id.slice(), prefix: 0n, segments: [] };
    this.entries.splice(idx, 0, entry);
    return entry;
  }

  /** Number of replicas tracked. */
  get size(): number {
    return this.entries.length;
  }

  /** Read-only view over entries, in canonical id order. */
  [Symbol.iterator](): IterableIterator<VectorEntry> {
    return this.entries[Symbol.iterator]();
  }

  /** Prefix for a replica, or 0n when it has never been seen. */
  prefixOf(id: Uint8Array): bigint {
    validateId(id);
    const idx = this.indexOf(id);
    const found = this.entries[idx];
    return found && compareBytes(found.id, id) === 0 ? found.prefix : 0n;
  }

  /** Defensive copy of the canonical segments for one replica. */
  segmentsOf(id: Uint8Array): Segment[] {
    validateId(id);
    const idx = this.indexOf(id);
    const found = this.entries[idx];
    if (!found || compareBytes(found.id, id) !== 0) return [];
    return found.segments.map((s) => [s[0], s[1]] as Segment);
  }

  // -------------------------------------------------------------- contains

  /**
   * Whether event `n` from `id` has been observed. O(log segments): only the
   * segment possibly containing n is inspected.
   */
  contains(id: Uint8Array, n: bigint): boolean {
    validateId(id);
    validateCounter(n, "contains");
    const entry = this.entryOr(id, false);
    if (!entry) return false;
    if (n <= entry.prefix) return true;
    // First segment whose hi >= n.
    let lo = 0;
    let hi = entry.segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entry.segments[mid]![1] < n) lo = mid + 1;
      else hi = mid;
    }
    const seg = entry.segments[lo];
    return seg !== undefined && n >= seg[0];
  }

  // ------------------------------------------------------------------- add

  /** Record a single observed event counter from replica id. */
  add(id: Uint8Array, n: bigint): void {
    validateId(id);
    validateCounter(n, "add");
    this.addRange(id, n, n);
  }

  /**
   * Record every counter in [lo, hi] from replica id.
   *
   * Normalization merges overlapping/adjacent segments together with the
   * virtual range [1, prefix]; whenever a bridge closes the first gap the
   * contiguous prefix advances (possibly swallowing a chain of segments).
   */
  addRange(id: Uint8Array, lo: bigint, hi: bigint): void {
    validateId(id);
    validateCounter(lo, "addRange.lo");
    validateCounter(hi, "addRange.hi");
    if (lo > hi) {
      throw new VersionVectorError("bad-range", `addRange: lo ${lo} > hi ${hi}`);
    }
    const entry = this.entryOr(id, true)!;

    if (hi <= entry.prefix) return;
    if (lo <= entry.prefix) lo = entry.prefix + 1n;

    // First segment that can touch [lo-1, ...]; everything at/after it with
    // lo <= hi+1 overlaps or is adjacent and gets absorbed.
    let i = 0;
    {
      let l = 0;
      let h = entry.segments.length;
      while (l < h) {
        const mid = (l + h) >>> 1;
        if (entry.segments[mid]![1] + 1n < lo) l = mid + 1;
        else h = mid;
      }
      i = l;
    }

    let newLo = lo;
    let newHi = hi;
    let end = i;
    while (end < entry.segments.length && entry.segments[end]![0] <= newHi + 1n) {
      const seg = entry.segments[end]!;
      if (seg[0] < newLo) newLo = seg[0];
      if (seg[1] > newHi) newHi = seg[1];
      end++;
    }

    // Replace every absorbed segment with the single merged range. If it
    // reaches the prefix it is spliced away instead; either way the prefix
    // advancement walk below sees the correct starting point.
    if (newLo === entry.prefix + 1n) {
      entry.segments.splice(i, end - i);
      entry.prefix = newHi;
    } else {
      entry.segments.splice(i, end - i, [newLo, newHi]);
    }

    // The merge may have left segments (including the freshly inserted one)
    // adjacent to the raised prefix; walk forward while they touch it.
    while (
      entry.segments.length > 0 &&
      entry.segments[0]![0] === entry.prefix + 1n
    ) {
      entry.prefix = entry.segments[0]![1];
      entry.segments.shift();
    }
  }

  // ----------------------------------------------------------------- merge

  /**
   * Fold another vector (or a serialized document) into this one.
   * Entry order in the input is irrelevant; invalid input throws.
   */
  merge(other: VersionVector | EncodedVector): void {
    const decoded = other instanceof VersionVector ? other : VersionVector.decode(other);
    for (const e of decoded.entries) {
      // Entries stay canonical: replay prefix and segments through addRange,
      // which normalizes everything against this vector's own state.
      if (e.prefix > 0n) this.addRange(e.id, 1n, e.prefix);
      for (const seg of e.segments) this.addRange(e.id, seg[0], seg[1]);
    }
  }

  // ------------------------------------------------------------- difference

  /**
   * Structural set difference: counters present in `this` but absent in
   * `other` (missing counters default to "not seen"). Never expands into
   * per-event work — cost is O(segments), even for 2^64-sized gaps.
   */
  difference(other: VersionVector): VectorDiff {
    const result = new VectorDiff();
    let j = 0;
    for (const me of this.entries) {
      while (j < other.entries.length && compareBytes(other.entries[j]!.id, me.id) < 0) j++;
      const them =
        j < other.entries.length && compareBytes(other.entries[j]!.id, me.id) === 0
          ? other.entries[j]!
          : undefined;

      // A's side as canonical source ranges: the unaccounted prefix tail
      // (strictly above their prefix) followed by A's discrete segments.
      const sources: Segment[] = [];
      const theirPrefix = them ? them.prefix : 0n;
      if (me.prefix > theirPrefix) sources.push([theirPrefix + 1n, me.prefix]);
      for (const seg of me.segments) sources.push(seg);

      // Subtract BOTH the peer's prefix region and its discrete segments;
      // a segment of theirs can sit inside our prefix tail.
      const remaining = subtractIntervals(sources, theirPrefix, them ? them.segments : []);
      for (const seg of remaining) result.add(me.id, seg[0], seg[1]);
    }
    return result;
  }

  // --------------------------------------------------------- serialization

  /** Canonical JSON document: ids hex sorted byte-wise, counters decimal. */
  encode(): EncodedVector {
    return {
      version: 1,
      entries: this.entries
        .slice()
        .sort((a, b) => compareBytes(a.id, b.id))
        .map((e) => ({
          id: toHex(e.id),
          prefix: e.prefix.toString(),
          segments: e.segments.map((s) => ({ from: s[0].toString(), to: s[1].toString() })),
        })),
    };
  }

  /** Deterministic string form; identical logical vectors always byte-match. */
  serialize(): string {
    return JSON.stringify(this.encode());
  }

  /**
   * Decode with full structural validation. Rejects:
   *  - wrong types, unknown fields, non-array documents
   *  - duplicate / malformed / unsorted replica ids
   *  - bad counters (non-decimal, <= 0, > 2^64-1)
   *  - reversed, overlapping, adjacent, duplicated, or unsorted segments
   *  - segments touching/below the prefix (non-canonical documents)
   */
  static decode(input: unknown): VersionVector {
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch (e) {
        throw new VersionVectorError("bad-document", `document is not valid JSON: ${(e as Error).message}`);
      }
    }
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new VersionVectorError("bad-document", "document must be an object");
    }
    const doc = input as Record<string, unknown>;
    if (doc.version !== 1) {
      throw new VersionVectorError("bad-document", `unsupported version ${String(doc.version)}`);
    }
    const rawEntries = doc.entries;
    if (!Array.isArray(rawEntries)) {
      throw new VersionVectorError("bad-document", "entries must be an array");
    }
    for (const key of Object.keys(doc)) {
      if (key !== "version" && key !== "entries") {
        throw new VersionVectorError("bad-document", `unknown document field "${key}"`);
      }
    }

    const vv = new VersionVector();
    let prevId: Uint8Array | undefined;
    for (let ei = 0; ei < rawEntries.length; ei++) {
      const re = rawEntries[ei]!;
      const where = `entries[${ei}]`;
      if (re === null || typeof re !== "object" || Array.isArray(re)) {
        throw new VersionVectorError("bad-document", `${where} must be an object`);
      }
      const obj = re as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (key !== "id" && key !== "prefix" && key !== "segments") {
          throw new VersionVectorError("bad-document", `${where}: unknown field "${key}"`);
        }
      }
      const id = parseHexId(obj.id);
      if (prevId && compareBytes(prevId, id) >= 0) {
        throw new VersionVectorError(
          "overlap",
          `${where}: replica ids must be strictly sorted and unique`,
        );
      }
      prevId = id;

      let prefix: bigint;
      if (obj.prefix === undefined || obj.prefix === "0") {
        prefix = 0n;
      } else {
        prefix = parseCounter(obj.prefix, `${where}.prefix`);
      }
      const rawSegs = obj.segments;
      if (rawSegs !== undefined && !Array.isArray(rawSegs)) {
        throw new VersionVectorError("bad-document", `${where}.segments must be an array`);
      }
      const segments: Segment[] = [];
      if (Array.isArray(rawSegs)) {
        let expectedMin = prefix + 1n;
        for (let si = 0; si < rawSegs.length; si++) {
          const rs = rawSegs[si]!;
          const sw = `${where}.segments[${si}]`;
          if (rs === null || typeof rs !== "object" || Array.isArray(rs)) {
            throw new VersionVectorError("bad-document", `${sw} must be an object`);
          }
          const sobj = rs as Record<string, unknown>;
          for (const key of Object.keys(sobj)) {
            if (key !== "from" && key !== "to") {
              throw new VersionVectorError("bad-document", `${sw}: unknown field "${key}"`);
            }
          }
          const lo = parseCounter(sobj.from, `${sw}.from`);
          const hi = parseCounter(sobj.to, `${sw}.to`);
          if (lo > hi) {
            throw new VersionVectorError("bad-range", `${sw}: reversed range ${lo}..${hi}`);
          }
          // Sorted and non-overlapping. Adjacent ranges are NOT an error:
          // they are normalized (merged) on replay below. Overlapping or
          // earlier-than-previous ranges are corrupt and rejected.
          if (lo < expectedMin) {
            throw new VersionVectorError(
              "overlap",
              `${sw}: range ${lo}..${hi} overlaps or precedes previous data (next expected >= ${expectedMin})`,
            );
          }
          segments.push([lo, hi]);
          expectedMin = hi + 1n;
        }
      }

      // Replay the entry through addRange so the decoded vector is always in
      // canonical form: a segment touching the prefix folds into it, adjacent
      // segments merge, and a chain of fills advances the prefix.
      if (prefix > 0n) vv.addRange(id, 1n, prefix);
      for (const [lo, hi] of segments) vv.addRange(id, lo, hi);
    }
    return vv;
  }

  /** Alias: decode a serialized document (string or parsed JSON). */
  static from(input: unknown): VersionVector {
    return VersionVector.decode(input);
  }
}

/**
 * Subtract the known region of one entry (its prefix + canonical segments)
 * from a list of canonical source segments. Two-pointer interval subtraction;
 * output stays disjoint, sorted and non-adjacent.
 */
export function subtractIntervals(
  source: readonly Segment[],
  cutPrefix: bigint,
  cuts: readonly Segment[],
): Segment[] {
  const out: Segment[] = [];
  let ci = 0;
  for (const [sLo0, sHi] of source) {
    let sLo = sLo0;

    // Virtual contiguous cut region [1, cutPrefix].
    if (cutPrefix >= sLo) sLo = cutPrefix + 1n;

    // Skip cuts entirely below the (possibly raised) start of this range.
    while (ci < cuts.length && cuts[ci]![1] < sLo) ci++;

    let k = ci;
    while (k < cuts.length && cuts[k]![0] <= sHi) {
      const [cLo, cHi] = cuts[k]!;
      if (cLo > sLo) out.push([sLo, cLo - 1n]);
      if (cHi + 1n > sLo) sLo = cHi + 1n;
      if (sLo > sHi) break;
      k++;
    }
    if (sLo <= sHi) out.push([sLo, sHi]);
    // Keep ci positioned for the next (later) source range.
    ci = k;
  }
  return out;
}
