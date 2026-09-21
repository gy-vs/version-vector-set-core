import { compareBytes, validateCounter, validateId, VersionVectorError } from "./errors.js";

/** A bounded request for events the local replica is missing. */
export interface MissingRequest {
  readonly id: Uint8Array;
  /** Inclusive first counter to fetch. */
  readonly from: bigint;
  /** Inclusive last counter to fetch. */
  readonly to: bigint;
}

export type DiffEntry = {
  readonly id: Uint8Array;
  readonly segments: Array<[bigint, bigint]>;
};

/**
 * Result of {@link VersionVector.difference}: a canonical structural
 * description of "what do I have that the peer does not". Segments stay as
 * ranges, so a gap of 2^64 costs one tuple, not billions of entries.
 */
export class VectorDiff {
  private readonly entries: DiffEntry[] = [];

  /** Internal: append (may merge with the replica's previous ranges). */
  add(id: Uint8Array, lo: bigint, hi: bigint): void {
    validateId(id);
    validateCounter(lo, "diff.lo");
    validateCounter(hi, "diff.hi");
    if (lo > hi) throw new VersionVectorError("bad-range", `diff: lo ${lo} > hi ${hi}`);

    let entry: DiffEntry | undefined = this.entries[this.entries.length - 1];
    if (!entry || compareBytes(entry.id, id) !== 0) {
      // difference() walks sources in canonical order; a new id is a new run.
      entry = { id, segments: [] };
      this.entries.push(entry);
    }
    const segs = entry.segments;
    const last = segs[segs.length - 1];
    if (last && lo <= last[1] + 1n) {
      if (hi > last[1]) last[1] = hi;
    } else {
      segs.push([lo, hi]);
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /** Canonical id-ordered entries; callers must not mutate. */
  [Symbol.iterator](): IterableIterator<DiffEntry> {
    return this.entries[Symbol.iterator]();
  }

  /** Whether the peer is missing exactly nothing. */
  isEmpty(): boolean {
    return this.entries.every((e) => e.segments.length === 0);
  }

  /** Whether a particular event is listed as missing. */
  contains(id: Uint8Array, n: bigint): boolean {
    validateId(id);
    validateCounter(n, "contains");
    for (const e of this.entries) {
      const c = compareBytes(e.id, id);
      if (c > 0) return false;
      if (c === 0) {
        let lo = 0;
        let hi = e.segments.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (e.segments[mid]![1] < n) lo = mid + 1;
          else hi = mid;
        }
        const seg = e.segments[lo];
        return seg !== undefined && n >= seg[0];
      }
    }
    return false;
  }

  // -------------------------------------------------------- missing requests

  /**
   * Produce a bounded, resumable batch of fetch requests for everything in
   * this diff. Each returned request covers at most `maxSpan` counters (so
   * huge gaps get truncated/chunked), and at most `maxRequests` requests are
   * returned per call. Re-invoke with the returned cursor to continue; a null
   * cursor means the diff is fully enumerated.
   *
   * Requests are emitted in canonical (id, then counter) order.
   */
  page(
    maxSpan: bigint = 1000n,
    maxRequests = 100,
    cursor: string | null = null,
  ): { requests: MissingRequest[]; cursor: string | null } {
    if (typeof maxSpan !== "bigint" || maxSpan < 1n) {
      throw new VersionVectorError("bad-range", "maxSpan must be a bigint >= 1");
    }
    if (!Number.isInteger(maxRequests) || maxRequests < 1) {
      throw new VersionVectorError("bad-range", "maxRequests must be an integer >= 1");
    }

    // Position is (entryIdx, segIdx, segFrom): the next counter to emit is
    // segFrom inside that segment. A cursor whose segment index equals the
    // entry's segment count means "continue at the next entry".
    let entryIdx = 0;
    let segIdx = 0;
    let segFrom = 0n;
    if (cursor !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        throw new VersionVectorError("bad-cursor", "cursor is not valid base64url JSON");
      }
      const c = parsed as { e?: unknown; s?: unknown; f?: unknown };
      if (
        c === null ||
        typeof c !== "object" ||
        typeof c.e !== "number" ||
        typeof c.s !== "number" ||
        typeof c.f !== "string"
      ) {
        throw new VersionVectorError("bad-cursor", "cursor has wrong shape");
      }
      entryIdx = c.e;
      segIdx = c.s;
      if (!Number.isInteger(entryIdx) || !Number.isInteger(segIdx)) {
        throw new VersionVectorError("bad-cursor", "cursor indices must be integers");
      }
      if (entryIdx < 0 || entryIdx > this.entries.length) {
        throw new VersionVectorError("bad-cursor", "cursor entry index out of bounds");
      }
      if (entryIdx < this.entries.length) {
        const limit = this.entries[entryIdx]!.segments.length;
        if (segIdx < 0 || segIdx > limit) {
          throw new VersionVectorError("bad-cursor", "cursor segment index out of bounds");
        }
        if (segIdx < limit) segFrom = parseCursorCounter(c.f);
        else if (c.f !== "0")
          throw new VersionVectorError("bad-cursor", "cursor offset set past last segment");
      } else if (segIdx !== 0 || c.f !== "0") {
        throw new VersionVectorError("bad-cursor", "cursor past end of diff");
      }
    }

    const requests: MissingRequest[] = [];
    let nextCursor: string | null = null;

    while (entryIdx < this.entries.length) {
      const entry = this.entries[entryIdx]!;
      while (segIdx < entry.segments.length) {
        const seg = entry.segments[segIdx]!;
        const from = segFrom === 0n ? seg[0] : segFrom;
        const span = seg[1] - from + 1n;
        const take = span < maxSpan ? span : maxSpan;
        const to = from + take - 1n;
        requests.push({ id: entry.id, from, to });

        if (to < seg[1]) {
          // Same segment has more counters; resume right after this chunk.
          segFrom = to + 1n;
        } else {
          // Segment finished; offset 0 marks a boundary.
          segFrom = 0n;
          segIdx++;
        }

        if (requests.length >= maxRequests) {
          nextCursor = encodeCursor(entryIdx, segIdx, segFrom);
          break;
        }
      }
      if (nextCursor !== null) break;
      entryIdx++;
      segIdx = 0;
      segFrom = 0n;
    }

    // Running off the end means the diff is fully enumerated.
    if (entryIdx >= this.entries.length) nextCursor = null;
    return { requests, cursor: nextCursor };
  }

  /** Convenience: drain the whole diff into requests (still range-based). */
  allRequests(maxSpan: bigint = 1000n): MissingRequest[] {
    const out: MissingRequest[] = [];
    let cursor: string | null = null;
    do {
      const page = this.page(maxSpan, 1_000_000, cursor);
      out.push(...page.requests);
      cursor = page.cursor;
    } while (cursor !== null);
    return out;
  }
}

function parseCursorCounter(s: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(s)) {
    throw new VersionVectorError("bad-cursor", "cursor offset is not a decimal integer");
  }
  const n = BigInt(s);
  if (n < 1n) throw new VersionVectorError("bad-cursor", "cursor offset must be >= 1");
  return n;
}

function encodeCursor(entryIdx: number, segIdx: number, segFrom: bigint): string {
  const payload = JSON.stringify({ e: entryIdx, s: segIdx, f: segFrom.toString() });
  return Buffer.from(payload, "utf8").toString("base64url");
}
