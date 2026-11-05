import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ActionCheckDefinition = { file: string; actions: string[] };

export const MIGRATIONS_DIR = join(process.cwd(), 'supabase/migrations');

function quoted(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

/**
 * Every definition of the audit_log.action CHECK, in migration order: the
 * inline CHECK of the permissions schema's `create table audit_log`, then each
 * `audit_log_action_check check (action in (...))` or
 * `... check (action = any (array[...]))` a later migration rebuilds.
 */
export function actionCheckHistory(dir = MIGRATIONS_DIR): ActionCheckDefinition[] {
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const history: ActionCheckDefinition[] = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const table = /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:public\.)?audit_log\s*\(([\s\S]*?)\n\);/i.exec(sql);
    const inline = table && /\baction\s+text\b[^,]*?check\s*\(\s*action\s+in\s*\(([^)]*)\)/i.exec(table[1]);
    if (inline) history.push({ file, actions: quoted(inline[1]) });
    for (const match of sql.matchAll(
      /audit_log_action_check\s+check\s*\(\s*action\s*(?:in\s*\(([^)]*)\)|=\s*any\s*\(\s*array\s*\[([\s\S]*?)\]\s*\))/gi,
    )) {
      history.push({ file, actions: quoted(match[1] ?? match[2]) });
    }
  }
  return history;
}

/** Migrations that add the action CHECK by name, whether or not it parsed. */
export function filesAddingActionCheck(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .filter((file) =>
      /add\s+constraint\s+audit_log_action_check\b/i.test(readFileSync(join(dir, file), 'utf8')),
    );
}

/** Actions some earlier definition allowed that the latest one does not. */
export function droppedActions(history: ActionCheckDefinition[]): string[] {
  const latest = history.at(-1);
  if (!latest) return [];
  const allowed = new Set(latest.actions);
  const earlier = new Set(history.slice(0, -1).flatMap((definition) => definition.actions));
  return [...earlier].filter((action) => !allowed.has(action)).sort();
}
