"use module";

import { test } from "node:test";
import assert from "node:assert/strict";
import { VersionVector, VectorDiff, parseHexId } from "../src/index.js";

/** Reference model: honest per-event Set of "idHex:counter" keys. */
class NaiveVector {
  readonly seen = new Set<string>();
  add(idHex: string, n: bigint) {
    this.seen.add(`${idHex}:${n.toString()}`);
  }
  addRange(idHex: string, lo: bigint, hi: bigint) {
    for (let n = lo; n <= hi; n++) this.add(idHex, n);
  }
  has(idHex: string, n: bigint) {
    return this.seen.has(`${idHex}:${n.toString()}`);
  }
  merge(other: NaiveVector) {
    for (const k of other.seen) this.seen.add(k);
  }
  diff(other: NaiveVector): Set<string> {
    const out = new Set<string>();
    for (const k of this.seen) if (!other.seen.has(k)) out.add(k);
    return out;
  }
}

/** Deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPLICAS = ["aa", "bb", "cc", "01ff", "7e"];
const SMALL_MAX = 25n; // dense space so bridges/overlaps happen often

/** Structural invariants that must hold for every entry, at all times. */
function assertInvariants(v: VersionVector, model: NaiveVector) {
  let entryCount = 0;
  for (const idHex of new Set(REPLICAS)) {
    if (![...model.seen].some((k) => k.startsWith(`${idHex}:`))) {
      assert.equal(v.prefixOf(parseHexId(idHex)), 0n);
      continue;
    }
    entryCount++;
    const id = parseHexId(idHex);
    const prefix = v.prefixOf(id);
    let expected = 0n;
    for (let n = 1n; n <= SMALL_MAX + 5n; n++) {
      if (model.has(idHex, n)) expected = n;
      else break;
    }
    assert.equal(prefix, expected, `prefix mismatch for ${idHex}`);

    const segs = v.segmentsOf(id);
    let prevHi = prefix;
    for (const [lo, hi] of segs) {
      assert.ok(lo <= hi, "segment reversed");
      assert.ok(lo > prevHi + 1n, `segments not separated by a gap: ${lo} after ${prevHi}`);
      for (let n = lo; n <= hi; n++) assert.ok(model.has(idHex, n), `phantom event ${idHex}:${n}`);
      assert.ok(!model.has(idHex, lo - 1n), `unmerged adjacency below ${lo}`);
      if (hi + 1n <= SMALL_MAX + 5n) assert.ok(!model.has(idHex, hi + 1n), `unmerged adjacency above ${hi}`);
      prevHi = hi;
    }

    // Exact agreement with the naive model over the whole probe window.
    for (let n = 1n; n <= SMALL_MAX + 5n; n++) {
      assert.equal(v.contains(id, n), model.has(idHex, n), `contains ${idHex}:${n}`);
    }
  }
  assert.equal(v.size, entryCount);

  // Canonical serialization round-trips byte-for-byte.
  assert.equal(VersionVector.decode(v.serialize()).serialize(), v.serialize());
}

function diffToKeys(diff: VectorDiff): Set<string> {
  const out = new Set<string>();
  for (const e of diff) {
    const hex = Buffer.from(e.id).toString("hex");
    for (const [lo, hi] of e.segments) for (let n = lo; n <= hi; n++) out.add(`${hex}:${n}`);
  }
  return out;
}

test("randomized operations match the naive per-event set", () => {
  const TRIALS = 250;
  const OPS = 80;
  for (let t = 0; t < TRIALS; t++) {
    const rand = mulberry32(0x9e3779b9 + t * 2654435761);
    // three receiving replicas, each a structural vector + its naive truth
    const structs = [new VersionVector(), new VersionVector(), new VersionVector()] as const;
    const naives = [new NaiveVector(), new NaiveVector(), new NaiveVector()] as const;
    // global source of truth = union of what any replica produced
    const origin = new NaiveVector();

    const pick = <X,>(arr: readonly X[]): X => arr[Math.floor(rand() * arr.length)]!;
    const bi = (n: number) => BigInt(n);

    for (let op = 0; op < OPS; op++) {
      const roll = rand();
      if (roll < 0.65) {
        const idHex = pick(REPLICAS);
        const target = Math.floor(rand() * 3);
        if (rand() < 0.75) {
          const n = bi(1 + Math.floor(rand() * Number(SMALL_MAX)));
          structs[target]!.add(parseHexId(idHex), n);
          naives[target]!.add(idHex, n);
          origin.add(idHex, n);
        } else {
          const a = bi(1 + Math.floor(rand() * Number(SMALL_MAX)));
          const b = bi(1 + Math.floor(rand() * Number(SMALL_MAX)));
          structs[target]!.addRange(parseHexId(idHex), a < b ? a : b, a < b ? b : a);
          naives[target]!.addRange(idHex, a < b ? a : b, a < b ? b : a);
          for (let n = a < b ? a : b; n <= (a < b ? b : a); n++) origin.add(idHex, n);
        }
      } else if (roll < 0.9) {
        // sync one replica into another
        const from = Math.floor(rand() * 3);
        let to = Math.floor(rand() * 3);
        if (to === from) to = (to + 1) % 3;
        if (rand() < 0.5) structs[to]!.merge(structs[from]!);
        else structs[to]!.merge(structs[from]!.encode()); // via serialized doc
        naives[to]!.merge(naives[from]!);
      } else {
        // occasionally inject an enormous sparse event (never expanded)
        const idHex = pick(REPLICAS);
        const target = Math.floor(rand() * 3);
        const n = (1n << 60n) + bi(Math.floor(rand() * 1000));
        structs[target]!.add(parseHexId(idHex), n);
        naives[target]!.add(idHex, n);
      }

      for (let r = 0; r < 3; r++) assertInvariants(structs[r]!, naives[r]!);

      // pairwise differences every few ops
      if (op % 7 === 0) {
        for (let x = 0; x < 3; x++) {
          for (let y = 0; y < 3; y++) {
            if (x === y) {
              assert.ok(structs[x]!.difference(structs[y]!).isEmpty());
              continue;
            }
            const structural = diffToKeys(structs[x]!.difference(structs[y]!));
            const naive = naives[x]!.diff(naives[y]!);
            assert.deepEqual(structural, naive, `diff ${x}->${y} at trial ${t} op ${op}`);
          }
        }
      }
    }

    // three-way convergence on a ring: 0->1, 2->0, 1->2. After the cycle
    // each member has gathered everything, independent of starting point.
    structs[1]!.merge(structs[0]!);
    naives[1]!.merge(naives[0]!);
    structs[0]!.merge(structs[2]!);
    naives[0]!.merge(naives[2]!);
    structs[2]!.merge(structs[1]!);
    naives[2]!.merge(naives[1]!);
    structs[0]!.merge(structs[1]!);
    naives[0]!.merge(naives[1]!);
    structs[2]!.merge(structs[0]!);
    naives[2]!.merge(naives[0]!);
    structs[1]!.merge(structs[2]!);
    naives[1]!.merge(naives[2]!);
    const sers = structs.map((s) => s.serialize());
    assert.equal(sers[0], sers[1], `three-way convergence trial ${t}`);
    assert.equal(sers[1], sers[2], `three-way convergence trial ${t}`);

    for (const idHex of REPLICAS) {
      for (let n = 1n; n <= SMALL_MAX + 5n; n++) {
        assert.equal(
          structs[0]!.contains(parseHexId(idHex), n),
          origin.has(idHex, n),
          `post-merge truth ${idHex}:${n}`,
        );
      }
    }
  }
});

test("add-order commutativity over random permutations", () => {
  const rand = mulberry32(12345);
  // choose a random event set on two replicas, then add in two shuffled orders
  for (let t = 0; t < 40; t++) {
    const events: Array<[string, bigint]> = [];
    for (const idHex of ["aa", "bb"]) {
      const used = new Set<bigint>();
      const count = 1 + Math.floor(rand() * 15);
      while (used.size < count) used.add(1n + BigInt(Math.floor(rand() * 20)));
      for (const n of used) events.push([idHex, n]);
    }
    const orderA = events.slice();
    const orderB = events.slice();
    for (let i = orderB.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [orderB[i], orderB[j]] = [orderB[j]!, orderB[i]!];
    }
    const va = new VersionVector();
    const vb = new VersionVector();
    for (const [h, n] of orderA) va.add(parseHexId(h), n);
    for (const [h, n] of orderB) vb.add(parseHexId(h), n);
    assert.equal(va.serialize(), vb.serialize());
    // id ordering is byte-wise
    assert.deepEqual(va.encode().entries.map((e) => e.id), ["aa", "bb"]);
  }
});
