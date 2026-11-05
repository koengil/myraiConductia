// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAILBOX_DERIVED_TABLES,
  NOT_MAILBOX_DERIVED_TABLES,
  TENANT_PURGE_KEPT,
  TENANT_PURGE_TABLES,
} from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';

/**
 * Every table and view is classified as mailbox-derived or not (#262, R14), so
 * a new one must be placed on purpose. Mailbox-derived names are reachable by
 * agents, tools, search and retrieval only through
 * @/lib/mailboxAccess/accessors (tests/agent-surfaces.test.ts).
 */

const derived: readonly string[] = MAILBOX_DERIVED_TABLES;
const other: readonly string[] = NOT_MAILBOX_DERIVED_TABLES;

const snapshot = readFileSync(join(process.cwd(), 'supabase/schema-snapshot.txt'), 'utf8')
  .split('\n')
  .flatMap((line) => {
    const match = /^(?:table|view) (\S+)$/.exec(line);
    return match ? [match[1]] : [];
  });

describe('table classification', () => {
  it('reads tables and views from the committed snapshot', () => {
    expect(snapshot.length).toBeGreaterThan(50);
    expect(snapshot).toContain('allowed_mailboxes');
  });

  it('places every TABLE value in exactly one list', () => {
    const unplaced = Object.values(TABLE).filter((name) => !derived.includes(name) && !other.includes(name));
    expect(unplaced, 'classify in src/lib/constants/discovery.ts').toEqual([]);
  });

  it('places every table and view of the snapshot in exactly one list', () => {
    const unplaced = snapshot.filter((name) => !derived.includes(name) && !other.includes(name));
    expect(unplaced, 'classify in src/lib/constants/discovery.ts').toEqual([]);
  });

  it('classifies every discovery output table as mailbox-derived and present in the snapshot', () => {
    // Model outputs and the MD's decisions about mail (ADR-0017 decision 1, E2).
    const outputs = ['milestone_events', 'stage_assessments', 'model_calls', 'corrections', 'discovery_recompute_requests'];
    expect(outputs.filter((name) => !derived.includes(name))).toEqual([]);
    expect(outputs.filter((name) => other.includes(name))).toEqual([]);
    expect(outputs.filter((name) => !snapshot.includes(name))).toEqual([]);
  });

  it('classifies the team inbox registry as mailbox-derived, kept at tenant purge, and present in the snapshot (#581)', () => {
    expect(derived).toContain(TABLE.TEAM_MAILBOXES);
    expect(other).not.toContain(TABLE.TEAM_MAILBOXES);
    expect(Object.keys(TENANT_PURGE_KEPT)).toContain(TABLE.TEAM_MAILBOXES);
    expect(snapshot).toContain(TABLE.TEAM_MAILBOXES);
  });

  it('classifies the team inbox member list and its readers view as mailbox-derived, kept at tenant purge, and present in the snapshot (#581)', () => {
    for (const name of [TABLE.TEAM_MAILBOX_MEMBERS, TABLE.TEAM_MAILBOX_READERS]) {
      expect(derived, name).toContain(name);
      expect(other, name).not.toContain(name);
      expect(Object.keys(TENANT_PURGE_KEPT), name).toContain(name);
      expect(snapshot, name).toContain(name);
    }
  });

  it('names no table that is in both lists', () => {
    expect(derived.filter((name) => other.includes(name))).toEqual([]);
  });

  it('names no table the snapshot does not have', () => {
    expect([...derived, ...other].filter((name) => !snapshot.includes(name))).toEqual([]);
  });

  it('gives every mailbox-derived table a tenant purge fate: purged, or kept with a reason (#461)', () => {
    const purged = Object.keys(TENANT_PURGE_TABLES);
    const kept = Object.keys(TENANT_PURGE_KEPT);
    expect(derived.filter((name) => !purged.includes(name) && !kept.includes(name)), 'decide in TENANT_PURGE_*').toEqual([]);
    expect(purged.filter((name) => kept.includes(name))).toEqual([]);
    expect([...purged, ...kept].filter((name) => !derived.includes(name))).toEqual([]);
    for (const [table, predicate] of Object.entries(TENANT_PURGE_TABLES)) {
      expect(predicate, table).toContain(":'tenant'");
    }
    for (const [table, reason] of Object.entries(TENANT_PURGE_KEPT)) {
      expect(reason.trim().length, table).toBeGreaterThan(0);
    }
  });

  it('keeps each list unique, and the not-derived list sorted', () => {
    expect(new Set(derived).size).toBe(derived.length);
    expect(new Set(other).size).toBe(other.length);
    expect([...other]).toEqual([...other].sort());
  });
});
