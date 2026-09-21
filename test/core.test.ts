"use module";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VersionVector,
  VersionVectorError,
  compareBytes,
  parseHexId,
  MAX_COUNTER,
} from "../src/index.js";

const id = (hex: string) => parseHexId(hex);
const A = id("aa");
const B = id("bb");
const C = id("cc");

test("duplicate events are idempotent: add / addRange / merge", () => {
  const v = new VersionVector();
  v.add(A, 1n);
  v.add(A, 1n);
  v.addRange(A, 1n, 5n);
  v.add(A, 3n);
  v.addRange(A, 2n, 4n);
  assert.equal(v.prefixOf(A), 5n);
  assert.deepEqual(v.segmentsOf(A), []);

  const v2 = new VersionVector();
  v2.addRange(A, 1n, 5n);
  v.merge(v2);
  v2.merge(v);
  assert.equal(v2.prefixOf(A), 5n);
  assert.equal(v.serialize(), v2.serialize());
});

test("out-of-order arrival keeps prefix + discrete segments", () => {
  const v = new VersionVector();
  v.add(A, 10n);
  assert.equal(v.prefixOf(A), 0n);
  assert.deepEqual(v.segmentsOf(A), [[10n, 10n]]);
  v.add(A, 12n);
  v.add(A, 11n);
  // 10,11,12 arrive: still isolated above the 1..9 gap
  assert.equal(v.prefixOf(A), 0n);
  assert.deepEqual(v.segmentsOf(A), [[10n, 12n]]);
  assert.ok(v.contains(A, 10n) && v.contains(A, 12n));
  assert.ok(!v.contains(A, 1n) && !v.contains(A, 9n) && !v.contains(A, 13n));
});

test("filling the gap advances the contiguous prefix and absorbs segments", () => {
  const v = new VersionVector();
  v.add(A, 10n);
  v.add(A, 12n);
  v.add(A, 15n);
  assert.deepEqual(v.segmentsOf(A), [[10n, 10n], [12n, 12n], [15n, 15n]]);
  v.addRange(A, 1n, 9n); // closes the first gap; bridge eats [10]
  assert.equal(v.prefixOf(A), 10n);
  assert.deepEqual(v.segmentsOf(A), [[12n, 12n], [15n, 15n]]);
  v.add(A, 11n); // prefix bridges through [12]
  assert.equal(v.prefixOf(A), 12n);
  assert.deepEqual(v.segmentsOf(A), [[15n, 15n]]);
  v.addRange(A, 13n, 15n); // chain absorption
  assert.equal(v.prefixOf(A), 15n);
  assert.deepEqual(v.segmentsOf(A), []);
});

test("a single range bridges many segments in one add", () => {
  const v = new VersionVector();
  for (const n of [5n, 8n, 11n, 14n]) v.add(A, n);
  v.addRange(A, 1n, 20n);
  assert.equal(v.prefixOf(A), 20n);
  assert.deepEqual(v.segmentsOf(A), []);

  const w = new VersionVector();
  w.addRange(B, 10n, 12n);
  w.addRange(B, 20n, 22n);
  w.addRange(B, 30n, 32n);
  w.addRange(B, 13n, 29n); // bridges first two, leaves the last separated
  assert.equal(w.prefixOf(B), 0n);
  assert.deepEqual(w.segmentsOf(B), [[10n, 32n]]);
  w.addRange(B, 1n, 9n);
  assert.equal(w.prefixOf(B), 32n);
});

test("adjacent ranges always normalize; different add orders converge", () => {
  const sequences: Array<Array<[bigint, bigint]>> = [
    [[1n, 4n], [6n, 9n], [5n, 5n]],
    [[5n, 5n], [6n, 9n], [1n, 4n]],
    [[6n, 9n], [1n, 4n], [5n, 5n]],
    [[1n, 9n]],
  ];
  const canonical = new VersionVector();
  canonical.addRange(A, 1n, 9n);
  for (const seq of sequences) {
    const v = new VersionVector();
    for (const [lo, hi] of seq) v.addRange(A, lo, hi);
    assert.equal(
      v.serialize(),
      canonical.serialize(),
      `add order ${seq.map(([lo, hi]) => `${lo}..${hi}`).join(",")}`,
    );
    assert.equal(v.prefixOf(A), 9n);
    assert.deepEqual(v.segmentsOf(A), []);
  }

  // same for a non-contiguous shape: [1..3] [6..8]
  const shape1 = new VersionVector();
  shape1.addRange(A, 6n, 8n);
  shape1.addRange(A, 1n, 3n);
  const shape2 = new VersionVector();
  shape2.addRange(A, 2n, 3n);
  shape2.addRange(A, 6n, 7n);
  shape2.addRange(A, 8n, 8n);
  shape2.addRange(A, 1n, 1n);
  assert.equal(shape1.serialize(), shape2.serialize());
  assert.deepEqual(shape1.segmentsOf(A), [[6n, 8n]]);
  assert.equal(shape1.prefixOf(A), 3n);
});

test("contains across prefix, segments, unknown replicas and huge counters", () => {
  const v = new VersionVector();
  v.addRange(A, 1n, 100n);
  v.add(A, 1000n);
  assert.ok(v.contains(A, 1n));
  assert.ok(v.contains(A, 100n));
  assert.ok(v.contains(A, 1000n));
  assert.ok(!v.contains(A, 500n));
  assert.ok(!v.contains(A, 1001n));
  assert.ok(!v.contains(B, 1n));

  const huge = MAX_COUNTER;
  v.add(B, huge);
  assert.ok(v.contains(B, huge));
  assert.ok(!v.contains(B, huge - 1n));
});

test("three-way merge converges to the union regardless of merge topology", () => {
  const mk = (fills: Array<[Uint8Array, bigint, bigint]>) => {
    const v = new VersionVector();
    for (const [id, lo, hi] of fills) v.addRange(id, lo, hi);
    return v;
  };

  // Three replicas each saw disjoint overlapping pieces of A's stream.
  const r1 = mk([
    [A, 1n, 4n],
    [B, 1n, 2n],
  ]);
  const r2 = mk([
    [A, 3n, 8n],
    [B, 5n, 6n],
    [C, 1n, 1n],
  ]);
  const r3 = mk([
    [A, 10n, 12n],
    [B, 1n, 5n],
    [C, 2n, 2n],
  ]);

  const left = new VersionVector();
  left.merge(r1);
  left.merge(r2);
  left.merge(r3);

  const right = new VersionVector();
  right.merge(r3);
  right.merge(r1);
  right.merge(r2);

  const hub1 = new VersionVector();
  hub1.merge(r1);
  hub1.merge(r2);
  const hub2 = new VersionVector();
  hub2.merge(r3);
  const pair1 = new VersionVector();
  pair1.merge(hub1);
  pair1.merge(hub2);

  for (const merged of [left, right, pair1]) {
    // A: 1..8 + 10..12 (gap at 9)
    assert.equal(merged.prefixOf(A), 8n);
    assert.deepEqual(merged.segmentsOf(A), [[10n, 12n]]);
    // B: 1..6 contiguous
    assert.equal(merged.prefixOf(B), 6n);
    assert.deepEqual(merged.segmentsOf(B), []);
    // C: 1..2
    assert.equal(merged.prefixOf(C), 2n);
    assert.deepEqual(merged.segmentsOf(C), []);
  }
  assert.equal(left.serialize(), right.serialize());
  assert.equal(left.serialize(), pair1.serialize());
});

test("merge over serialized documents is order independent", () => {
  const x = new VersionVector();
  x.addRange(A, 1n, 10n);
  x.add(A, 20n);
  const doc = x.encode();

  const y1 = new VersionVector();
  y1.add(A, 15n);
  y1.merge(doc);
  const y2 = new VersionVector();
  y2.merge(doc);
  y2.add(A, 15n);
  assert.equal(y1.serialize(), y2.serialize());
  assert.deepEqual(y1.segmentsOf(A), [[15n, 15n], [20n, 20n]]);
});

test("difference is structural: giant gap is one range, not per-event", () => {
  const mine = new VersionVector();
  mine.addRange(A, 1n, 5n);
  mine.addRange(A, MAX_COUNTER - 2000n, MAX_COUNTER);
  const theirs = new VersionVector();
  theirs.addRange(A, 1n, 2n);

  const start = process.hrtime.bigint();
  const diff = mine.difference(theirs);
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsed < 50, `difference over 2^64 gap took ${elapsed}ms`);

  const entries = [...diff];
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.segments, [[3n, 5n], [MAX_COUNTER - 2000n, MAX_COUNTER]]);

  // Missing requests truncate the huge span at the 64-bit boundary.
  // 2001 counters split at 1000 wide => three chunks (1000 + 1000 + 1),
  // plus the small first range = 4 requests total.
  const page = diff.page(1000n, 10);
  assert.equal(page.requests.length, 4);
  assert.deepEqual(page.requests[0], { id: A, from: 3n, to: 5n });
  assert.deepEqual(page.requests[1], {
    id: A,
    from: MAX_COUNTER - 2000n,
    to: MAX_COUNTER - 1001n,
  });
  assert.deepEqual(page.requests[2], {
    id: A,
    from: MAX_COUNTER - 1000n,
    to: MAX_COUNTER - 1n,
  });
  assert.deepEqual(page.requests[3], { id: A, from: MAX_COUNTER, to: MAX_COUNTER });
  assert.equal(page.cursor, null);
  assert.deepEqual(diff.allRequests(1000n), page.requests);

  // with a tighter page cap, a cursor resumes in canonical order
  const p1 = diff.page(1000n, 2);
  assert.deepEqual(p1.requests, [page.requests[0], page.requests[1]]);
  assert.notEqual(p1.cursor, null);
  const p2 = diff.page(1000n, 2, p1.cursor);
  assert.deepEqual(p2.requests, [page.requests[2], page.requests[3]]);
  assert.notEqual(p2.cursor, null);
  // page filled exactly at the last segment boundary: one empty final page
  // drains the boundary cursor (stable resume protocol), then null
  const p3 = diff.page(1000n, 2, p2.cursor);
  assert.deepEqual(p3.requests, []);
  assert.equal(p3.cursor, null);
});

test("difference covers whole-unknown replica and prefix-vs-segment cases", () => {
  const mine = new VersionVector();
  mine.add(A, 1n);
  mine.add(B, 7n);
  mine.addRange(B, 1n, 3n);
  mine.add(C, 50n);
  const theirs = new VersionVector();
  theirs.addRange(B, 1n, 2n);
  theirs.addRange(C, 1n, 60n); // peer knows more of C => nothing of C in diff

  const diff = mine.difference(theirs);
  const got = new Map<string, Array<[bigint, bigint]>>();
  for (const e of diff) {
    got.set(Buffer.from(e.id).toString("hex"), e.segments.map((s) => [s[0], s[1]]));
  }
  assert.deepEqual(got.get("aa"), [[1n, 1n]]);
  assert.deepEqual(got.get("bb"), [[3n, 3n], [7n, 7n]]);
  assert.equal(got.has("cc"), false);
  assert.ok(!diff.contains(C, 50n));
  assert.ok(diff.contains(B, 7n));
});

test("missing-request pagination truncates and resumes exactly once per counter", () => {
  const v = new VersionVector();
  v.addRange(A, 1n, 5n);
  v.addRange(B, 100n, 105n);
  v.addRange(C, 1000n, 1000n);
  const empty = new VersionVector();
  const diff = v.difference(empty);

  const all = diff.allRequests(2n); // maxSpan 2 => 3 + 3 + 1 = 7 requests
  assert.equal(all.length, 7);
  for (const r of all) assert.ok(r.to - r.from + 1n <= 2n);
  // canonical ordering: aa..., bb..., cc...
  const ids = all.map((r) => Buffer.from(r.id).toString("hex"));
  assert.deepEqual(ids, ["aa", "aa", "aa", "bb", "bb", "bb", "cc"]);

  // page() with maxRequests truncates and the cursor resumes without gaps or
  // duplicates, even when a page fills exactly at a segment boundary.
  const drained: typeof all = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p = diff.page(2n, 2, cursor);
    drained.push(...p.requests);
    cursor = p.cursor;
    pages++;
  } while (cursor !== null);
  assert.equal(drained.length, 7);
  assert.equal(pages, 4);
  assert.deepEqual(drained, all);
});

test("corrupted cursors are rejected", () => {
  const v = new VersionVector();
  v.add(A, 1n);
  const diff = v.difference(new VersionVector());
  assert.throws(() => diff.page(1n, 1, "not-base64!!!"), (e: Error) => {
    return e instanceof VersionVectorError && e.code === "bad-cursor";
  });
  const bogus = Buffer.from(JSON.stringify({ e: 0, s: 99, f: "1" })).toString("base64url");
  assert.throws(() => diff.page(1n, 1, bogus), (e: Error) => {
    return e instanceof VersionVectorError && e.code === "bad-cursor";
  });
});

test("binary ids are stable byte identities and copies are defensive", () => {
  const raw = new Uint8Array([0x00, 0xff, 0x10]);
  const v = new VersionVector();
  v.add(raw, 1n);
  raw[0] = 0x7f; // mutate caller's buffer after the fact
  assert.ok(v.contains(new Uint8Array([0x00, 0xff, 0x10]), 1n));
  assert.ok(!v.contains(new Uint8Array([0x7f, 0xff, 0x10]), 1n));

  // byte-wise ordering: 00.. sorts before 01..; hex canonical strings preserve it
  const v2 = new VersionVector();
  v2.add(new Uint8Array([0x02]), 1n);
  v2.add(new Uint8Array([0x00, 0x00]), 1n);
  v2.add(new Uint8Array([0x00]), 1n);
  const ids = v2.encode().entries.map((e) => e.id);
  assert.deepEqual(ids, ["00", "0000", "02"]);
  assert.ok(compareBytes(new Uint8Array([0x00, 0xff]), new Uint8Array([0x01])) < 0);
});

test("bad arguments throw typed errors", () => {
  const v = new VersionVector();
  assert.throws(
    () => v.add(new Uint8Array(), 1n),
    (e: Error) => e instanceof VersionVectorError && e.code === "bad-id",
  );
  assert.throws(() => v.add(A, 0n), /out of range/);
  assert.throws(() => v.add(A, MAX_COUNTER + 1n), /out of range/);
  assert.throws(() => v.addRange(A, 5n, 4n), /lo 5 > hi 4/);
  // @ts-expect-error runtime type guard
  assert.throws(() => v.add(A, 5), /must be a bigint/);
  assert.throws(
    () => diffPageBad(v),
    (e: Error) => e instanceof VersionVectorError && e.code === "bad-range",
  );
});

function diffPageBad(v: VersionVector) {
  return v.difference(new VersionVector()).page(0n);
}
