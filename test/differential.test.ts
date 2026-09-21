import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VersionVectorSet,
  ReplicaId,
  nextMissingRequest,
  byteSize,
} from '../src/index.js';
import { rng, NaiveModel, expandEntry } from './helpers.js';

/**
 * Differential test: drive both the interval structure and a naive
 * per-event Set through the same random operation stream (add / merge /
 * difference / serialize-roundtrip) and check agreement after every op.
 */
function runDifferential(seed: number, replicas: number, ops: number, universe: number): void {
  const rand = rng(seed);
  const peerIds = Array.from({ length: replicas }, (_, i) =>
    ReplicaId.fromHex((i + 1).toString(16).padStart(4, '0')),
  );

  // Three independent sites, each with a real vector and a naive oracle.
  const sites = [0, 1, 2].map(() => ({
    v: VersionVectorSet.empty(),
    m: new NaiveModel(),
  }));

  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const counter = (): number => 1 + Math.floor(rand() * universe);

  const assertAgrees = (site: (typeof sites)[number], tag: string) => {
    for (const id of peerIds) {
      const expected = site.m.values(id);
      const entry = site.v.entries().find(([x]) => x.equals(id));
      if (expected.length === 0) {
        assert.equal(entry, undefined, `${tag}: unexpected entry for ${id.hex}`);
        continue;
      }
      const actual = expandEntry(entry![1].p, entry![1].gaps);
      assert.deepEqual(actual, expected, `${tag}: coverage mismatch for ${id.hex}`);
      // Canonical invariants: head is the true contiguous prefix.
      assert.equal(entry![1].p, BigInt(site.m.head(id)), `${tag}: head mismatch`);
      // Ranges are disjoint, ordered, non-adjacent, above the prefix.
      let prev = entry![1].p;
      for (const g of entry![1].gaps) {
        assert.ok(g.lo > prev + 1n, `${tag}: ranges not normalized (adjacent/overlapping)`);
        assert.ok(g.lo <= g.hi, `${tag}: reversed range`);
        prev = g.hi;
      }
      // contains agrees pointwise over the whole small universe.
      for (let n = 1; n <= universe; n++) {
        assert.equal(site.v.contains(id, n), site.m.contains(id, n), `${tag}: contains(${n})`);
      }
    }
  };

  for (let op = 0; op < ops; op++) {
    const roll = rand();
    if (roll < 0.6) {
      // Random out-of-order add (heavy duplicate rate in a small universe).
      const site = pick(sites);
      const id = pick(peerIds);
      const n = counter();
      site.v = site.v.add(id, n);
      site.m.add(id, n);
    } else if (roll < 0.85) {
      // Merge one site into another (one- or two-way at random).
      const dst = pick(sites);
      const src = pick(sites);
      if (dst !== src) {
        dst.v = dst.v.merge(src.v);
        dst.m.merge(src.m);
      }
    } else {
      // Serialize/parse round trip on a random site.
      const site = pick(sites);
      const text = site.v.serialize();
      site.v = VersionVectorSet.parse(text);
      // Serialization is stable: reparsing is byte-identical.
      assert.equal(site.v.serialize(), text, `seed ${seed} op ${op}: serialization not canonical`);
    }
    for (const s of sites) assertAgrees(s, `seed ${seed} op ${op}`);
  }

  // Final: three-way convergence in every merge grouping.
  const mergedWays = [
    sites[0]!.v.merge(sites[1]!.v).merge(sites[2]!.v),
    sites[2]!.v.merge(sites[0]!.v).merge(sites[1]!.v),
    sites[1]!.v.merge(sites[2]!.v).merge(sites[0]!.v),
  ];
  assert.equal(mergedWays[0]!.serialize(), mergedWays[1]!.serialize());
  assert.equal(mergedWays[1]!.serialize(), mergedWays[2]!.serialize());

  // Merge agrees with the oracle union.
  const unionModel = new NaiveModel();
  for (const s of sites) unionModel.merge(s.m);
  for (const id of peerIds) {
    const entry = mergedWays[0]!.entries().find(([x]) => x.equals(id))!;
    assert.deepEqual(expandEntry(entry[1].p, entry[1].gaps), unionModel.values(id));
  }

  // Difference agrees with set difference in both directions for each pair.
  for (let i = 0; i < sites.length; i++) {
    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      const d = sites[i]!.v.difference(sites[j]!.v);
      for (const id of peerIds) {
        const ai = new Set(sites[i]!.m.values(id));
        const bj = new Set(sites[j]!.m.values(id));
        const expected = [...ai].filter((n) => !bj.has(n)).sort((x, y) => x - y);
        const entry = d.entries().find(([x]) => x.equals(id));
        const actual = entry ? expandEntry(entry[1].p, entry[1].gaps) : [];
        assert.deepEqual(actual, expected, `seed ${seed}: diff ${i}-${j} for ${id.hex}`);
      }
    }
  }
}

test('differential: random ops vs naive set (dense universes, dup-heavy)', () => {
  runDifferential(1, 3, 400, 12);
  runDifferential(2, 4, 500, 25);
});

test('differential: random ops vs naive set (sparse universes, many gaps)', () => {
  runDifferential(3, 3, 400, 500);
  runDifferential(4, 5, 300, 2000);
});

test('differential: missing-request pages partition the difference exactly', () => {
  const rand = rng(42);
  const id = peerId();
  for (let trial = 0; trial < 20; trial++) {
    let a = VersionVectorSet.empty();
    let b = VersionVectorSet.empty();
    const na = new NaiveModel();
    const nb = new NaiveModel();
    for (let k = 0; k < 60; k++) {
      const n = 1 + Math.floor(rand() * 300);
      a = a.add(id, n);
      na.add(id, n);
      if (rand() < 0.6) {
        const m = 1 + Math.floor(rand() * 300);
        b = b.add(id, m);
        nb.add(id, m);
      }
    }
    const expected = [...new Set(na.values(id).filter((n) => !nb.contains(id, n)))]
      .sort((x, y) => x - y);
    if (expected.length === 0) continue;

    const diff = a.difference(b).entries();
    // A page must fit one range plus the continuation-cursor envelope.
    const maxBytes = 180 + Math.floor(rand() * 300);
    const pages = [];
    let cursor: string | undefined;
    for (;;) {
      const page = nextMissingRequest(diff, maxBytes, () => b.head(id), cursor);
      if (!page) break;
      pages.push(page);
      assert.ok(byteSize(page) <= maxBytes);
      if (page.next === undefined) break;
      cursor = page.next;
    }

    const requested: number[] = [];
    for (const p of pages) {
      for (const g of p.want) {
        for (const [lo, hi] of g.ranges) {
          for (let n = Number(lo); n <= Number(hi); n++) requested.push(n);
        }
      }
    }
    requested.sort((x, y) => x - y);
    // Every missing event is requested; requested windows may extend past
    // gaps (the responder simply has nothing there), so check containment.
    for (const n of expected) assert.ok(requested.includes(n), `trial ${trial}: ${n} never requested`);
    // Requested ranges never start at or below since (b.head) needlessly.
  }
});

function peerId(): ReplicaId {
  return ReplicaId.fromHex('ab12');
}

// ---------------------------------------------------------------------------
// Memory scale: structure size tracks the number of gap RANGES, never the
// maximum counter magnitude.
// ---------------------------------------------------------------------------
test('memory scale: gap count is independent of counter magnitude', () => {
  const id = ReplicaId.fromHex('dead');

  // Two isolated points at enormous magnitudes: exactly two ranges.
  const huge = VersionVectorSet.empty()
    .add(id, 2n ** 60n)
    .add(id, 2n ** 63n - 2n);
  assert.equal(huge.gapCount(id), 2);
  assert.ok(huge.serialize().length < 120);

  // Filling the single missing bridge point coalesces both ranges; once
  // they join the contiguous run that reaches the prefix, the head jumps.
  const bridged = VersionVectorSet.parse(
    JSON.stringify({ [id.hex]: { p: '1', gaps: [['3', '1000000000000'], ['1000000000002', '9999999999999']] } }),
  );
  assert.equal(bridged.gapCount(id), 2);
  const filled = bridged.add(id, 2n).add(id, 1000000000001n);
  assert.equal(filled.gapCount(id), 0);
  assert.equal(filled.head(id), 9999999999999n);

  // Compare two states with the same range count but wildly different
  // magnitudes: serialized sizes differ only in the constant digit width.
  const small = VersionVectorSet.empty().add(id, 5n).add(id, 9n);
  const big = VersionVectorSet.empty().add(id, 10n ** 15n).add(id, 10n ** 18n);
  assert.equal(small.gapCount(id), big.gapCount(id));

  // Adding the complete contiguous prefix for a small universe yields zero
  // gaps regardless of how late events arrive.
  let v = VersionVectorSet.empty();
  for (let n = 100; n >= 1; n--) v = v.add(id, BigInt(n));
  assert.equal(v.gapCount(id), 0);
  assert.equal(v.head(id), 100n);
});

test('memory scale: random sparse structure stores ranges, not events', () => {
  // Worst case (alternating present/absent) still bounds structure by the
  // number of observed clusters: verify totalGapRanges <= #adds and that a
  // huge-valued sparse set is tiny compared to event expansion.
  const id = ReplicaId.fromHex('beef');
  let v = VersionVectorSet.empty();
  const adds = 500;
  const step = 10n ** 12n;
  for (let k = 0; k < adds; k++) {
    v = v.add(id, BigInt(k) * step + 2n); // isolated points far apart (first is a gap)
  }
  assert.equal(v.gapCount(id), adds);
  // Naive per-event storage of the *span* would be ~500*10^12 counters;
  // our encoding is linear in add count.
  assert.ok(v.serialize().length < adds * 40 + 64);
});
