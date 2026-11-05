// One-to-one pairing of candidates and true deals for the headline discovery
// precision and recall (review item 1). Each deal is found by at most one
// candidate and each candidate finds at most one deal, so a duplicate
// candidate is a false positive, not a second hit.
//
// The pairing is a maximum-weight assignment over the qualifying relation
// (match.ts), solved exactly with the Hungarian algorithm on integer weights.
// A pair's weight ranks, first, how many of the deal's items the candidate
// holds (its evidence overlap, as in the CEAF cluster metric), then its match
// score. The overlap term is scaled past any sum of scores, so the total
// maximizes the overlap first and breaks ties on the score. Inputs are taken
// in code-point order of their ids, so the same inputs give the same pairing
// in any order.

import { byCodePoint } from './compare.ts';
import type { DealMatch } from './match.ts';

/** Candidate id -> the deal it is paired with. Unpaired candidates are absent. */
export type Assignment = Map<string, string>;

const SCORE_SCALE = 1000;

/**
 * The assignment maximizing total weight. `qualifying` maps a candidate id to
 * the deals it qualifies for; a candidate with none takes no part.
 */
export function assignOneToOne(qualifying: Map<string, DealMatch[]>): Assignment {
  const candidates = [...qualifying.keys()].filter((id) => qualifying.get(id)!.length > 0).sort(byCodePoint);
  const deals = [...new Set(candidates.flatMap((id) => qualifying.get(id)!.map((m) => m.dealId)))].sort(byCodePoint);
  const out: Assignment = new Map();
  if (candidates.length === 0) return out;

  const overlapScale = SCORE_SCALE * Math.min(candidates.length, deals.length) + 1;
  const dealIndex = new Map(deals.map((id, j) => [id, j]));
  const weight: number[][] = candidates.map(() => deals.map(() => 0));
  candidates.forEach((id, i) => {
    for (const m of qualifying.get(id)!) {
      weight[i][dealIndex.get(m.dealId)!] = m.evidenceItems * overlapScale + Math.round(m.score * SCORE_SCALE);
    }
  });

  // The Hungarian algorithm needs rows <= columns: transpose when there are more candidates than deals.
  const transpose = candidates.length > deals.length;
  const rows = transpose ? deals.length : candidates.length;
  const cols = transpose ? candidates.length : deals.length;
  const w = (r: number, c: number) => (transpose ? weight[c][r] : weight[r][c]);
  const colOfRow = hungarianMax(rows, cols, w);
  colOfRow.forEach((c, r) => {
    const [i, j] = transpose ? [c, r] : [r, c];
    if (weight[i][j] > 0) out.set(candidates[i], deals[j]);
  });
  return out;
}

/**
 * Maximum-weight assignment of every row to a distinct column (rows <= cols),
 * as the minimum-cost assignment of (max weight - weight). A zero-weight pair
 * stands for "not paired". Returns the column of each row.
 */
export function hungarianMax(rows: number, cols: number, weight: (r: number, c: number) => number): number[] {
  let max = 0;
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) max = Math.max(max, weight(r, c));
  const cost = (r: number, c: number) => max - weight(r - 1, c - 1);

  // 1-indexed potentials and matching (the classic O(rows^2 x cols) form).
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const rowOfCol = new Array<number>(cols + 1).fill(0);
  const way = new Array<number>(cols + 1).fill(0);
  for (let r = 1; r <= rows; r += 1) {
    rowOfCol[0] = r;
    let c0 = 0;
    const minv = new Array<number>(cols + 1).fill(Infinity);
    const used = new Array<boolean>(cols + 1).fill(false);
    do {
      used[c0] = true;
      const r0 = rowOfCol[c0];
      let delta = Infinity;
      let c1 = 0;
      for (let c = 1; c <= cols; c += 1) {
        if (used[c]) continue;
        const reduced = cost(r0, c) - u[r0] - v[c];
        if (reduced < minv[c]) {
          minv[c] = reduced;
          way[c] = c0;
        }
        if (minv[c] < delta) {
          delta = minv[c];
          c1 = c;
        }
      }
      for (let c = 0; c <= cols; c += 1) {
        if (used[c]) {
          u[rowOfCol[c]] += delta;
          v[c] -= delta;
        } else {
          minv[c] -= delta;
        }
      }
      c0 = c1;
    } while (rowOfCol[c0] !== 0);
    do {
      const c1 = way[c0];
      rowOfCol[c0] = rowOfCol[c1];
      c0 = c1;
    } while (c0 !== 0);
  }
  const colOfRow = new Array<number>(rows).fill(-1);
  for (let c = 1; c <= cols; c += 1) if (rowOfCol[c] !== 0) colOfRow[rowOfCol[c] - 1] = c - 1;
  return colOfRow;
}
