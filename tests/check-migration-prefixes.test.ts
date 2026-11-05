import { describe, expect, it } from 'vitest';
import {
  findPrefixProblems,
  findReleasedFileProblems,
  parseLsTree,
} from '../scripts/check-migration-prefixes';

describe('migration prefix check', () => {
  it('passes a clean chain', () => {
    expect(
      findPrefixProblems([
        '20260603000000_feature_flags.sql',
        '20260604100000_permissions_schema.sql',
        '20260903130000_deal_step_bench_session.sql',
      ]),
    ).toEqual([]);
  });

  it('names both files of the in-flight 20260919120000 collision', () => {
    expect(
      findPrefixProblems([
        '20260919120000_pending_agent_runs.sql',
        '20260903130000_deal_step_bench_session.sql',
        '20260919120000_lead_personas_conductia_tenant.sql',
      ]),
    ).toEqual([
      'duplicate 20260919120000: 20260919120000_lead_personas_conductia_tenant.sql, 20260919120000_pending_agent_runs.sql',
    ]);
  });

  it('reports every file sharing a prefix, and each colliding prefix once', () => {
    expect(
      findPrefixProblems([
        '20260101000000_a.sql',
        '20260101000000_b.sql',
        '20260101000000_c.sql',
        '20260202000000_d.sql',
        '20260202000000_e.sql',
      ]),
    ).toEqual([
      'duplicate 20260101000000: 20260101000000_a.sql, 20260101000000_b.sql, 20260101000000_c.sql',
      'duplicate 20260202000000: 20260202000000_d.sql, 20260202000000_e.sql',
    ]);
  });

  it('flags malformed names', () => {
    expect(
      findPrefixProblems([
        '2026091912000_short_prefix.sql',
        '20260919120000-dash_separator.sql',
        '20260919120000_Upper_Case.sql',
        'feature_flags.sql',
        '20260919120000_.sql',
      ]),
    ).toEqual([
      'malformed: 20260919120000-dash_separator.sql',
      'malformed: 20260919120000_.sql',
      'malformed: 20260919120000_Upper_Case.sql',
      'malformed: 2026091912000_short_prefix.sql',
      'malformed: feature_flags.sql',
    ]);
  });

  it('ignores files that are not .sql', () => {
    expect(
      findPrefixProblems(['README.md', '.gitkeep', '20260603000000_feature_flags.sql']),
    ).toEqual([]);
  });

  it('does not count a malformed name toward a duplicate', () => {
    expect(
      findPrefixProblems(['20260603000000_feature_flags.sql', '20260603000000_Feature.sql']),
    ).toEqual(['malformed: 20260603000000_Feature.sql']);
  });
});

describe('released migration file check', () => {
  const released = new Map([
    ['20260603000000_feature_flags.sql', 'aaa1'],
    ['20260604100000_permissions_schema.sql', 'bbb2'],
  ]);

  it('passes when every released file is unchanged and new files are added', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([...released, ['20261008120000_new_table.sql', 'ccc3']]),
      ),
    ).toEqual([]);
  });

  it('names a released file whose content changed', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([
          ['20260603000000_feature_flags.sql', 'aaa1'],
          ['20260604100000_permissions_schema.sql', 'eee5'],
        ]),
      ),
    ).toEqual(['changed after release: 20260604100000_permissions_schema.sql']);
  });

  it('names a released file that was removed', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([['20260604100000_permissions_schema.sql', 'bbb2']]),
      ),
    ).toEqual(['removed after release: 20260603000000_feature_flags.sql']);
  });

  it('reports a renamed released file as removed, even with identical content', () => {
    expect(
      findReleasedFileProblems(
        released,
        new Map([
          ['20260603000000_feature_flags.sql', 'aaa1'],
          ['20261008120000_permissions_schema.sql', 'bbb2'],
        ]),
      ),
    ).toEqual(['removed after release: 20260604100000_permissions_schema.sql']);
  });

  it('reports every problem, in filename order', () => {
    expect(
      findReleasedFileProblems(
        new Map([
          ['20260604100000_permissions_schema.sql', 'bbb2'],
          ['20260603000000_feature_flags.sql', 'aaa1'],
        ]),
        new Map([['20260603000000_feature_flags.sql', 'fff6']]),
      ),
    ).toEqual([
      'changed after release: 20260603000000_feature_flags.sql',
      'removed after release: 20260604100000_permissions_schema.sql',
    ]);
  });

  it('ignores released files that are not .sql', () => {
    expect(
      findReleasedFileProblems(
        new Map([
          ['README.md', 'aaa1'],
          ['.gitkeep', 'bbb2'],
          ['20260603000000_feature_flags.sql', 'ccc3'],
        ]),
        new Map([['20260603000000_feature_flags.sql', 'ccc3']]),
      ),
    ).toEqual([]);
  });

  it('passes when nothing is released yet', () => {
    expect(
      findReleasedFileProblems(new Map(), new Map([['20260603000000_feature_flags.sql', 'aaa1']])),
    ).toEqual([]);
  });
});

describe('git ls-tree parsing', () => {
  it('maps each file name to its blob id and skips entries that are not files', () => {
    expect(
      parseLsTree(
        [
          '100644 blob aaa1\tsupabase/migrations/20260603000000_feature_flags.sql',
          '040000 tree ddd4\tsupabase/migrations/archive',
          '100644 blob bbb2\tsupabase/migrations/20260604100000_permissions_schema.sql',
          '',
        ].join('\n'),
      ),
    ).toEqual(
      new Map([
        ['20260603000000_feature_flags.sql', 'aaa1'],
        ['20260604100000_permissions_schema.sql', 'bbb2'],
      ]),
    );
  });

  it('returns nothing for empty output', () => {
    expect(parseLsTree('')).toEqual(new Map());
  });
});
