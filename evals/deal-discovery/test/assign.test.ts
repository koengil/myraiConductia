import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assignOneToOne, hungarianMax } from '../src/assign.ts';
import type { DealMatch } from '../src/match.ts';
import { shuffled } from './synthetic.ts';

function m(dealId: string, evidenceItems: number, score = 0.6): DealMatch {
  return { dealId, score, codename: true, partyOverlap: 0, time: 'unknown', evidenceItems, evidenceShare: 1 };
}

/** The best total weight by trying every assignment: the reference for small cases. */
function bruteForce(rows: number, cols: number, w: (r: number, c: number) => number): number {
  let best = 0;
  const used = new Array<boolean>(cols).fill(false);
  const walk = (r: number, total: number) => {
    if (r === rows) {
      best = Math.max(best, total);
      return;
    }
    walk(r + 1, total); // row r unpaired
    for (let c = 0; c < cols; c += 1) {
      if (used[c] || w(r, c) === 0) continue;
      used[c] = true;
      walk(r + 1, total + w(r, c));
      used[c] = false;
    }
  };
  walk(0, 0);
  return best;
}

describe('hungarianMax', () => {
  it('finds the maximum-weight assignment, checked against brute force', () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const rows = 1 + (next() % 4);
      const cols = rows + (next() % 3);
      const weights = Array.from({ length: rows }, () => Array.from({ length: cols }, () => (next() % 3 === 0 ? 0 : next() % 50)));
      const w = (r: number, c: number) => weights[r][c];
      const colOfRow = hungarianMax(rows, cols, w);
      assert.equal(new Set(colOfRow).size, rows, 'each row gets a distinct column');
      const total = colOfRow.reduce((sum, c, r) => sum + w(r, c), 0);
      assert.equal(total, bruteForce(rows, cols, w), `trial ${trial}`);
    }
  });
});

describe('assignOneToOne (review item 1)', () => {
  it('pairs one duplicate per deal and leaves the others unpaired', () => {
    // The degenerate case: three candidates for each of two deals.
    const qualifying = new Map<string, DealMatch[]>([
      ['a1', [m('T01', 4)]],
      ['a2', [m('T01', 4)]],
      ['a3', [m('T01', 4)]],
      ['b1', [m('T02', 4)]],
      ['b2', [m('T02', 4)]],
      ['b3', [m('T02', 4)]],
    ]);
    const a = assignOneToOne(qualifying);
    assert.equal(a.size, 2);
    assert.deepEqual(new Set(a.values()), new Set(['T01', 'T02']));
  });

  it('gives a deal to the candidate that holds most of its items', () => {
    const qualifying = new Map<string, DealMatch[]>([
      ['small', [m('T01', 1, 1)]],
      ['large', [m('T01', 9, 0.6)]],
    ]);
    assert.deepEqual([...assignOneToOne(qualifying)], [['large', 'T01']]);
  });

  it('pairs a candidate that qualifies twice where it completes the assignment', () => {
    const qualifying = new Map<string, DealMatch[]>([
      ['x', [m('T01', 3), m('T02', 3)]],
      ['y', [m('T01', 3)]],
    ]);
    assert.deepEqual(new Map(assignOneToOne(qualifying)), new Map([['x', 'T02'], ['y', 'T01']]));
  });

  it('does not depend on the order of its input', () => {
    const entries: Array<[string, DealMatch[]]> = [
      ['c1', [m('T01', 2)]],
      ['c2', [m('T01', 2)]],
      ['c3', [m('T02', 2), m('T01', 2)]],
      ['c4', [m('T03', 1)]],
      ['c5', [m('T03', 1)]],
    ];
    const expected = [...assignOneToOne(new Map(entries))].sort();
    for (let seed = 1; seed <= 30; seed += 1) {
      assert.deepEqual([...assignOneToOne(new Map(shuffled(entries, seed)))].sort(), expected);
    }
  });

  it('pairs nothing when nothing qualifies', () => {
    assert.equal(assignOneToOne(new Map([['c', []]])).size, 0);
  });
});
