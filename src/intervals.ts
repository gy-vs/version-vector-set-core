/**
 * Canonical interval representation for one replica's observed event counters.
 *
 * Invariants (always maintained internally, and required when parsing wire data):
 *
 *   - `head` is the length of the contiguous prefix: every counter in
 *     [1, head] has been observed (head = 0n means nothing yet).
 *   - `segs` is a sorted list of disjoint half-open ranges [lo, hi] (inclusive
 *     both ends, lo <= hi) of *gap* events strictly above `head`.
 *   - ranges never touch:  seg[i].hi + 1 < seg[i+1].lo
 *     (adjacency does not occur; a fill that bridges a gap advances `head`
 *     or coalesces ranges through `unionSegments`).
 *
 * Everything is a BigInt: counters are arbitrary-precision and the structure
 * size is proportional to the *number* of ranges, never to counter magnitude.
 */

export interface Seg {
  lo: bigint;
  hi: bigint;
}

export interface SegState {
  head: bigint;
  segs: Seg[];
}

export function emptyState(): SegState {
  return { head: 0n, segs: [] };
}

export function stateContains(s: SegState, p: bigint): boolean {
  if (p <= 0n || p <= s.head) return p > 0n;
  return segContains(s.segs, p) !== -1;
}

/** Binary search; returns the index of the range containing p, or -1. */
export function segContains(segs: readonly Seg[], p: bigint): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = segs[mid]!;
    if (p < g.lo) hi = mid - 1;
    else if (p > g.hi) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Observe a single counter above `head`. Returns a new canonical state in
 * O(k); never mutates its input. Duplicate observations are identity-stable
 * for the gap ranges (the head advance still allocates a fresh state).
 */
export function addPoint(s: SegState, p: bigint): SegState {
  if (p <= s.head) return s;

  const segs = s.segs;

  // Point already covered by a gap range.
  if (segContains(segs, p) !== -1) {
    return s;
  }

  const i = lowerBound(segs, p);

  // Point extends the contiguous prefix (possibly bridging one or more
  // ranges that begin exactly at head + 1).
  if (p === s.head + 1n) {
    let head = p;
    let j = 0;
    while (j < segs.length && segs[j]!.lo <= head + 1n) {
      head = segs[j]!.hi;
      j++;
    }
    return { head, segs: segs.slice(j) };
  }

  const prev = i > 0 ? segs[i - 1]! : undefined;
  const next = i < segs.length ? segs[i]! : undefined;

  // Extend an existing range leftward / rightward.
  if (prev && p === prev.hi + 1n) {
    if (next && p === next.lo - 1n) {
      const merged: Seg = { lo: prev.lo, hi: next.hi };
      return { head: s.head, segs: replaceRange(segs, i - 1, i, merged) };
    }
    return { head: s.head, segs: withRange(segs, i - 1, { lo: prev.lo, hi: p }) };
  }
  if (next && p === next.lo - 1n) {
    return { head: s.head, segs: withRange(segs, i, { lo: p, hi: next.hi }) };
  }

  // Standalone point.
  const out = segs.slice();
  out.splice(i, 0, { lo: p, hi: p });
  return { head: s.head, segs: out };
}

/**
 * Union of two canonical range lists (merge / ingest path). Each input is
 * independently sorted by lo; we k-way merge by lo and coalesce overlap or
 * adjacency. Input order is irrelevant, so the result is always canonical —
 * never assume one list starts below the other.
 */
export function unionSegments(a: readonly Seg[], b: readonly Seg[]): Seg[] {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a.slice();

  const out: Seg[] = [];
  let i = 0;
  let j = 0;
  let cur: Seg | null = null;

  const absorb = (g: Seg): void => {
    if (cur === null) {
      cur = { lo: g.lo, hi: g.hi };
    } else if (g.lo <= cur.hi + 1n) {
      if (g.hi > cur.hi) cur = { lo: cur.lo, hi: g.hi };
    } else {
      out.push(cur);
      cur = { lo: g.lo, hi: g.hi };
    }
  };

  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i]!.lo <= b[j]!.lo)) {
      absorb(a[i]!);
      i++;
    } else {
      absorb(b[j]!);
      j++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Set difference of two canonical range lists: every point covered by `a`
 * but not by `b`. O(|a| + |b|) via a two-pointer sweep — never enumerates
 * counters, so a range spanning 2^60 costs the same work as a point.
 * Output covers disjoint, non-adjacent ranges; callers canonicalize the
 * surrounding prefix afterwards with `foldPrefix`.
 */
export function subtractSegments(a: readonly Seg[], b: readonly Seg[]): Seg[] {
  const out: Seg[] = [];
  let j = 0;
  for (const x of a) {
    let lo = x.lo;
    const hi = x.hi;
    while (j < b.length && b[j]!.hi < lo) j++;
    let k = j;
    while (lo <= hi) {
      const y = k < b.length ? b[k]! : undefined;
      if (!y || y.lo > hi) {
        out.push({ lo, hi });
        break;
      }
      if (y.lo > lo) out.push({ lo, hi: min(hi, y.lo - 1n) });
      if (y.hi >= lo) lo = y.hi + 1n;
      k++;
    }
  }
  return out;
}

/**
 * Rebuild a canonical state given a tentative head and gap ranges.
 * Ranges that are covered by the prefix are dropped, overlap is impossible
 * given the internal callers, and any range starting at head+1 (adjacency
 * produced by subtraction) is folded into the prefix; a chain of adjacent
 * folds advances the prefix as far as possible.
 */
export function foldPrefix(head: bigint, segs: readonly Seg[]): SegState {
  let h = head;
  let i = 0;
  while (i < segs.length && segs[i]!.lo <= h + 1n && segs[i]!.hi > h) {
    h = segs[i]!.hi;
    i++;
  }
  return { head: h, segs: segs.slice(i) };
}

/** Total number of ranges (structural-size metric; independent of magnitude). */
export function segCount(s: SegState): number {
  return s.segs.length;
}

// --- internals ---------------------------------------------------------------

function lowerBound(segs: readonly Seg[], p: bigint): number {
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.lo < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function withRange(segs: readonly Seg[], idx: number, g: Seg): Seg[] {
  const out = segs.slice();
  out[idx] = g;
  return out;
}

function replaceRange(segs: readonly Seg[], from: number, to: number, g: Seg): Seg[] {
  const out = segs.slice(0, from);
  out.push(g);
  out.push(...segs.slice(to + 1));
  return out;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
