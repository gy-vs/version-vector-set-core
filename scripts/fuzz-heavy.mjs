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

const IDS = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([0,7]), new Uint8Array([2,0])];
const MAX = 40n;

for (let t = 0; t < 30000; t++) {
  const rand = mulberry32(0xabc + t);
  const structs = [new VersionVector(), new VersionVector(), new VersionVector()];
  const truths = [new Set(), new Set(), new Set()];
  const key = (i, n) => i + ":" + n;

  const OPS = 40;
  for (let op = 0; op < OPS; op++) {
    const r = rand();
    if (r < 0.6) {
      const k = Math.floor(rand() * IDS.length);
      const target = Math.floor(rand() * 3);
      const lo = 1n + BigInt(Math.floor(rand() * Number(MAX)));
      const hi = lo + BigInt(Math.floor(rand() * 8));
      structs[target].addRange(IDS[k], lo, hi);
      for (let n = lo; n <= hi; n++) truths[target].add(key(k, n.toString()));
    } else if (r < 0.75) {
      const k = Math.floor(rand() * IDS.length);
      const target = Math.floor(rand() * 3);
      const n = 1n + BigInt(Math.floor(rand() * Number(MAX)));
      structs[target].add(IDS[k], n);
      truths[target].add(key(k, n.toString()));
    } else {
      const from = Math.floor(rand() * 3);
      let to = Math.floor(rand() * 3);
      if (to === from) to = (to + 1) % 3;
      structs[to].merge(rand() < 0.5 ? structs[from] : structs[from].encode());
      for (const x of truths[from]) truths[to].add(x);
    }
  }

  // verify contains + canonical round-trip + invariants for each replica
  for (let r = 0; r < 3; r++) {
    const v = structs[r];
    for (let k = 0; k < IDS.length; k++) {
      // prefix
      let p = 0n;
      for (let n = 1n; n <= MAX + 8n; n++) {
        if (truths[r].has(key(k, n.toString()))) p = n; else break;
      }
      if (v.prefixOf(IDS[k]) !== p) throw new Error(`seed ${t} replica ${r} id ${k} prefix ${v.prefixOf(IDS[k])} != ${p}`);
      // full membership window
      for (let n = 1n; n <= MAX + 5n; n++) {
        const want = truths[r].has(key(k, n.toString()));
        if (v.contains(IDS[k], n) !== want) throw new Error(`seed ${t} contains r${r} id${k}:${n} want ${want}`);
      }
      // segments sorted/disjoint/gapped
      let prev = p;
      for (const [lo, hi] of v.segmentsOf(IDS[k])) {
        if (lo > hi || lo <= prev + 1n) throw new Error(`seed ${t} bad segs r${r} id${k}`);
        prev = hi;
      }
    }
    const s = v.serialize();
    if (VersionVector.decode(s).serialize() !== s) throw new Error(`seed ${t} r${r} noncanonical`);
  }

  // pairwise diffs vs truth (only over bounded window; exclude 2^60 sparse events)
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) {
    const diff = structs[x].difference(structs[y]);
    const got = new Set();
    for (const e of diff) {
      const ki = IDS.findIndex((d) => d.length === e.id.length && d.every((b, j) => b === e.id[j]));
      for (const [lo, hi] of e.segments)
        for (let n = lo; n <= hi && n <= MAX + 5n; n++) got.add(key(ki, n.toString()));
    }
    for (let k = 0; k < IDS.length; k++)
      for (let n = 1n; n <= MAX + 5n; n++) {
        const kk = key(k, n.toString());
        const want = truths[x].has(kk) && !truths[y].has(kk);
        if (got.has(kk) !== want) throw new Error(`seed ${t} diff ${x}->${y} ${kk} want ${want}`);
      }
  }
}
console.log("heavy fuzz clean");
