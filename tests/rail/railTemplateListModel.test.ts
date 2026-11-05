import { describe, expect, it } from 'vitest';

import {
  groupTemplates,
  publishAudience,
  startingPointLine,
  templateMeta,
} from '@/app/(authed)/rail-templates/templateListModel';
import type { RailTemplateSummary } from '@/lib/rail/railTemplateModel';

const builtIn: RailTemplateSummary = {
  id: null,
  name: 'Default',
  kind: 'default',
  stepCount: 61,
  forkedFromName: null,
  forkedFromRemoved: false,
  createdAt: null,
};

function saved(id: string, name: string, extra: Partial<RailTemplateSummary> = {}): RailTemplateSummary {
  return {
    id,
    name,
    kind: 'saved',
    stepCount: 58,
    forkedFromName: 'Default',
    forkedFromRemoved: false,
    createdAt: '2026-10-01T12:00:00Z',
    ...extra,
  };
}

describe('groupTemplates', () => {
  const list = [builtIn, saved('a', 'Carve-out'), saved('b', 'Tech sell-side'), saved('c', 'Healthcare carve-out')];

  it('puts the built-in default first, then the firm templates', () => {
    expect(groupTemplates(list, '').map((g) => [g.label, g.templates.map((t) => t.name)])).toEqual([
      ['Built in', ['Default']],
      ['Saved by your firm', ['Carve-out', 'Tech sell-side', 'Healthcare carve-out']],
    ]);
  });

  it('filters by name, ignoring case and outer spaces, and drops empty groups', () => {
    expect(groupTemplates(list, '  CARVE ').map((g) => [g.id, g.templates.map((t) => t.name)])).toEqual([
      ['saved', ['Carve-out', 'Healthcare carve-out']],
    ]);
    expect(groupTemplates(list, 'zzz')).toEqual([]);
  });
});

describe('startingPointLine', () => {
  it('says a new template starts from the default rail, with its step count', () => {
    expect(startingPointLine('', [builtIn])).toBe(
      'Starts from your default rail. A new deal gets it unless someone picks a template, and its 61 steps come across in their phases.',
    );
  });

  it('names a saved source when one is chosen', () => {
    expect(startingPointLine('a', [builtIn, saved('a', 'Carve-out', { stepCount: 1 })])).toBe(
      'Starts as a copy of Carve-out, and its 1 step comes across in their phases. Carve-out stays as it is.',
    );
  });

  it('carries no em dash', () => {
    expect(startingPointLine('', [builtIn])).not.toContain('—');
  });
});

describe('templateMeta', () => {
  it('reads the source and step count', () => {
    expect(templateMeta(builtIn)).toBe('Built into Conductia · 61 steps');
    expect(templateMeta(saved('a', 'X'))).toBe('Started from Default · 58 steps');
    expect(templateMeta(saved('a', 'X', { forkedFromName: 'Old', forkedFromRemoved: true }))).toBe(
      'Started from Old, since removed · 58 steps',
    );
  });
});

describe('publishAudience', () => {
  const published = { version: 2, revisionId: 'r', publishedAt: '2026-10-02T00:00:00Z' };

  it('before the first publish: no deal uses it yet', () => {
    expect(publishAudience('Rob', null, true)).toBe('Publishing lets new deals start from Rob. No deal uses it yet.');
  });

  it('with template change review on: new deals, then a reviewed offer to open deals', () => {
    expect(publishAudience('Rob', published, true)).toBe(
      'New deals that start from Rob get the published version. Open deals on Rob get a notice, and their team accepts or discards each added or removed step. Nothing changes on those deals until they choose.',
    );
  });

  it('with it off: open deals keep their rail', () => {
    expect(publishAudience('Rob', published, false)).toBe(
      'New deals that start from Rob get the published version. Open deals keep the rail they started with.',
    );
  });
});
