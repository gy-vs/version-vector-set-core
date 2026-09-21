import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VersionVectorSet, ReplicaId } from '../src/index.js';

// These checks reason about retained heap and need an explicit GC; `npm test`
// runs node with --expose-gc. Skip gracefully if the flag is absent.
const g = globalThis as { gc?: () => void };
const hasGc = typeof g.gc === 'function';

function retainedBytes(build: () => VersionVectorSet): number {
  if (!hasGc) return 0;
  g.gc!();
  const before = process.memoryUsage().heapUsed;
  const keep: VersionVectorSet[] = [];
  for (let i = 0; i < 200; i++) keep.push(build());
  g.gc!();
  const after = process.memoryUsage().heapUsed;
  // Hold until after the measurement.
  assert.ok(keep.length === 200);
  return (after - before) / 200;
}

test('heap: size tracks range count, not max counter magnitude', { skip: !hasGc }, () => {
  const smallId = ReplicaId.fromHex('0a0a');
  const hugeId = ReplicaId.fromHex('b0b0');

  // One range at small vs astronomically large endpoints: nearly equal
  // heap footprint despite a ~10^15 difference in counter magnitude.
  const smallOne = retainedBytes(() =>
    VersionVectorSet.parse(JSON.stringify({ [smallId.hex]: { p: '0', gaps: [['10', '11']] } })),
  );
  const hugeOne = retainedBytes(() =>
    VersionVectorSet.parse(JSON.stringify({
      [hugeId.hex]: { p: '0', gaps: [['1000000000000000', '1000000000000001']] },
    })),
  );
  // BigInt digits cost a little, but the footprint ratio is bounded well
  // below any event-proportional storage (which would be ~10^15x larger).
  assert.ok(Math.abs(hugeOne - smallOne) < 512, `small=${smallOne} huge=${hugeOne}`);

  // More ranges => proportionally more memory; same magnitude class.
  const withRanges = (k: number) => retainedBytes(() => {
    const gaps: Array<[string, string]> = [];
    for (let i = 0; i < k; i++) {
      const lo = BigInt(1000 + i * 1_000_000);
      gaps.push([lo.toString(), (lo + 1n).toString()]);
    }
    return VersionVectorSet.parse(JSON.stringify({ [smallId.hex]: { p: '0', gaps } }));
  });
  const one = withRanges(1);
  const sixtyFour = withRanges(64);
  assert.ok(sixtyFour > one, `expected growth: one=${one} 64=${sixtyFour}`);
  // Roughly linear: average per-range cost is stable (within a factor of 3
  // to absorb allocator/Map overhead at small sizes).
  const perRange64 = (sixtyFour - one) / 63;
  assert.ok(perRange64 > 0);
  assert.ok(perRange64 < 256, `per-range heap ${perRange64} unexpectedly large`);
});
