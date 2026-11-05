// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import {
  READER_HEALTH_STATES,
  READER_LIVENESS_SECONDS,
  READER_PASS_IN_PROGRESS_SECONDS,
  SOURCE_HEALTH_STATES,
} from '@/lib/constants/discovery';
import { QUEUE, QUEUE_OPTIONS } from '../../worker/boss';

// The live definition of a function: its text in the latest migration that (re)creates it. The health RPC and its
// helpers need not share a migration (#353 re-creates the RPC alone).
const migrations = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(`supabase/migrations/${f}`, 'utf8').replace(/--.*$/gm, ''));
function liveDefinition(name: string): string {
  const pattern = new RegExp(`create or replace function ${name}\\([\\s\\S]*?\\n\\$\\$;`);
  return migrations.map((sql) => pattern.exec(sql)?.[0]).filter((sql): sql is string => sql !== undefined).at(-1) ?? '';
}
const healthSql = liveDefinition('discovery_ingestion_health');
const liveSql = liveDefinition('discovery_reader_live');
const stateFn = /function discovery_source_health_state\([\s\S]*?\$\$([\s\S]*?)\$\$/.exec(liveDefinition('discovery_source_health_state'))?.[1] ?? '';

// The reader pass record (#370): a pass with no end reads "In progress" for as long as pg-boss may still be running
// its job, then "No end recorded". The cutoff is the discovery.sync expiry, in TypeScript and in the health SQL.
it('the in-progress cutoff is the discovery.sync expiry, in TS and in the live health SQL', () => {
  expect(READER_PASS_IN_PROGRESS_SECONDS).toBe(QUEUE_OPTIONS[QUEUE.SYNC].expireInSeconds);
  expect(healthSql).not.toBe('');
  expect(liveSql).not.toBe('');
  expect(healthSql.match(/interval '3600 seconds'/g)).toHaveLength(2);
  expect(
    [...`${healthSql}\n${liveSql}`.matchAll(/interval '(\d+) seconds'/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n !== READER_PASS_IN_PROGRESS_SECONDS),
  ).toEqual([READER_LIVENESS_SECONDS]); // the one window, inside discovery_reader_live (n1)
});

it("the source states are the SQL function's, in its order", () => {
  expect(stateFn).not.toBe('');
  expect([...stateFn.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => m[1] ?? m[2])).toEqual(SOURCE_HEALTH_STATES);
});

it("the reader line's states are the SQL CASE's, in its order", () => {
  const readerCase = /'reader',\s*\([\s\S]*?'state',\s*case([\s\S]*?)\bend\)/.exec(healthSql)?.[1] ?? '';
  expect(readerCase).not.toBe('');
  expect([...readerCase.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map((m) => m[1] ?? m[2])).toEqual(READER_HEALTH_STATES);
});
