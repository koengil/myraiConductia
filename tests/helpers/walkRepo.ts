import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every file under a repo-relative root, as repo-relative paths. Tolerates a
 * missing root, and skips node_modules and dot directories.
 */
export function walk(root: string, base = process.cwd()): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else out.push(relative(base, path));
    }
  };
  visit(join(base, root));
  return out.sort();
}
