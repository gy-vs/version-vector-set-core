import { Buffer } from 'node:buffer';
import { ReplicaId } from './replicaId.js';
import { fail } from './errors.js';
import type { Seg } from './intervals.js';
import type { VectorEntry } from './versionVectorSet.js';

/**
 * A bounded request a lagging replica uses to fetch missing events from a
 * peer. Build it from a structural difference:
 *
 *   const diff = responder.difference(requester).entries();
 *   const page = nextMissingRequest(diff, 4096, id => requester.head(id));
 *
 * Groups are ordered by replica id (the diff is already deterministic);
 * within a group `since` is the requester's contiguous prefix and `ranges`
 * partitions the responder's excess coverage above it. Pagination is
 * range-based: each difference range is an atomic request window and a page
 * holds as many as fit in `maxBytes`. Because a single range encodes only
 * its two decimal endpoints (bounded by 2^64-1, so <= ~95 bytes regardless
 * of the span it covers), truncation is driven by the *number* of ranges,
 * never by event count — a gap spanning 10^18 counters is still one range.
 *
 * `next` is an opaque resumption cursor; pass it back to fetch the next
 * page. Output is deterministic: identical inputs yield identical pages.
 */
export interface MissingRequest {
  want: Array<{ id: string; since: string; ranges: [string, string][] }>;
  next?: string;
}

interface Cursor {
  /** index into the flattened difference to resume from */
  i: number;
}

/** JSON size of the largest realistic cursor field (reservation headroom). */
const CURSOR_FIELD = 24;

export function nextMissingRequest(
  diff: ReadonlyArray<readonly [ReplicaId, VectorEntry]>,
  maxBytes: number,
  sinceFor: (id: ReplicaId) => bigint = () => 0n,
  cursor?: string,
): MissingRequest | null {
  if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1) {
    fail('BAD_WIRE_FORMAT', 'maxBytes must be a positive integer');
  }

  const flat = flatten(diff, sinceFor);
  if (flat.length === 0) return null;

  let start = 0;
  if (cursor !== undefined) {
    const c = decodeCursor(cursor);
    if (c.i >= flat.length) return null;
    start = c.i;
  }

  // Feasibility: the resume range must fit on its own page (no cursor is
  // needed when it is the only content). Ranges are atomic, so a budget
  // below this can never be satisfied.
  {
    const [id, since, range] = flat[start]!;
    const probe: MissingRequest = {
      want: [{ id: id.hex, since: since.toString(), ranges: [[range.lo.toString(), range.hi.toString()]] }],
    };
    if (byteSize(probe) > maxBytes) {
      fail('BUDGET_TOO_SMALL', `maxBytes=${maxBytes} cannot hold a single request range`);
    }
  }

  // Greedy bin packing of atomic ranges, in deterministic order. A page is
  // closed as soon as the next range would not fit *with the cursor field
  // present*; the last page carries no cursor and so may use every byte.
  const groups = new Map<string, { id: ReplicaId; since: string; ranges: Seg[] }>();
  const order: string[] = [];
  const groupFor = (id: ReplicaId, since: bigint) => {
    const hex = id.hex;
    let g = groups.get(hex);
    if (!g) {
      g = { id, since: since.toString(), ranges: [] };
      groups.set(hex, g);
      order.push(hex);
    }
    return g;
  };

  const render = (withCursor: boolean): MissingRequest => {
    const want = order.map((hex) => {
      const g = groups.get(hex)!;
      return {
        id: hex,
        since: g.since,
        ranges: g.ranges.map((r) => [r.lo.toString(), r.hi.toString()] as [string, string]),
      };
    });
    const req: MissingRequest = { want };
    if (withCursor) req.next = 'x'.repeat(CURSOR_FIELD);
    return req;
  };

  let nextIndex = -1;

  for (let i = start; i < flat.length; i++) {
    const [id, since, range] = flat[i]!;
    const isLast = i === flat.length - 1;
    groupFor(id, since).ranges.push(range);

    // Does the page fit? Intermediate pages must also carry a cursor; the
    // final page has none and may use the whole budget.
    const overflows = byteSize(render(!isLast)) > maxBytes;
    if (!overflows) continue;

    // The last range overflowing a non-empty page is impossible after the
    // feasibility probe only when it shares the page with prior ranges:
    // close the page and resume from this range.
    groupFor(id, since).ranges.pop();
    nextIndex = i;
    break;
  }

  if (nextIndex === start) {
    // Probe guaranteed fit for one range, yet it overflowed its own page —
    // only reachable on the very first range, which the probe ruled out.
    fail('BUDGET_TOO_SMALL', `maxBytes=${maxBytes} cannot hold a single request range`);
  }

  const req = render(false);
  if (nextIndex >= 0) req.next = encodeCursor({ i: nextIndex });
  return req;
}

/** Walk every page until the difference is fully covered. */
export function allMissingRequestPages(
  diff: ReadonlyArray<readonly [ReplicaId, VectorEntry]>,
  maxBytes: number,
  sinceFor: (id: ReplicaId) => bigint = () => 0n,
): MissingRequest[] {
  const pages: MissingRequest[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = nextMissingRequest(diff, maxBytes, sinceFor, cursor);
    if (!page) break;
    pages.push(page);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return pages;
}

export function byteSize(req: MissingRequest): number {
  return JSON.stringify(req).length;
}

// --- internals ---------------------------------------------------------------

type FlatRange = readonly [ReplicaId, bigint, Seg];

/**
 * Ordered (replica, since, range) triples the requester is missing. The
 * difference entry covers {1..p} ∪ gaps; since the requester already owns
 * 1..since, the prefix excess to request is (since, p], and gaps verbatim.
 */
function flatten(
  diff: ReadonlyArray<readonly [ReplicaId, VectorEntry]>,
  sinceFor: (id: ReplicaId) => bigint,
): FlatRange[] {
  const out: FlatRange[] = [];
  for (const [id, entry] of diff) {
    const since = sinceFor(id);
    if (entry.p > since) out.push([id, since, { lo: since + 1n, hi: entry.p }]);
    for (const g of entry.gaps) out.push([id, since, { lo: g.lo, hi: g.hi }]);
  }
  return out;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(text: string): Cursor {
  let c: unknown;
  try {
    c = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    fail('BAD_CURSOR', 'cursor is not valid base64url-encoded JSON');
  }
  if (typeof c !== 'object' || c === null) fail('BAD_CURSOR', 'cursor payload invalid');
  const i = (c as Record<string, unknown>).i;
  if (typeof i !== 'number' || !Number.isInteger(i) || i < 0) {
    fail('BAD_CURSOR', 'cursor index invalid');
  }
  return { i };
}
