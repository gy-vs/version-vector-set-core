"use module";

import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionVector, MAX_COUNTER } from "../src/index.js";

const A = new Uint8Array([0xaa]);
const B = new Uint8Array([0xbb]);

test("memory scales with interval count, not maximum counter", () => {
  // Two vectors with the SAME number of discrete intervals, but one places
  // them up near 2^64 while the other keeps them tiny. Structural size,
  // segment count and serialized size must be essentially identical.
  const N = 2000;
  const small = new VersionVector();
  const huge = new VersionVector();
  for (let i = 0; i < N; i++) {
    // separated by one-missing-counter so they stay discrete
    const s = 2n + BigInt(i) * 3n; // 2,5,8,...
    small.add(A, s);
    const h = MAX_COUNTER - BigInt(i) * 3n; // descending adds exercise insertion
    huge.add(B, h);
  }
  assert.equal(small.segmentsOf(A).length, N);
  assert.equal(huge.segmentsOf(B).length, N);

  const sJson = small.serialize();
  const hJson = huge.serialize();
  // Size is O(number of intervals); decimal width of the counters only adds
  // a constant factor (max 20 chars vs ~4), independent of the 2^64 gap.
  assert.ok(
    hJson.length < sJson.length * 4,
    `serialized sizes diverge: ${sJson.length} vs ${hJson.length}`,
  );
  // each segment stays a single tuple regardless of gap size
  const hParsed = JSON.parse(hJson);
  assert.equal(hParsed.entries[0].segments.length, N);

  // contains() stays logarithmic on a huge sparse vector
  const start = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    const n = MAX_COUNTER - BigInt((i * 7) % N) * 3n;
    assert.equal(huge.contains(B, n), true);
    assert.equal(huge.contains(B, n - 1n), false); // the deliberately missing counter
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(ms < 200, `2000 contains() probes took ${ms}ms`);
});

test("prefix+1 segment stays one segment even as the gap spans 2^64", () => {
  const v = new VersionVector();
  v.addRange(A, 1n, 1_000_000n);
  v.add(A, MAX_COUNTER);
  assert.equal(v.prefixOf(A), 1_000_000n);
  assert.deepEqual(v.segmentsOf(A), [[MAX_COUNTER, MAX_COUNTER]]);
  assert.ok(v.contains(A, MAX_COUNTER));
  assert.ok(!v.contains(A, 1_000_001n));

  const json = v.serialize();
  assert.ok(json.length < 200, `giant gap vector serialized to ${json.length} bytes`);
});

test("difference never expands events: timings over giant sparse data", () => {
  const local = new VersionVector();
  const remote = new VersionVector();
  const M = 10_000;
  for (let i = 0; i < M; i++) {
    const base = (1n << 50n) + BigInt(i) * 100n;
    local.addRange(A, base, base + 10n);
    if (i % 2 === 0) remote.addRange(A, base, base + 10n); // half already present
  }
  local.addRange(B, 1n, MAX_COUNTER); // entire 64-bit stream known locally...
  remote.addRange(B, 1n, 10n); // ...remote has only the start

  const t0 = process.hrtime.bigint();
  const diff = local.difference(remote);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, `difference of ${M} intervals took ${ms}ms`);

  const entries = new Map([...diff].map((e) => [Buffer.from(e.id).toString("hex"), e.segments]));
  // B: everything remote lacks is one structural range, not 2^64 tuples
  assert.deepEqual(entries.get("bb"), [[11n, MAX_COUNTER]]);
  // A: exactly the odd-indexed ranges, still M/2 tuples
  assert.equal(entries.get("aa")!.length, M / 2);

  // requests truncate the giant B gap into bounded chunks: 5,000 A requests
  // then 1,000 chunks of B fill the 6,000-request page
  const page = diff.page(10_000n, 6000);
  assert.equal(page.requests.length, 6000);
  for (const r of page.requests) assert.ok(r.to - r.from + 1n <= 10_000n);
  const firstB = page.requests[5000]!;
  assert.equal(Buffer.from(firstB.id).toString("hex"), "bb");
  assert.deepEqual([firstB.from, firstB.to], [11n, 10_010n]);
  assert.notEqual(page.cursor, null);
});

test("merge of giant vectors is interval-based", () => {
  const a = new VersionVector();
  const b = new VersionVector();
  const M = 5_000;
  for (let i = 0; i < M; i++) {
    const x = (1n << 40n) + BigInt(i) * 7n;
    a.add(A, x);
    b.add(A, x + 1n); // adjacent -> must collapse on merge
  }
  const t0 = process.hrtime.bigint();
  a.merge(b);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `merge took ${ms}ms`);
  // every (7k, 7k+1) pair merges into one segment
  assert.equal(a.segmentsOf(A).length, M);
  const segs = a.segmentsOf(A);
  for (const [lo, hi] of segs.slice(0, 50)) assert.equal(hi - lo, 1n);
});

test("many disjoint gaps remain many segments (honest accounting)", () => {
  const v = new VersionVector();
  for (let n = 2n; n <= 100n; n += 2n) v.add(A, n); // evens only
  assert.equal(v.prefixOf(A), 0n);
  assert.equal(v.segmentsOf(A).length, 50);
  v.add(A, 1n);
  assert.equal(v.prefixOf(A), 2n);
  assert.equal(v.segmentsOf(A).length, 49);
  v.addRange(A, 3n, 99n); // bridge the rest
  assert.equal(v.prefixOf(A), 100n);
  assert.deepEqual(v.segmentsOf(A), []);
});
