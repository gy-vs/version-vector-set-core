import { VersionVector } from "../dist/src/index.js";

// brute fuzz: build two vectors, compare difference enumeration with truth
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (let t = 0; t < 200000; t++) {
  const rand = mulberry32(t);
  const a = new VersionVector();
  const b = new VersionVector();
  const ta = new Set(), tb = new Set();
  const N = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < N; i++) {
    const lo = 1n + BigInt(Math.floor(rand() * 12));
    const hi = lo + BigInt(Math.floor(rand() * 4));
    a.addRange(new Uint8Array([1]), lo, hi);
    for (let n = lo; n <= hi; n++) ta.add(n.toString());
  }
  for (let i = 0; i < N; i++) {
    const lo = 1n + BigInt(Math.floor(rand() * 12));
    const hi = lo + BigInt(Math.floor(rand() * 4));
    b.addRange(new Uint8Array([1]), lo, hi);
    for (let n = lo; n <= hi; n++) tb.add(n.toString());
  }
  const diff = a.difference(b);
  const got = new Set();
  for (const e of diff)
    for (const [lo, hi] of e.segments)
      for (let n = lo; n <= hi; n++) got.add(n.toString());
  const want = new Set([...ta].filter((x) => !tb.has(x)));
  const extra = [...got].filter((x) => !want.has(x));
  const miss = [...want].filter((x) => !got.has(x));
  if (extra.length || miss.length) {
    console.log("seed", t);
    console.log("A prefix", a.prefixOf(new Uint8Array([1])), "segs", JSON.stringify(a.segmentsOf(new Uint8Array([1])), (_, v) => typeof v === "bigint" ? v.toString() : v));
    console.log("B prefix", b.prefixOf(new Uint8Array([1])), "segs", JSON.stringify(b.segmentsOf(new Uint8Array([1])), (_, v) => typeof v === "bigint" ? v.toString() : v));
    console.log("extra", extra, "missing", miss);
    process.exit(0);
  }
}
console.log("no counterexample");
