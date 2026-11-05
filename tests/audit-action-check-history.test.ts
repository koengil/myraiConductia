import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, DISCOVERY_AUDIT_ACTIONS } from '@/lib/constants/audit';
import {
  actionCheckHistory,
  droppedActions,
  filesAddingActionCheck,
} from './helpers/auditActionCheck';

// Each migration that widens the audit_log.action CHECK drops and re-adds it
// with a full list. A migration written against an older list silently drops
// every action added since, and each write of a dropped action then fails in
// production. That happened once already: 20260925100000_audit_hash_chain was
// cut before 20260921100000/20260921110000 and rebuilt the CHECK without the
// three rail.template_* actions.
describe('the audit_log action CHECK never loses an action', () => {
  const history = actionCheckHistory();

  it('parses every definition of the CHECK', () => {
    expect(history[0]?.file).toBe('20260604100000_permissions_schema.sql');
    const parsed = new Set(history.slice(1).map((definition) => definition.file));
    for (const file of filesAddingActionCheck()) expect(parsed, file).toContain(file);
    for (const definition of history) expect(definition.actions.length, definition.file).toBeGreaterThan(0);
  });

  it('keeps, in the latest CHECK, every action any earlier CHECK allowed', () => {
    expect(droppedActions(history), `latest: ${history.at(-1)?.file}`).toEqual([]);
  });

  it('allows every action the application writes', () => {
    const latest = history.at(-1)?.actions ?? [];
    for (const action of [...AUDIT_ACTIONS, ...DISCOVERY_AUDIT_ACTIONS]) {
      expect(latest, action).toContain(action);
    }
  });

  it('reports an action that a later rebuild leaves out', () => {
    expect(
      droppedActions([
        { file: 'a.sql', actions: ['view', 'rail.template_created'] },
        { file: 'b.sql', actions: ['view', 'rail.template_created', 'rail.template_applied'] },
        { file: 'c.sql', actions: ['view', 'discovery.correction'] },
      ]),
    ).toEqual(['rail.template_applied', 'rail.template_created']);
  });
});
