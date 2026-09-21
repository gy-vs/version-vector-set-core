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

const id = new Uint8Array([1]);
for (let t = 0; t < 500000; t++) {
  const rand = mulberry32(t);
  const v = new VersionVector();
  const truth = new Set();
  const ops = 1 + Math.floor(rand() * 10);
  const ranges = [];
  for (let i = 0; i < ops; i++) {
    const lo = 1n + BigInt(Math.floor(rand() * 10));
    const hi = lo + BigInt(Math.floor(rand() * 4));
    ranges.push([Number(lo), Number(hi)]);
    v.addRange(id, lo, hi);
    for (let n = lo; n <= hi; n++) truth.add(n.toString());
  }
  const segs = v.segmentsOf(id);
  const prefix = v.prefixOf(id);
  // canonical checks
  let prevHi = prefix;
  for (const [lo, hi] of segs) {
    if (lo <= prevHi + 1n) {
      console.log("seed", t, "ops", JSON.stringify(ranges), "prefix", prefix.toString());
      console.log("BAD SEGS", JSON.stringify(segs, (_, x) => typeof x === "bigint" ? x.toString() : x));
      process.exit(0);
    }
    prevHi = hi;
  }
  // truth checks
  for (let n = 1; n <= 16; n++) {
    if (v.contains(id, BigInt(n)) !== truth.has(String(n))) {
      console.log("seed", t, "truth mismatch at", n, JSON.stringify(ranges), "prefix", prefix.toString());
      console.log(JSON.stringify(segs, (_, x) => typeof x === "bigint" ? x.toString() : x));
      process.exit(0);
    }
  }
}
console.log("no counterexample");
