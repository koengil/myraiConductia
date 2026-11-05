import { afterEach, describe, it, expect, vi } from 'vitest';
import { backfillRail } from '../scripts/backfill-project-rail';
import { RAIL_CENSUS_VERSION } from '../src/lib/constants/dealSteps';
import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps, railSeedRows } from '../src/lib/rail/dealRail';

type Row = Record<string, unknown>;
type Store = { deals: Row[]; deal_steps: Row[] };

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private orderCol?: string;
  private limitN?: number;
  private wantOne = false;
  private mode: 'select' | 'update' | 'insert' = 'select';
  private patch?: Row;
  private insertRows?: Row[];

  constructor(
    private table: keyof Store,
    private store: Store,
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  order(column: string): this {
    this.orderCol = column;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  maybeSingle(): this {
    this.wantOne = true;
    return this;
  }

  single(): this {
    this.wantOne = true;
    return this;
  }

  update(patch: Row): this {
    this.mode = 'update';
    this.patch = patch;
    return this;
  }

  insert(rows: Row[]): this {
    this.mode = 'insert';
    this.insertRows = rows;
    return this;
  }

  then<TResult1, TResult2>(
    onfulfilled?:
      | ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.store[this.table];
    let data: unknown;

    if (this.mode === 'insert') {
      rows.push(...(this.insertRows ?? []).map((row, i) => ({ id: `${this.table}-${rows.length + i}`, ...row })));
      data = null;
    } else if (this.mode === 'update') {
      for (const row of rows) {
        if (this.filters.every((f) => f(row))) Object.assign(row, this.patch);
      }
      data = null;
    } else {
      let matched = rows.filter((row) => this.filters.every((f) => f(row)));
      if (this.orderCol) {
        const col = this.orderCol;
        matched = [...matched].sort((a, b) => Number(a[col] ?? 0) - Number(b[col] ?? 0));
      }
      if (this.limitN != null) matched = matched.slice(0, this.limitN);
      data = this.wantOne ? matched[0] ?? null : matched;
    }

    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}

function makeFakeAdmin(store: Store) {
  return {
    from: (table: keyof Store) => new FakeQuery(table, store),
  } as never;
}

function stepRow(dealId: string, stepId: string, seq: number, status: string): Row {
  return {
    id: `row-${stepId}`,
    deal_id: dealId,
    step_id: stepId,
    seq,
    phase_index: null,
    display_order: null,
    origin: 'catalog',
    status,
    removed_at: null,
    removed_by: null,
  };
}

function oldCensusDeal(): Store {
  return {
    deals: [{ id: 'd6', code: 'FFF-2026-006', current_step_seq: 1, current_deal_step_id: null }],
    deal_steps: [stepRow('d6', 'p1-s1', 1, 'current'), stepRow('d6', 'p1-s6', 6, 'pending')],
  };
}

function fullOldCensusDeal(): Store {
  return {
    deals: [{ id: 'd7', code: 'GGG-2026-007', current_step_seq: 1, current_deal_step_id: null }],
    deal_steps: orderedSteps(DEAL_RAIL).map((step) =>
      stepRow('d7', step.id, step.seq, step.seq === 1 ? 'current' : 'pending'),
    ),
  };
}

function byDisplayOrder(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => Number(a.display_order) - Number(b.display_order));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('backfillRail', () => {
  it('leaves a deal carrying a step outside the catalogue untouched and logs the unknown id', async () => {
    const store: Store = {
      deals: [{ id: 'd1', code: 'AAA-2026-001', current_step_seq: 8, current_deal_step_id: null }],
      deal_steps: [stepRow('d1', 'p1-s8', 8, 'current'), stepRow('d1', 'p9-s99', 99, 'pending')],
    };
    const before = JSON.parse(JSON.stringify(store));
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((msg: string) => logs.push(msg));

    await backfillRail(makeFakeAdmin(store));

    expect(store).toEqual(before);
    expect(logs.some((line) => line.includes('AAA-2026-001') && line.includes('p9-s99'))).toBe(true);
  });

  it('rewrites a deal densely in rail order and carries the current step forward', async () => {
    const store: Store = {
      deals: [{ id: 'd4', code: 'DDD-2026-004', current_step_seq: 10, current_deal_step_id: null }],
      deal_steps: [
        stepRow('d4', 'p1-s10', 10, 'current'),
        stepRow('d4', 'p1-s8', 8, 'skipped_entry'),
        stepRow('d4', 'g0-notify', 0, 'skipped_entry'),
      ],
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await backfillRail(makeFakeAdmin(store));

    const rows = byDisplayOrder(store.deal_steps);
    expect(rows.map((r) => [r.step_id, r.display_order, r.phase_index])).toEqual([
      ['g0-notify', 1, 1],
      ['p1-s8', 2, 1],
      ['p1-s10', 3, 1],
    ]);
    expect(store.deals[0].current_deal_step_id).toBe('row-p1-s10');
  });

  it('moves an old census deal onto the rail: origination removed, notice added, position reselected', async () => {
    const store = oldCensusDeal();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await backfillRail(makeFakeAdmin(store));

    const byStep = Object.fromEntries(store.deal_steps.map((row) => [row.step_id, row]));
    expect(byStep['p1-s1']).toMatchObject({ display_order: 1, removed_by: null });
    expect(byStep['p1-s1'].removed_at).toEqual(expect.any(String));
    expect(byStep['p1-s6']).toMatchObject({ display_order: 2, status: 'current', removed_at: null });
    expect(byStep['g0-notify']).toMatchObject({
      deal_id: 'd6',
      status: 'skipped_entry',
      census_version: RAIL_CENSUS_VERSION,
      phase_index: 1,
      display_order: 3,
    });
    expect(byStep['g0-notify'].removed_at ?? null).toBeNull();
    expect(store.deals[0]).toMatchObject({ current_deal_step_id: 'row-p1-s6', current_step_seq: 6 });
  });

  it('changes nothing when run a second time, including when retired steps were removed', async () => {
    const store = oldCensusDeal();
    const admin = makeFakeAdmin(store);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T10:00:00Z'));

    await backfillRail(admin);
    const afterFirst = JSON.parse(JSON.stringify(store));
    vi.setSystemTime(new Date('2026-09-02T10:00:00Z'));
    await backfillRail(admin);

    expect(store).toEqual(afterFirst);
  });

  it('lays out active steps in the order a new deal is seeded with', async () => {
    const store = fullOldCensusDeal();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await backfillRail(makeFakeAdmin(store));

    const activeIds = byDisplayOrder(store.deal_steps.filter((row) => row.removed_at == null)).map(
      (row) => row.step_id,
    );
    expect(activeIds.slice(0, 4)).toEqual(['p1-s7', 'p1-s6', 'g0-notify', 'p1-s8']);
    expect(activeIds).toEqual(railSeedRows(MVP_DEAL_RAIL).map((row) => row.stepId));
  });

  it('reselects past the Gate 0 steps when the step it was on is retired', async () => {
    const store = fullOldCensusDeal();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await backfillRail(makeFakeAdmin(store));

    const byStep = Object.fromEntries(store.deal_steps.map((row) => [row.step_id, row]));
    expect(store.deals[0]).toMatchObject({ current_deal_step_id: 'row-p1-s8', current_step_seq: 8 });
    expect(byStep['p1-s8'].status).toBe('current');
    expect(byStep['p1-s7'].status).not.toBe('current');
    expect(byStep['p1-s6'].status).not.toBe('current');
    expect(byStep['g0-notify'].status).not.toBe('current');
  });

  it('places retired steps at the start of their phase by seq, keeping display order dense', async () => {
    const store = fullOldCensusDeal();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await backfillRail(makeFakeAdmin(store));

    const rows = byDisplayOrder(store.deal_steps);
    expect(rows.slice(0, 7).map((row) => [row.step_id, row.display_order, row.removed_at != null])).toEqual([
      ['p1-s1', 1, true],
      ['p1-s2', 2, true],
      ['p1-s3', 3, true],
      ['p1-s4', 4, true],
      ['p1-s5', 5, true],
      ['p1-s7', 6, false],
      ['p1-s6', 7, false],
    ]);
    expect(rows.map((row) => row.display_order)).toEqual(Array.from({ length: 66 }, (_, i) => i + 1));
  });
});
