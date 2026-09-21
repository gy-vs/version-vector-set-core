import { ReplicaId } from './replicaId.js';
import { fail, VersionVectorError } from './errors.js';
import {
  addPoint,
  emptyState,
  foldPrefix,
  Seg,
  segCount,
  stateContains,
  subtractSegments,
  unionSegments,
  type SegState,
} from './intervals.js';

/**
 * Per-replica raw ranges as exposed on the wire and to callers:
 *   p     – contiguous prefix length (counters 1..p all observed)
 *   gaps  – disjoint, sorted, non-adjacent half-open ranges above p.
 *
 * Counter values are decimal strings in JSON; the in-memory API uses bigint.
 */
export interface VectorEntryWire {
  p: string;
  gaps: [string, string][];
}

export interface VectorEntry {
  p: bigint;
  gaps: Seg[];
}

/**
 * Maximum accepted counter. Keeps values inside an unsigned 64-bit range so
 * serialized data remains portable; 2^64 itself as an exclusive ceiling.
 */
export const MAX_COUNTER: bigint = (1n << 64n) - 1n;

/**
 * A collection of per-replica version vectors used for offline replication.
 *
 * Each replica's state is the pair (contiguous prefix, canonical gap ranges),
 * so counters may arrive in any order without per-event storage: memory is
 * O(replicas × gap-ranges), independent of the largest counter ever seen.
 *
 * The class is immutable-by-convention: mutating methods return new sets and
 * never alias caller-owned arrays.
 */
interface EntryRec {
  id: ReplicaId;
  state: SegState;
}

export class VersionVectorSet {
  // Keyed by the stable hex identity so ReplicaId instances that are
  // byte-equal (e.g. one constructed from bytes, another parsed from wire
  // data) collapse to one entry — ReplicaId itself has value equality.
  readonly #entries: ReadonlyMap<string, EntryRec>;

  private constructor(entries: ReadonlyMap<string, EntryRec>) {
    this.#entries = entries;
  }

  static empty(): VersionVectorSet {
    return new VersionVectorSet(new Map());
  }

  /**
   * Parse the deterministic wire form. Rejects malformed data with a
   * VersionVectorError whose `code` distinguishes the failure class:
   * overlaps (RANGE_OVERLAPS_PREFIX / RANGE_NOT_NORMALIZED), reversed
   * ranges (RANGE_REVERSED) and out-of-bounds counters (COUNTER_OUT_OF_BOUNDS).
   */
  static parse(text: string): VersionVectorSet {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      fail('BAD_WIRE_FORMAT', 'payload is not valid JSON');
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      fail('BAD_WIRE_FORMAT', 'payload root must be a JSON object');
    }
    const obj = data as Record<string, unknown>;
    const entries = new Map<string, EntryRec>();
    let prevHex = '';

    for (const hex of Object.keys(obj)) {
      if (hex <= prevHex) {
        fail('BAD_WIRE_FORMAT', 'replica ids must be unique and hex-sorted');
      }
      prevHex = hex;

      let id: ReplicaId;
      try {
        id = ReplicaId.fromHex(hex);
      } catch (e) {
        throwAsWireError(e);
      }

      const raw = obj[hex];
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        fail('BAD_WIRE_FORMAT', `entry ${hex} must be an object`);
      }
      const entry = raw as Record<string, unknown>;

      const p = parseCounter(entry.p, 'p', hex);
      // `gaps` is optional on the wire; absence means an empty gap list.
      const gaps: Seg[] = [];
      if (entry.gaps !== undefined) {
        if (!Array.isArray(entry.gaps)) {
          fail('BAD_WIRE_FORMAT', `entry ${hex} gaps must be an array`);
        }
        let prevHi = p;
        for (let i = 0; i < entry.gaps.length; i++) {
          const pair = entry.gaps[i];
          if (!Array.isArray(pair) || pair.length !== 2) {
            fail('BAD_WIRE_FORMAT', `entry ${hex} gap[${i}] must be a [lo, hi] pair`);
          }
          const lo = parseCounter(pair[0], `gaps[${i}][0]`, hex);
          const hi = parseCounter(pair[1], `gaps[${i}][1]`, hex);
          if (lo > hi) fail('RANGE_REVERSED', `entry ${hex} gap[${i}] has lo > hi`);
          if (lo <= p) fail('RANGE_OVERLAPS_PREFIX', `entry ${hex} gap[${i}] overlaps the prefix`);
          // Canonical ordering: strictly after the previous range with at
          // least one uncovered counter between them (adjacency is illegal).
          if (lo <= prevHi + 1n) {
            fail('RANGE_NOT_NORMALIZED', `entry ${hex} gap[${i}] overlaps or abuts the previous range`);
          }
          gaps.push({ lo, hi });
          prevHi = hi;
        }
      }
      entries.set(hex, { id, state: { head: p, segs: gaps } });
    }
    return new VersionVectorSet(entries);
  }

  // --- queries ---------------------------------------------------------------

  /** Has counter `n` (1-based) of replica `id` been observed? */
  contains(id: ReplicaId, n: CounterInput): boolean {
    const rec = this.#entries.get(id.hex);
    // 0 or above the bound is never a valid counter: answer false rather
    // than throw, so callers can use this as a plain membership predicate.
    if (typeof n === 'bigint') {
      if (n <= 0n || n > MAX_COUNTER) return false;
      return rec ? stateContains(rec.state, n) : false;
    }
    const p = normalizeCounter(n, 'counter');
    return rec ? stateContains(rec.state, p) : false;
  }

  /** Contiguous prefix length for a replica (0n if unknown). */
  head(id: ReplicaId): bigint {
    return this.#entries.get(id.hex)?.state.head ?? 0n;
  }

  /** Gap range count (the structural-size metric; independent of magnitude). */
  gapCount(id: ReplicaId): number {
    const rec = this.#entries.get(id.hex);
    return rec ? segCount(rec.state) : 0;
  }

  /** Total gap ranges across all replicas. */
  totalGapRanges(): number {
    let n = 0;
    for (const rec of this.#entries.values()) n += rec.state.segs.length;
    return n;
  }

  /** Read-only per-replica view in deterministic (replica-id) order. */
  entries(): ReadonlyArray<readonly [ReplicaId, VectorEntry]> {
    const recs = [...this.#entries.values()].sort((a, b) => a.id.compareTo(b.id));
    return recs.map((rec) => {
      const s = rec.state;
      return [rec.id, { p: s.head, gaps: s.segs.map((g) => ({ ...g })) }] as const;
    });
  }

  // --- updates ---------------------------------------------------------------

  /**
   * Observe one counter for a replica. Counters may arrive out of order;
   * duplicates are no-ops and filling a bridge advances the prefix, possibly
   * coalescing every range it joins.
   */
  add(id: ReplicaId, n: CounterInput): VersionVectorSet {
    const p = normalizeCounter(n, 'counter');
    const cur = this.#entries.get(id.hex)?.state ?? emptyState();
    const next = addPoint(cur, p);
    if (next === cur) return this;
    return this.#with(id, next);
  }

  /**
   * Merge another set (union of observations), e.g. on sync with a peer.
   * Associative and commutative: A.merge(B).merge(C) converges regardless
   * of order. Returns this if nothing new is learned.
   */
  merge(other: VersionVectorSet): VersionVectorSet {
    let out: VersionVectorSet = this;
    let changed = false;
    for (const [key, theirRec] of other.#entries) {
      const id = theirRec.id;
      const theirs = theirRec.state;
      const ours = out.#entries.get(key)?.state;
      if (!ours) {
        out = out.#with(id, { head: theirs.head, segs: theirs.segs.map((g) => ({ ...g })) });
        changed = true;
        continue;
      }
      // The larger prefix may swallow ranges that either side carried as
      // gaps (e.g. merging a contiguous head=2 into gaps [2,3],[11]).
      // Drop any range covered by the winning prefix before unioning;
      // foldPrefix then absorbs adjacency and chains of bridges.
      const dropCovered = (segs: readonly Seg[], h: bigint): Seg[] =>
        segs.filter((g) => g.hi > h);
      const head = ours.head > theirs.head ? ours.head : theirs.head;
      const merged = foldPrefix(
        head,
        unionSegments(dropCovered(ours.segs, head), dropCovered(theirs.segs, head)),
      );
      if (!sameState(merged, ours)) {
        out = out.#with(id, merged);
        changed = true;
      }
    }
    return changed ? out : this;
  }

  /**
   * Structural difference: counters observed here but not in `other`.
   * Computed range-by-range with a linear sweep (never enumerates events),
   * so a missing window of 10^18 is one output range, not 10^18 entries.
   * The result is itself a valid VersionVectorSet.
   */
  difference(other: VersionVectorSet): VersionVectorSet {
    const out = new Map<string, EntryRec>();
    for (const [key, ourRec] of this.#entries) {
      const ours = ourRec.state;
      const theirs = other.#entries.get(key)?.state;
      // Full coverage as canonical segment lists: the prefix is one range.
      const oursCover: Seg[] = ours.head > 0n
        ? [{ lo: 1n, hi: ours.head }, ...ours.segs]
        : ours.segs.slice();
      const theirsCover: Seg[] = !theirs
        ? []
        : theirs.head > 0n
          ? [{ lo: 1n, hi: theirs.head }, ...theirs.segs]
          : theirs.segs.slice();

      // Sweep never enumerates counters: a window of 10^18 stays one range.
      const remainder = subtractSegments(oursCover, theirsCover);
      const merged = foldPrefix(0n, remainder);
      if (merged.head !== 0n || merged.segs.length > 0) {
        out.set(key, { id: ourRec.id, state: merged });
      }
    }
    return new VersionVectorSet(out);
  }

  // --- serialization ---------------------------------------------------------

  /**
   * Deterministic JSON: replicas sorted by unsigned byte order (hex string
   * order), ranges sorted, bigints as decimal strings, empty `gaps` omitted.
   * byte-identical for structurally equal states regardless of add order.
   */
  serialize(): string {
    const parts: string[] = [];
    for (const [id, entry] of this.entries()) {
      const gaps = entry.gaps.length === 0
        ? ''
        : `,"gaps":[${entry.gaps.map((g) => `["${g.lo.toString()}","${g.hi.toString()}"]`).join(',')}]`;
      parts.push(`${JSON.stringify(id.hex)}:{"p":"${entry.p.toString()}"${gaps}}`);
    }
    return `{${parts.join(',')}}`;
  }

  toString(): string {
    return this.serialize();
  }

  // --- internals -------------------------------------------------------------

  #with(id: ReplicaId, state: SegState): VersionVectorSet {
    const next = new Map(this.#entries);
    next.set(id.hex, { id, state });
    return new VersionVectorSet(next);
  }
}

export type CounterInput = bigint | number | string;

/**
 * Convert an API counter argument to a validated bigint.
 * Numbers must be safe non-negative integers; strings must be canonical
 * decimal; everything is bounded by MAX_COUNTER.
 */
export function normalizeCounter(value: CounterInput, what: string): bigint {
  let n: bigint;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      fail('COUNTER_UNSAFE', `${what} number must be a safe integer, got ${String(value)}`);
    }
    n = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) fail('BAD_COUNTER', `${what} must be a decimal string, got ${JSON.stringify(value)}`);
    n = BigInt(value);
  } else {
    fail('BAD_COUNTER', `${what} must be a bigint, safe integer, or decimal string`);
  }
  if (n < 1n) fail('BAD_COUNTER', `${what} must be >= 1`);
  if (n > MAX_COUNTER) fail('COUNTER_OUT_OF_BOUNDS', `${what} exceeds max counter 2^64-1`);
  return n;
}

/** Structural equality of two canonical states (both lists are canonical). */
function sameState(a: SegState, b: SegState): boolean {
  if (a.head !== b.head || a.segs.length !== b.segs.length) return false;
  for (let i = 0; i < a.segs.length; i++) {
    if (a.segs[i]!.lo !== b.segs[i]!.lo || a.segs[i]!.hi !== b.segs[i]!.hi) return false;
  }
  return true;
}

function parseCounter(value: unknown, what: string, hex: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    fail('BAD_COUNTER', `entry ${hex} field ${what} must be a decimal string`);
  }
  const n = BigInt(value);
  if (n > MAX_COUNTER) {
    fail('COUNTER_OUT_OF_BOUNDS', `entry ${hex} field ${what} exceeds max counter 2^64-1`);
  }
  return n;
}

function throwAsWireError(e: unknown): never {
  if (e instanceof VersionVectorError) throw e;
  fail('BAD_REPLICA_ID', e instanceof Error ? e.message : 'invalid replica id');
}
