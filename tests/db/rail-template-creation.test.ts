import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

import { GATE0_STEP_IDS } from '@/lib/rail/gate0';
import { materializeRail } from '@/lib/railTemplates/materialize';
import type { SkillBinding } from '@/lib/skillPublication/types';

import {
  binding,
  catalogStep,
  customStep,
  manifestOf,
  publishedSkill,
  skillDefinition,
  SEEDED_ID_A,
  SEEDED_ID_B,
  VERSION_SELECTED,
  DIGEST_SELECTED,
} from '../support/railTemplateFixtures';

const RUN = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN)('rail template creation', () => {
  it('creates independent deals transactionally from a captured revision', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();
    expect(() =>
      execFileSync(
        'psql',
        [
          db!,
          '-v',
          'ON_ERROR_STOP=1',
          '-f',
          'supabase/tests/rail_template_creation.sql',
        ],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });

  it('produces seed rows the database validator accepts', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();

    const imported: SkillBinding = binding(VERSION_SELECTED, DIGEST_SELECTED);
    const manifest = manifestOf(
      [
        catalogStep(),
        customStep({
          definition: skillDefinition(binding(VERSION_SELECTED, DIGEST_SELECTED)),
          effectiveSkill: publishedSkill(VERSION_SELECTED, DIGEST_SELECTED),
        }),
      ],
      'probe-rail',
    );
    const stepIds = { t0: SEEDED_ID_A, t1: SEEDED_ID_B };
    const bindings = { s0: imported };
    const seed = materializeRail(manifest, stepIds, bindings);
    expect(seed).toHaveLength(2);
    expect(seed[1].binding).toEqual(imported);

    const validate = (rows: unknown) =>
      execFileSync(
        'psql',
        [
          db!,
          '-v',
          'ON_ERROR_STOP=1',
          '-At',
          '-c',
          `select rail_template_validate_seed($j$${JSON.stringify(manifest)}$j$::jsonb, ` +
            `$j$${JSON.stringify(rows)}$j$::jsonb, ` +
            `$j$${JSON.stringify(stepIds)}$j$::jsonb, ` +
            `$j$${JSON.stringify(bindings)}$j$::jsonb)`,
        ],
        { stdio: 'pipe' },
      );

    expect(() => validate(seed)).not.toThrow();
    expect(() =>
      validate([{ ...seed[0], stepId: 'p1-s99' }, seed[1]]),
    ).toThrow(/invalid_command/);
    expect(() =>
      validate([seed[0], { ...seed[1], binding: binding(VERSION_SELECTED, 'e'.repeat(64)) }]),
    ).toThrow(/invalid_command/);
    expect(() => validate([seed[0]])).toThrow(/invalid_command/);
  });

  it('seeds the same Gate 0 receipt steps the rail declares', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();
    const out = execFileSync(
      'psql',
      [
        db!,
        '-At',
        '-c',
        "select array_to_string(rail_template_gate0_step_ids(), ',')",
      ],
      { stdio: 'pipe' },
    )
      .toString()
      .trim();
    expect(out.split(',')).toEqual([...GATE0_STEP_IDS]);
  });
});
