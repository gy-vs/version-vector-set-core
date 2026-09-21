import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VersionVectorSet,
  ReplicaId,
  nextMissingRequest,
  allMissingRequestPages,
  byteSize,
  VersionVectorError,
} from '../src/index.js';
import { ids } from './helpers.js';

test('empty difference produces no request', () => {
  const v = VersionVectorSet.empty().add(ids.a, 3n);
  assert.equal(nextMissingRequest(v.difference(v).entries(), 1024), null);
  assert.equal(nextMissingRequest([], 1024), null);
});

test('single page carries since per replica and all missing ranges', () => {
  const responder = VersionVectorSet.empty()
    .add(ids.a, 1n).add(ids.a, 100n).add(ids.a, 500n)
    .add(ids.b, 9n);
  const requester = VersionVectorSet.empty().add(ids.a, 1n);

  const req = nextMissingRequest(
    responder.difference(requester).entries(),
    4096,
    (id) => requester.head(id),
  )!;
  assert.equal(req.next, undefined);
  assert.deepEqual(req.want, [
    { id: ids.a.hex, since: '1', ranges: [['100', '100'], ['500', '500']] },
    { id: ids.b.hex, since: '0', ranges: [['9', '9']] },
  ]);
});

test('prefix excess [1,p] is requested when requester is behind', () => {
  let responder = VersionVectorSet.empty();
  for (let n = 1n; n <= 20n; n++) responder = responder.add(ids.a, n);
  const requester = VersionVectorSet.empty().add(ids.a, 5n);
  const req = nextMissingRequest(responder.difference(requester).entries(), 4096, () => 5n)!;
  assert.deepEqual(req.want, [{ id: ids.a.hex, since: '5', ranges: [['6', '20']] }]);
});

/** A responder carrying many disjoint gap ranges (forces range truncation). */
function manyRangeResponder(): { responder: VersionVectorSet; gaps: Array<[bigint, bigint]> } {
  const gaps: Array<[bigint, bigint]> = [];
  for (let k = 1; k <= 24; k++) {
    const base = BigInt(k * 100);
    gaps.push([base + 1n, base + 2n]); // 101-102, 201-202, ...
  }
  const responder = VersionVectorSet.parse(
    JSON.stringify({ [ids.a.hex]: { p: '0', gaps: gaps.map(([l, h]) => [l.toString(), h.toString()]) } }),
  );
  return { responder, gaps };
}

test('truncated pages respect the byte budget and resume exactly', () => {
  const { responder, gaps } = manyRangeResponder();
  const diff = responder.difference(VersionVectorSet.empty()).entries();

  const maxBytes = 230;
  const pages = allMissingRequestPages(diff, maxBytes);
  assert.ok(pages.length >= 3, `expected multiple pages, got ${pages.length}`);

  for (const p of pages) {
    assert.ok(byteSize(p) <= maxBytes, `page ${byteSize(p)} bytes > ${maxBytes}`);
  }
  for (const p of pages.slice(0, -1)) assert.ok(typeof p.next === 'string' && p.next.length > 0);
  assert.equal(pages.at(-1)!.next, undefined);

  // Reassemble: the ranges across pages are exactly the diff ranges, in
  // order, whole (range-based truncation never splits a range here).
  const seen: Array<[string, string]> = [];
  for (const p of pages) {
    assert.equal(p.want.length, 1);
    assert.equal(p.want[0]!.id, ids.a.hex);
    for (const r of p.want[0]!.ranges) seen.push(r);
  }
  assert.deepEqual(
    seen,
    gaps.map(([l, h]) => [l.toString(), h.toString()]),
  );
});

test('a huge-span gap is a constant-size single range request (no event expansion)', () => {
  const wide = 2n ** 60n - 1n;
  const responder = VersionVectorSet.parse(
    JSON.stringify({ [ids.a.hex]: { p: wide.toString() } }),
  );
  const requester = VersionVectorSet.empty().add(ids.a, 1n);
  const diff = responder.difference(requester).entries();
  assert.deepEqual(diff[0]![1], { p: 0n, gaps: [{ lo: 2n, hi: wide }] });

  // Despite spanning ~10^18 counters, it is one tiny request on one page.
  const req = nextMissingRequest(diff, 4096, () => 1n)!;
  assert.equal(req.next, undefined);
  assert.deepEqual(req.want[0]!.ranges, [['2', wide.toString()]]);
  assert.ok(byteSize(req) < 120);
});

test('resumption from a cursor continues at the next whole range deterministically', () => {
  const { responder } = manyRangeResponder();
  const diff = responder.difference(VersionVectorSet.empty()).entries();
  const maxBytes = 230;

  const first = nextMissingRequest(diff, maxBytes)!;
  assert.ok(first.next);
  const second = nextMissingRequest(diff, maxBytes, () => 0n, first.next)!;

  // Page 2 starts at the first range not present on page 1.
  const onPage1 = new Set(first.want[0]!.ranges.map((r) => r[0]));
  const first2Lo = second.want[0]!.ranges[0]![0];
  assert.ok(!onPage1.has(first2Lo));

  // Determinism: regenerating page 1 yields byte-identical JSON.
  assert.equal(JSON.stringify(first), JSON.stringify(nextMissingRequest(diff, maxBytes)!));

  // Walking all pages from the cursor chain equals allMissingRequestPages.
  const chained = allMissingRequestPages(diff, maxBytes);
  let pages = 0;
  let cursor: string | undefined;
  for (;;) {
    const p = nextMissingRequest(diff, maxBytes, () => 0n, cursor);
    if (!p) break;
    assert.equal(JSON.stringify(p), JSON.stringify(chained[pages]!));
    pages++;
    if (p.next === undefined) break;
    cursor = p.next;
  }
  assert.equal(pages, chained.length);
});

test('cursor is tamper-evident', () => {
  const { responder } = manyRangeResponder();
  const diff = responder.difference(VersionVectorSet.empty()).entries();
  const budget = 230;
  const first = nextMissingRequest(diff, budget)!;
  assert.ok(first.next, 'multi-range fixture must paginate');

  assert.throws(
    () => nextMissingRequest(diff, budget, () => 0n, 'not-base64!!'),
    (e: unknown) => e instanceof VersionVectorError && e.code === 'BAD_CURSOR',
  );
  const forged = Buffer.from(JSON.stringify({ i: -1 })).toString('base64url');
  assert.throws(
    () => nextMissingRequest(diff, budget, () => 0n, forged),
    (e: unknown) => e instanceof VersionVectorError && e.code === 'BAD_CURSOR',
  );
  const badIndex = Buffer.from(JSON.stringify({ i: 'x' })).toString('base64url');
  assert.throws(
    () => nextMissingRequest(diff, budget, () => 0n, badIndex),
    (e: unknown) => e instanceof VersionVectorError && e.code === 'BAD_CURSOR',
  );
  const extraField = Buffer.from(JSON.stringify({ i: 0, lo: '3' })).toString('base64url');
  // Unknown fields are tolerated; the index is still validated.
  assert.doesNotThrow(() => nextMissingRequest(diff, budget, () => 0n, extraField));
});

test('impossibly small budgets are rejected', () => {
  const responder = VersionVectorSet.empty().add(ids.a, 9999999999n);
  const diff = responder.difference(VersionVectorSet.empty()).entries();
  assert.throws(
    () => nextMissingRequest(diff, 5),
    (e: unknown) => e instanceof VersionVectorError && e.code === 'BUDGET_TOO_SMALL',
  );
  assert.throws(() => nextMissingRequest(diff, 0), (e: unknown) => e instanceof VersionVectorError);
  assert.throws(() => nextMissingRequest(diff, 1.5), (e: unknown) => e instanceof VersionVectorError);
});

test('replica ids are stable binary identities with unsigned ordering', () => {
  const x = ReplicaId.fromBytes(Uint8Array.of(0x00, 0xff));
  const y = ReplicaId.fromHex('00ff');
  const z = ReplicaId.fromHex('0100');
  assert.ok(x.equals(y));
  assert.ok(x.compareTo(z) < 0);
  assert.ok(z.compareTo(y) > 0);
  assert.throws(() => ReplicaId.fromBytes(new Uint8Array(0)), (e: unknown) => e instanceof VersionVectorError);
  assert.throws(() => ReplicaId.fromHex('zz'), (e: unknown) => e instanceof VersionVectorError);
});
