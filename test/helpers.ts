import { ReplicaId } from '../src/index.js';

/** Deterministic PRNG (mulberry32) so random differential runs are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ids = {
  a: ReplicaId.fromHex('aaaa'),
  b: ReplicaId.fromHex('bbbb'),
  c: ReplicaId.fromHex('cccc'),
  d: ReplicaId.fromHex('00ff'),
};

/**
 * Naive per-replica set model, used as the oracle in differential tests.
 * The whole test universe stays small so per-event storage is fine *here*;
 * the production code must never expand that way.
 */
export class NaiveModel {
  readonly sets = new Map<string, Set<number>>();

  private key(id: ReplicaId): string {
    return id.hex;
  }

  add(id: ReplicaId, n: number): void {
    const k = this.key(id);
    let s = this.sets.get(k);
    if (!s) {
      s = new Set();
      this.sets.set(k, s);
    }
    s.add(n);
  }

  contains(id: ReplicaId, n: number): boolean {
    return this.sets.get(this.key(id))?.has(n) ?? false;
  }

  merge(other: NaiveModel): void {
    for (const [k, s] of other.sets) {
      let t = this.sets.get(k);
      if (!t) {
        t = new Set();
        this.sets.set(k, t);
      }
      for (const n of s) t.add(n);
    }
  }

  /** Prefix length under the model's set semantics. */
  head(id: ReplicaId): number {
    const s = this.sets.get(this.key(id));
    if (!s) return 0;
    let h = 0;
    while (s.has(h + 1)) h++;
    return h;
  }

  values(id: ReplicaId): number[] {
    return [...(this.sets.get(this.key(id)) ?? [])].sort((x, y) => x - y);
  }

  clone(): NaiveModel {
    const m = new NaiveModel();
    for (const [k, s] of this.sets) m.sets.set(k, new Set(s));
    return m;
  }
}

/** Expand a VersionVectorSet entry's coverage into an array for oracle checks. */
export function expandEntry(p: bigint, gaps: ReadonlyArray<{ lo: bigint; hi: bigint }>): number[] {
  const out: number[] = [];
  for (let n = 1; n <= Number(p); n++) out.push(n);
  for (const g of gaps) {
    for (let n = Number(g.lo); n <= Number(g.hi); n++) out.push(n);
  }
  return out.sort((x, y) => x - y);
}
