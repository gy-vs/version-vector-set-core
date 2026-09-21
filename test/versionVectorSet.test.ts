import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VersionVectorSet,
  VersionVectorError,
  ReplicaId,
  MAX_COUNTER,
} from '../src/index.js';
import { ids } from './helpers.js';

// ---------------------------------------------------------------------------
// 1. Duplicate events and basic contains
// ---------------------------------------------------------------------------
test('duplicate events are idempotent and do not grow structure', () => {
  let v = VersionVectorSet.empty();
  v = v.add(ids.a, 5n).add(ids.a, 5n).add(ids.a, 5n);
  assert.equal(v.head(ids.a), 0n);
  assert.equal(v.gapCount(ids.a), 1);
  assert.ok(v.contains(ids.a, 5n));
  assert.ok(!v.contains(ids.a, 4n));
  assert.ok(!v.contains(ids.a, 6n));
  assert.ok(!v.contains(ids.b, 1n));
  assert.ok(!v.contains(ids.a, 0n));

  // Re-adding the same point returns the same instance (no new structure).
  const before = v.serialize();
  const again = v.add(ids.a, 5n);
  assert.equal(again, v);
  assert.equal(again.serialize(), before);
});

// ---------------------------------------------------------------------------
// 2. Huge gaps: magnitude must not cost memory or time
// ---------------------------------------------------------------------------
test('huge gaps are represented as constant-size ranges', () => {
  const big = 1n << 60n;
  let v = VersionVectorSet.empty();
  v = v.add(ids.a, big).add(ids.a, big + 1000n);
  assert.equal(v.gapCount(ids.a), 2);
  assert.ok(v.contains(ids.a, big));
  assert.ok(v.contains(ids.a, big + 1000n));
  assert.ok(!v.contains(ids.a, big - 1n));
  assert.ok(!v.contains(ids.a, big + 1n));
  assert.ok(!v.contains(ids.a, big + 999n));

  // difference across the gap is one range, not 10^18 events
  const peer = VersionVectorSet.empty().add(ids.a, 1n);
  const d = v.difference(peer);
  const entry = d.entries().find(([id]) => id.equals(ids.a))![1];
  assert.equal(entry.p, 0n);
  assert.deepEqual(entry.gaps, [
    { lo: big, hi: big },
    { lo: big + 1000n, hi: big + 1000n },
  ]);

  assert.throws(
    () => v.add(ids.a, MAX_COUNTER + 1n),
    (e: unknown) => e instanceof VersionVectorError && e.code === 'COUNTER_OUT_OF_BOUNDS',
  );
});

// ---------------------------------------------------------------------------
// 3. Bridges normalize ranges and advance the contiguous prefix
// ---------------------------------------------------------------------------
test('bridging a gap coalesces ranges and advances the prefix', () => {
  // prefix=1, gaps [3], [5,6]; observing 2 bridges prefix to [3], then
  // observing 4 bridges everything to 6.
  let v = VersionVectorSet.empty()
    .add(ids.a, 1n)
    .add(ids.a, 3n)
    .add(ids.a, 5n)
    .add(ids.a, 6n);
  assert.equal(v.head(ids.a), 1n);
  assert.equal(v.gapCount(ids.a), 2);

  v = v.add(ids.a, 2n);
  assert.equal(v.head(ids.a), 3n);
  assert.equal(v.gapCount(ids.a), 1);

  v = v.add(ids.a, 4n);
  assert.equal(v.head(ids.a), 6n);
  assert.equal(v.gapCount(ids.a), 0);
  for (let n = 1; n <= 6; n++) assert.ok(v.contains(ids.a, BigInt(n)));
});

test('one event bridges multiple disjoint ranges at once', () => {
  // prefix=1, gaps 3,4,5; add 2 => head advances straight to 5
  let v = VersionVectorSet.empty();
  for (const n of [1n, 3n, 4n, 5n]) v = v.add(ids.a, n);
  v = v.add(ids.a, 2n);
  assert.equal(v.head(ids.a), 5n);
  assert.equal(v.gapCount(ids.a), 0);
});

// ---------------------------------------------------------------------------
// 4. Different add orders converge to the same canonical serialization
// ---------------------------------------------------------------------------
test('add order does not affect canonical state or serialization', () => {
  const orderA = [1n, 5n, 2n, 9n, 8n, 3n];
  const orderB = [9n, 8n, 5n, 3n, 2n, 1n];
  const orderC = [3n, 1n, 8n, 2n, 5n, 9n];

  const build = (xs: bigint[]) => xs.reduce((v, n) => v.add(ids.a, n), VersionVectorSet.empty());
  const va = build(orderA);
  const vb = build(orderB);
  const vc = build(orderC);

  assert.equal(va.serialize(), vb.serialize());
  assert.equal(vb.serialize(), vc.serialize());
  assert.equal(va.head(ids.a), 3n);
  assert.deepEqual(va.entries()[0]![1].gaps, [
    { lo: 5n, hi: 5n },
    { lo: 8n, hi: 9n },
  ]);
});

// ---------------------------------------------------------------------------
// 5. Three-way merge: associative, commutative, idempotent
// ---------------------------------------------------------------------------
test('three-way merge converges regardless of merge order', () => {
  const mk = (id: typeof ids.a, xs: bigint[]) =>
    xs.reduce((v, n) => v.add(id, n), VersionVectorSet.empty());

  const r1 = mk(ids.a, [1n, 2n, 10n]);
  const r2 = mk(ids.a, [2n, 3n, 11n]).merge(mk(ids.b, [1n, 7n]));
  const r3 = mk(ids.a, [3n, 4n, 10n, 12n]).merge(mk(ids.b, [1n, 2n, 7n]));

  const m1 = r1.merge(r2).merge(r3);
  const m2 = r3.merge(r1).merge(r2);
  const m3 = r2.merge(r3).merge(r1);
  assert.equal(m1.serialize(), m2.serialize());
  assert.equal(m2.serialize(), m3.serialize());

  // a: prefix 1..4 (2 and 3 arrive via the merge and fold into the head),
  // gap 10..12 ; b: prefix 1..2, gap 7
  const a = m1.entries().find(([id]) => id.equals(ids.a))![1];
  const b = m1.entries().find(([id]) => id.equals(ids.b))![1];
  assert.equal(a.p, 4n);
  assert.deepEqual(a.gaps, [{ lo: 10n, hi: 12n }]);
  assert.equal(b.p, 2n);
  assert.deepEqual(b.gaps, [{ lo: 7n, hi: 7n }]);

  // idempotent + absorbing merge
  assert.equal(m1.merge(m1).serialize(), m1.serialize());
  assert.equal(VersionVectorSet.empty().merge(m1).serialize(), m1.serialize());

  for (const n of [1, 2, 3, 4, 10, 11, 12]) assert.ok(m1.contains(ids.a, BigInt(n)));
  assert.ok(!m1.contains(ids.a, 5n));
  assert.ok(!m1.contains(ids.a, 9n));
});

// ---------------------------------------------------------------------------
// 6. Deterministic serialization / parse round trips, corrupted input
// ---------------------------------------------------------------------------
test('serialize is deterministic and parse round-trips', () => {
  const v = VersionVectorSet.empty()
    .add(ids.b, 2n)
    .add(ids.a, 7n)
    .add(ids.a, 1n)
    .add(ids.d, 3n);
  const text = v.serialize();
  // replica ids sorted by unsigned byte order: 00ff < aaaa < bbbb
  assert.ok(text.startsWith('{"00ff"'), text);
  const ia = text.indexOf('"aaaa"');
  const ib = text.indexOf('"bbbb"');
  assert.ok(ia >= 0 && ib >= 0 && ia < ib, text);
  const back = VersionVectorSet.parse(text);
  assert.equal(back.serialize(), text);
  assert.ok(back.contains(ReplicaId.fromHex('00ff'), 3n));
});

const badPayloads: Array<[string, string, string]> = [
  ['not json', 'BAD_WIRE_FORMAT', ''],
  ['[]', 'BAD_WIRE_FORMAT', ''],
  ['{"zzzz":1}', 'BAD_REPLICA_ID', 'non-hex id rejected at id parse'],
  ['{"aaaa":null}', 'BAD_WIRE_FORMAT', ''],
  ['{"aaaa":{"gaps":[]}}', 'BAD_COUNTER', 'missing p'],
  ['{"aaaa":{"p":1}}', 'BAD_COUNTER', 'numeric p'],
  ['{"aaaa":{"p":"1","gaps":{}}}', 'BAD_WIRE_FORMAT', 'gaps not an array'],
  ['{"aaaa":{"p":"x","gaps":[]}}', 'BAD_COUNTER', 'bad p'],
  ['{"aaaa":{"p":"-1","gaps":[]}}', 'BAD_COUNTER', 'negative p'],
  ['{"aaaa":{"p":"1","gaps":[[3,4]]}}', 'BAD_COUNTER', 'numeric pair'],
  ['{"aaaa":{"p":"1","gaps":[["3"]]}}', 'BAD_WIRE_FORMAT', 'short pair'],
  ['{"aaaa":{"p":"5","gaps":[["3","4"]]}}', 'RANGE_OVERLAPS_PREFIX', 'gap below prefix'],
  ['{"aaaa":{"p":"1","gaps":[["5","3"]]}}', 'RANGE_REVERSED', 'reversed range'],
  ['{"aaaa":{"p":"1","gaps":[["3","4"],["4","5"]]}}', 'RANGE_NOT_NORMALIZED', 'overlap'],
  ['{"aaaa":{"p":"1","gaps":[["3","3"],["4","5"]]}}', 'RANGE_NOT_NORMALIZED', 'adjacent ranges'],
  ['{"aaaa":{"p":"1","gaps":[["9","10"],["5","6"]]}}', 'RANGE_NOT_NORMALIZED', 'unsorted ranges'],
  ['{"aaaa":{"p":"18446744073709551616","gaps":[]}}', 'COUNTER_OUT_OF_BOUNDS', '> 2^64-1'],
  ['{"bbbb":{"p":"1","gaps":[]},"aaaa":{"p":"2","gaps":[]}}', 'BAD_WIRE_FORMAT', 'ids not sorted'],
];

test('parse rejects corrupted / non-canonical input with stable error codes', () => {
  for (const [payload, code, note] of badPayloads) {
    assert.throws(
      () => VersionVectorSet.parse(payload),
      (e: unknown) => e instanceof VersionVectorError && e.code === code,
      `expected ${code} for ${note}: ${payload}`,
    );
  }
});

test('add() rejects bad counter inputs', () => {
  const v = VersionVectorSet.empty();
  assert.throws(() => v.add(ids.a, 0), (e: unknown) => (e as VersionVectorError).code === 'BAD_COUNTER');
  assert.throws(() => v.add(ids.a, -1n), (e: unknown) => (e as VersionVectorError).code === 'BAD_COUNTER');
  assert.throws(() => v.add(ids.a, Number.MAX_SAFE_INTEGER + 1), (e: unknown) => e instanceof VersionVectorError);
  assert.throws(() => v.add(ids.a, '1.5'), (e: unknown) => (e as VersionVectorError).code === 'BAD_COUNTER');
  assert.throws(() => v.add(ids.a, '0x10'), (e: unknown) => (e as VersionVectorError).code === 'BAD_COUNTER');
});

// ---------------------------------------------------------------------------
// 7. Difference: range-based, direction-sensitive, never event-expanded
// ---------------------------------------------------------------------------
test('difference computes missing ranges without event expansion', () => {
  const local = VersionVectorSet.empty()
    .add(ids.a, 1n).add(ids.a, 2n).add(ids.a, 10n).add(ids.a, 11n).add(ids.a, 50n)
    .add(ids.b, 7n);
  const remote = VersionVectorSet.empty()
    .add(ids.a, 1n).add(ids.a, 10n)
    .add(ids.b, 7n).add(ids.b, 8n);

  const d = local.difference(remote);
  const a = d.entries().find(([id]) => id.equals(ids.a))![1];
  // a: local has 2, 11, 50; remote prefix is 1 with gap 10
  assert.equal(a.p, 0n);
  assert.deepEqual(a.gaps, [
    { lo: 2n, hi: 2n },
    { lo: 11n, hi: 11n },
    { lo: 50n, hi: 50n },
  ]);
  // b: local has only 7, remote has 7,8 => nothing
  assert.equal(d.entries().find(([id]) => id.equals(ids.b)), undefined);

  // reverse direction: remote only has 8 extra for b
  const rev = remote.difference(local);
  assert.equal(rev.entries().find(([id]) => id.equals(ids.a)), undefined);
  const b = rev.entries().find(([id]) => id.equals(ids.b))![1];
  assert.deepEqual(b.gaps, [{ lo: 8n, hi: 8n }]);
});

test('difference with prefix-only states keeps the difference set honest', () => {
  const dense = (() => {
    let v = VersionVectorSet.empty();
    for (let n = 1n; n <= 100n; n++) v = v.add(ids.a, n);
    return v;
  })();
  const sparse = VersionVectorSet.empty().add(ids.a, 10n);
  const d = dense.difference(sparse);
  const e = d.entries()[0]![1];
  // Difference set is {1..9, 11..100}: the contiguous part through the
  // hole at 10 is canonical head=9, plus one gap. It never claims the
  // peer-owned counters, and head cannot skip over the missing 10.
  assert.equal(e.p, 9n);
  assert.deepEqual(e.gaps, [{ lo: 11n, hi: 100n }]);
  assert.ok(!d.contains(ids.a, 10n), 'difference must not contain peer-owned events');
  assert.ok(!d.contains(ids.a, 11n - 1n));
  assert.ok(d.contains(ids.a, 9n));
  assert.ok(d.contains(ids.a, 11n));
  assert.ok(d.contains(ids.a, 100n));

  // A.difference(A) is empty; difference of an empty local is empty.
  assert.equal(dense.difference(dense).entries().length, 0);
  assert.equal(VersionVectorSet.empty().difference(dense).entries().length, 0);
});
