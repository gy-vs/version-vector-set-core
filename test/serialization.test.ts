"use module";

import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionVector, VersionVectorError, parseHexId, MAX_COUNTER } from "../src/index.js";

const A = parseHexId("aa");

function expectCode(fn: () => unknown, code: string, msg?: string) {
  assert.throws(
    fn,
    (e: unknown) => e instanceof VersionVectorError && e.code === code,
    msg ?? `expected error code ${code}`,
  );
}

test("serialization is deterministic and round-trips", () => {
  const v = new VersionVector();
  v.addRange(parseHexId("cc"), 1n, 4n);
  v.add(parseHexId("aa"), 99n);
  v.addRange(parseHexId("aa"), 1n, 10n);
  v.add(parseHexId("bb"), 1n);
  const s1 = v.serialize();
  const s2 = VersionVector.decode(v.encode()).serialize();
  assert.equal(s1, s2);
  // canonical key/id order and decimal counters
  const parsed = JSON.parse(s1);
  assert.deepEqual(parsed, {
    version: 1,
    entries: [
      { id: "aa", prefix: "10", segments: [{ from: "99", to: "99" }] },
      { id: "bb", prefix: "1", segments: [] },
      { id: "cc", prefix: "4", segments: [] },
    ],
  });
  // decode from string
  const v3 = VersionVector.decode(s1);
  assert.equal(v3.serialize(), s1);
});

test("decode rejects malformed documents", () => {
  expectCode(() => VersionVector.decode("not json"), "bad-document");
  expectCode(() => VersionVector.decode(null), "bad-document");
  expectCode(() => VersionVector.decode([]), "bad-document");
  expectCode(() => VersionVector.decode(42), "bad-document");
  expectCode(() => VersionVector.decode({}), "bad-document");
  expectCode(() => VersionVector.decode({ version: 2, entries: [] }), "bad-document");
  expectCode(() => VersionVector.decode({ version: 1 }), "bad-document");
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [], extra: 1 }),
    "bad-document",
  );
  expectCode(() => VersionVector.decode({ version: 1, entries: [null] }), "bad-document");
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [{ id: "aa", prefix: "1", bogus: 0 }] }),
    "bad-document",
  );
});

test("decode rejects bad replica ids: malformed hex, empty, duplicate, unsorted", () => {
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [{ id: "zz", prefix: "1" }] }),
    "bad-id",
  );
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [{ id: "abc", prefix: "1" }] }),
    "bad-id",
  );
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [{ id: "", prefix: "1" }] }),
    "bad-id",
  );
  // duplicate
  expectCode(
    () =>
      VersionVector.decode({
        version: 1,
        entries: [
          { id: "aa", prefix: "1" },
          { id: "aa", prefix: "2" },
        ],
      }),
    "overlap",
  );
  // unsorted
  expectCode(
    () =>
      VersionVector.decode({
        version: 1,
        entries: [
          { id: "bb", prefix: "1" },
          { id: "aa", prefix: "1" },
        ],
      }),
    "overlap",
  );
});

test("decode rejects bad counters", () => {
  const good = (segments: unknown) => ({
    version: 1,
    entries: [{ id: "aa", prefix: "0", segments }],
  });
  expectCode(() => VersionVector.decode(good("nope")), "bad-document");
  expectCode(() => VersionVector.decode(good([{ from: "x", to: "2" }])), "bad-range");
  expectCode(() => VersionVector.decode(good([{ from: "2", to: "1" }])), "bad-range"); // reversed
  expectCode(() => VersionVector.decode(good([{ from: "0", to: "1" }])), "bad-range");
  expectCode(() => VersionVector.decode(good([{ from: "1", to: "18446744073709551616" }])), "bad-range");
  expectCode(
    () =>
      VersionVector.decode({
        version: 1,
        entries: [{ id: "aa", prefix: "18446744073709551616", segments: [] }],
      }),
    "bad-range",
  );
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [{ id: "aa", prefix: "-1", segments: [] }] }),
    "bad-range",
  );
  expectCode(
    () => VersionVector.decode({ version: 1, entries: [{ id: "aa", prefix: "01", segments: [] }] }),
    "bad-range",
  );
  // boundary is accepted
  const v = VersionVector.decode(
    good([{ from: MAX_COUNTER.toString(), to: MAX_COUNTER.toString() }]),
  );
  assert.ok(v.contains(A, MAX_COUNTER));
});

test("decode rejects overlapping, duplicated and out-of-order segments", () => {
  const doc = (segments: unknown, prefix = "0") => ({
    version: 1,
    entries: [{ id: "aa", prefix, segments }],
  });
  // duplicate point
  expectCode(() => VersionVector.decode(doc([{ from: "5", to: "5" }, { from: "5", to: "6" }])), "overlap");
  // overlap
  expectCode(() => VersionVector.decode(doc([{ from: "5", to: "10" }, { from: "9", to: "12" }])), "overlap");
  // reversed order
  expectCode(() => VersionVector.decode(doc([{ from: "20", to: "21" }, { from: "10", to: "11" }])), "overlap");
  // segment fully inside prefix
  expectCode(() => VersionVector.decode(doc([{ from: "2", to: "3" }], "5")), "overlap");
  // segment straddling the prefix overlaps it
  expectCode(() => VersionVector.decode(doc([{ from: "5", to: "7" }], "6")), "overlap");
  // segments wrong type
  expectCode(() => VersionVector.decode(doc([5])), "bad-document");
  expectCode(() => VersionVector.decode(doc([{ from: "1" }])), "bad-range");
});

test("decode normalizes adjacent ranges and folds segments into the prefix", () => {
  const doc = (segments: unknown, prefix = "0") => ({
    version: 1,
    entries: [{ id: "aa", prefix, segments }],
  });
  // adjacent discrete segments merge into one
  let v = VersionVector.decode(doc([{ from: "5", to: "6" }, { from: "7", to: "8" }]));
  assert.equal(v.prefixOf(A), 0n);
  assert.deepEqual(v.segmentsOf(A), [[5n, 8n]]);

  // a chain of adjacent ranges
  v = VersionVector.decode(doc([{ from: "10", to: "10" }, { from: "11", to: "20" }, { from: "21", to: "21" }]));
  assert.deepEqual(v.segmentsOf(A), [[10n, 21n]]);

  // touching the prefix folds the segment (and its neighbors) into it
  v = VersionVector.decode(doc([{ from: "6", to: "7" }, { from: "8", to: "9" }], "5"));
  assert.equal(v.prefixOf(A), 9n);
  assert.deepEqual(v.segmentsOf(A), []);

  // a genuine gap remains a gap: [7..8] after prefix 5, counter 6 missing
  v = VersionVector.decode(doc([{ from: "7", to: "8" }], "5"));
  assert.equal(v.prefixOf(A), 5n);
  assert.deepEqual(v.segmentsOf(A), [[7n, 8n]]);

  // normalization is canonical: re-encode round-trips byte-stable
  const reEncoded = v.serialize();
  assert.equal(VersionVector.decode(reEncoded).serialize(), reEncoded);
});

test("merge with corrupt document input throws", () => {
  const v = new VersionVector();
  expectCode(() => v.merge({ version: 9, entries: [] } as never), "bad-document");
  expectCode(
    () => v.merge({ version: 1, entries: [{ id: "aa", prefix: "0", segments: [{ from: "2", to: "1" }] }] }),
    "bad-range",
  );
});
