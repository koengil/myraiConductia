import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';
import { readRailTemplate } from '@/lib/rail/railTemplateRead';

const COMPANY = 'cccccccc-0000-4000-8000-000000000001';
const TEMPLATE = '77777777-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;

function tableStub(rows: Row[]) {
  let current = rows;
  const self = {
    select: () => self,
    eq: (column: string, value: unknown) => {
      current = current.filter((row) => row[column] === value);
      return self;
    },
    is: (column: string, value: unknown) => {
      current = current.filter((row) => (row[column] ?? null) === value);
      return self;
    },
    maybeSingle: async () => ({ data: current[0] ?? null, error: null }),
    then: (resolve: (value: unknown) => void) => resolve({ data: current, error: null }),
  };
  return self;
}

function adminWith(publication: { data: unknown; error: { message: string } | null }) {
  const tables: Record<string, Row[]> = {
    [TABLE.RAIL_CATALOG_TEMPLATES]: [
      { id: TEMPLATE, company_id: COMPANY, name: 'Sell-side', forked_from_id: null, deleted_at: null, description: 'For carve-outs.' },
    ],
    [TABLE.RAIL_CATALOG_STEPS]: [
      {
        id: 'row-1',
        template_id: TEMPLATE,
        step_id: 'p1-s10',
        seq: 10,
        phase_index: 1,
        display_order: 1,
        origin: 'catalog',
        definition: null,
      },
    ],
  };
  const rpc = vi.fn<(name: string, params: Record<string, unknown>) => Promise<typeof publication>>(
    async () => publication,
  );
  const admin = {
    from: (table: string) => tableStub(tables[table] ?? []),
    rpc,
  } as unknown as SupabaseClient;
  return { admin, rpc };
}

describe('readRailTemplate publication state', () => {
  it('reports the published version and unpublished changes of a saved template', async () => {
    const { admin, rpc } = adminWith({
      data: {
        published: { version: 3, revisionId: 'rev-3', publishedAt: '2026-10-02T12:00:00.000Z' },
        hasUnpublishedChanges: true,
      },
      error: null,
    });

    const detail = await readRailTemplate(admin, COMPANY, TEMPLATE);

    expect(detail).not.toBe('missing');
    if (detail === 'missing') return;
    expect(detail.published).toEqual({
      version: 3,
      revisionId: 'rev-3',
      publishedAt: '2026-10-02T12:00:00.000Z',
    });
    expect(detail.hasUnpublishedChanges).toBe(true);
    expect(rpc).toHaveBeenCalledWith('rail_catalog_publication', { p_template_id: TEMPLATE });
  });

  it('reports a template that was never published', async () => {
    const { admin } = adminWith({
      data: { published: null, hasUnpublishedChanges: true },
      error: null,
    });

    const detail = await readRailTemplate(admin, COMPANY, TEMPLATE);

    expect(detail === 'missing' ? undefined : detail.published).toBeNull();
  });

  it('never asks about the house default, which is not published', async () => {
    const { admin, rpc } = adminWith({ data: null, error: null });

    const detail = await readRailTemplate(admin, COMPANY, 'default');

    expect(detail === 'missing' ? undefined : detail.published).toBeNull();
    expect(detail === 'missing' ? undefined : detail.hasUnpublishedChanges).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails when the publication cannot be read', async () => {
    const { admin } = adminWith({ data: null, error: { message: 'connection lost' } });

    const failure = await readRailTemplate(admin, COMPANY, TEMPLATE).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Rail template save read failed (unexpected)');
  });

  it('fails on a malformed publication', async () => {
    const { admin } = adminWith({
      data: { published: { version: '3', revisionId: 'rev-3', publishedAt: 'x' }, hasUnpublishedChanges: true },
      error: null,
    });

    await expect(readRailTemplate(admin, COMPANY, TEMPLATE)).rejects.toThrow(
      'Could not read the published version.',
    );
  });

  it('reports the description of a saved template and none for the house default', async () => {
    const { admin } = adminWith({
      data: { published: null, hasUnpublishedChanges: true },
      error: null,
    });

    const saved = await readRailTemplate(admin, COMPANY, TEMPLATE);
    const house = await readRailTemplate(admin, COMPANY, 'default');

    expect(saved).not.toBe('missing');
    expect(house).not.toBe('missing');
    if (saved === 'missing' || house === 'missing') return;
    expect(saved.template.description).toBe('For carve-outs.');
    expect(house.template.description).toBe('');
  });
});
