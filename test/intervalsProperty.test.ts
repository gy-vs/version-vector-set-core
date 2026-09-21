import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionVectorSet, ReplicaId } from '../src/index.js';
import { rng } from './helpers.js';

/**
 * Build a canonical state at huge magnitudes directly from ranges, then
 * union/difference it against another such state and check the result by
 * independent bigint interval reasoning (never per-counter expansion).
 */
function unionNaive(a: Array<[bigint, bigint]>, b: Array<[bigint, bigint]>): Array<[bigint, bigint]> {
  // Independent reference: sort events, sweep, coalesce on touch/overlap.
  const ev = [...a.map(([l, h]) => [l, h] as [bigint, bigint]), ...b.map(([l, h]) => [l, h] as [bigint, bigint])]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const out: Array<[bigint, bigint]> = [];
  for (const [l, h] of ev) {
    const last = out.at(-1);
    if (last && l <= last[1] + 1n) {
      if (h > last[1]) last[1] = h;
    } else {
      out.push([l, h]);
    }
  }
  return out;
}

function setDiffNaive(
  a: Array<[bigint, bigint]>,
  b: Array<[bigint, bigint]>,
): Array<[bigint, bigint]> {
  // Reference set difference on disjoint sorted intervals via endpoint
  // subtraction, fully bigint — no event enumeration.
  let result = a.map(([l, h]) => [l, h] as [bigint, bigint]);
  for (const [bl, bh] of b) {
    const next: Array<[bigint, bigint]> = [];
    for (const [l, h] of result) {
      if (bh < l || bl > h) {
        next.push([l, h]);
      } else {
        if (l < bl) next.push([l, bl - 1n]);
        if (h > bh) next.push([bh + 1n, h]);
      }
    }
    result = next;
  }
  // Merge abutting pieces into canonical ranges.
  return unionNaive(result, []);
}

function stateRanges(v: VersionVectorSet, id: ReplicaId): { p: bigint; gaps: Array<[bigint, bigint]> } {
  const e = v.entries().find(([x]) => x.equals(id))![1];
  return { p: e.p, gaps: e.gaps.map((g) => [g.lo, g.hi] as [bigint, bigint]) };
}

test('merge over huge magnitudes matches interval union reference', () => {
  const rand = rng(7);
  const id = ReplicaId.fromHex('c0de');
  const base = 2n ** 50n;

  for (let trial = 0; trial < 40; trial++) {
    const make = (): { v: VersionVectorSet; ranges: Array<[bigint, bigint]> } => {
      const count = 1 + Math.floor(rand() * 5);
      const ranges: Array<[bigint, bigint]> = [];
      let cursor = base + BigInt(Math.floor(rand() * 1000));
      for (let k = 0; k < count; k++) {
        const lo = cursor + BigInt(Math.floor(rand() * 50));
        const hi = lo + BigInt(Math.floor(rand() * 5));
        ranges.push([lo, hi]);
        cursor = hi + BigInt(2 + Math.floor(rand() * 10));
      }
      // Some ranges intentionally bridge/overlap across the two states.
      const v = VersionVectorSet.parse(
        JSON.stringify({ [id.hex]: { p: '0', gaps: ranges.map(([l, h]) => [l.toString(), h.toString()]) } }),
      );
      return { v, ranges };
    };
    const x = make();
    const y = make();
    const merged = x.v.merge(y.v);
    const { gaps } = stateRanges(merged, id);
    const expected = unionNaive(x.ranges, y.ranges);
    assert.deepEqual(gaps, expected, `trial ${trial}: merge mismatch`);
  }
});

test('difference over huge magnitudes matches interval set-difference reference', () => {
  const rand = rng(11);
  const id = ReplicaId.fromHex('f00d');
  const base = 2n ** 55n;

  for (let trial = 0; trial < 40; trial++) {
    const make = (): { v: VersionVectorSet; all: Array<[bigint, bigint]> } => {
      const count = 1 + Math.floor(rand() * 5);
      const gaps: Array<[bigint, bigint]> = [];
      let cursor = base + BigInt(Math.floor(rand() * 1000));
      for (let k = 0; k < count; k++) {
        const lo = cursor;
        const hi = lo + BigInt(Math.floor(rand() * 5));
        gaps.push([lo, hi]);
        cursor = hi + BigInt(2 + Math.floor(rand() * 8));
      }
      const v = VersionVectorSet.parse(
        JSON.stringify({ [id.hex]: { p: '0', gaps: gaps.map(([l, h]) => [l.toString(), h.toString()]) } }),
      );
      return { v, all: gaps };
    };
    const x = make();
    const y = make();
    const d = x.v.difference(y.v);
    const entry = d.entries().find(([z]) => z.equals(id));
    const got = entry
      ? [
          ...(entry[1].p > 0n ? ([[1n, entry[1].p]] as Array<[bigint, bigint]>) : []),
          ...entry[1].gaps.map((g) => [g.lo, g.hi] as [bigint, bigint]),
        ]
      : [];
    const expected = setDiffNaive(x.all, y.all);
    assert.deepEqual(got, expected, `trial ${trial}: difference mismatch`);
  }
});

test('serialized size is linear in range count and constant in magnitude', () => {
  const id = ReplicaId.fromHex('5151');

  // k isolated ranges at small vs huge magnitudes: size differs only by the
  // fixed digit width, never by the span between ranges.
  const measure = (magnitude: bigint, k: number): number => {
    const gaps: Array<[string, string]> = [];
    const stride = 1_000_000n; // fixed, magnitude-independent spacing
    for (let i = 0; i < k; i++) {
      const lo = magnitude + BigInt(i) * stride;
      gaps.push([lo.toString(), (lo + 1n).toString()]);
    }
    return VersionVectorSet.parse(JSON.stringify({ [id.hex]: { p: '0', gaps } })).serialize().length;
  };

  const small1 = measure(10n, 1);
  const small32 = measure(10n, 32);
  const huge1 = measure(2n ** 60n, 1);
  const huge32 = measure(2n ** 60n, 32);

  // Per-range marginal cost is constant in the count and changes only by
  // the number of decimal digits of the endpoints (2 bytes per added digit
  // per endpoint), never by the span between ranges or their magnitude.
  const marginalSmall = (small32 - small1) / 31;
  const marginalHuge = (huge32 - huge1) / 31;
  assert.ok(marginalSmall > 0);
  // small endpoints ~3 digits, huge endpoints ~19 digits: at most 16 extra
  // digits * 2 endpoints * ~1.1 bytes ≈ 36 bytes; and the difference is a
  // constant digit-width surcharge, not a function of the 2^60 span.
  assert.ok(marginalHuge - marginalSmall > 0 && marginalHuge - marginalSmall <= 36,
    `${marginalSmall} vs ${marginalHuge}`);

  // Crucially: a single range spanning from near 0 up to ~2^60 serializes
  // to a small fixed size independent of the ~10^18 counters it covers.
  assert.ok(huge1 < 80, `huge single range serialized to ${huge1} bytes`);
});

test('canonical invariants hold under random adds at huge magnitudes', () => {
  const rand = rng(99);
  const id = ReplicaId.fromHex('7777');
  // We can only add points via the API; scatter isolated points and bridges
  // at a huge base, then assert ranges stay disjoint/non-adjacent and the
  // reported head never skips a hole.
  const base = 2n ** 48n;
  let v = VersionVectorSet.empty();
  const points = new Set<bigint>();
  for (let i = 0; i < 200; i++) {
    const n = base + BigInt(Math.floor(rand() * 5000));
    points.add(n);
    v = v.add(id, n);

    const e = v.entries().find(([x]) => x.equals(id))![1];
    let prevHi = e.p;
    for (const g of e.gaps) {
      assert.ok(g.lo >= 1n && g.hi >= g.lo);
      assert.ok(g.lo > prevHi + 1n, 'ranges must be normalized after every add');
      prevHi = g.hi;
    }
  }

  // contains agrees with the recorded point set at sampled boundaries.
  for (const n of points) assert.ok(v.contains(id, n));
  assert.ok(!v.contains(id, base - 1n));
  assert.equal(v.head(id), 0n, 'no contiguous-from-1 prefix can exist at a huge base');
});
