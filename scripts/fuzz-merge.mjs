import { VersionVector } from "../dist/src/index.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function check(v, id, tag) {
  const segs = v.segmentsOf(id);
  let prevHi = v.prefixOf(id);
  for (const [lo, hi] of segs) {
    if (lo <= prevHi + 1n) {
      console.log(tag, "BAD", "prefix", prevHi === v.prefixOf(id) ? v.prefixOf(id).toString() : "?",
        JSON.stringify(segs, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
      return true;
    }
    prevHi = hi;
  }
  return false;
}

const id = new Uint8Array([1]);
for (let t = 0; t < 200000; t++) {
  const rand = mulberry32(t);
  const a = new VersionVector();
  const b = new VersionVector();
  const rangesA = [], rangesB = [];
  const addSome = (v, arr, k) => {
    for (let i = 0; i < k; i++) {
      const lo = 1n + BigInt(Math.floor(rand() * 12));
      const hi = lo + BigInt(Math.floor(rand() * 5));
      arr.push([Number(lo), Number(hi)]);
      v.addRange(id, lo, hi);
    }
  };
  addSome(a, rangesA, 1 + Math.floor(rand() * 6));
  addSome(b, rangesB, 1 + Math.floor(rand() * 6));
  if (check(a, id, "premerge A seed" + t)) { console.log(rangesA); process.exit(0); }
  if (check(b, id, "premerge B seed" + t)) { console.log(rangesB); process.exit(0); }
  const viaDoc = rand() < 0.5;
  try {
    if (!viaDoc) a.merge(b);
    else a.merge(b.encode());
  } catch (e) {
    console.log("merge-throw seed", t, "viaDoc", viaDoc, "A", JSON.stringify(rangesA), "B", JSON.stringify(rangesB));
    console.log("a:", a.serialize());
    console.log("b:", b.serialize());
    process.exit(0);
  }
  if (check(a, id, "postmerge seed" + t)) {
    console.log("A", JSON.stringify(rangesA), "B", JSON.stringify(rangesB));
    process.exit(0);
  }
  // round-trip decode catches it too
  try { VersionVector.decode(a.serialize()); }
  catch (e) {
    console.log("decode-fail seed", t, "A", JSON.stringify(rangesA), "B", JSON.stringify(rangesB));
    console.log(a.serialize());
    process.exit(0);
  }
}
console.log("no counterexample");
