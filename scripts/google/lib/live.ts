import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { keyMaterialProblems } from '../../../src/lib/secrets/keyMaterial';

/** Every script that touches Google refuses to start without --live and a
 * --confirm-domain that equals the domain it is about to act on. The seeders
 * and the recorder also refuse any domain not listed as a test domain in
 * .secrets/google/seeding.json (#259 plan, "Implementation Approach"). */
export function requireLiveRun(argv: string[], expectedDomain: string, opts: { testDomains?: string[] } = {}): void {
  if (!argv.includes('--live')) throw new Error('Refusing: pass --live after announcing the run to the owner');
  const i = argv.indexOf('--confirm-domain');
  const confirmed = i === -1 ? null : argv[i + 1]?.toLowerCase();
  if (confirmed !== expectedDomain.toLowerCase()) {
    throw new Error(`Refusing: --confirm-domain must equal ${expectedDomain}`);
  }
  if (opts.testDomains && !opts.testDomains.map((d) => d.toLowerCase()).includes(expectedDomain.toLowerCase())) {
    throw new Error(`Refusing: ${expectedDomain} is not a test domain in .secrets/google/seeding.json`);
  }
}

/** The one-line announcement printed before any Google call. */
export function announceLiveRun(script: string, domain: string, callerLabel: string): void {
  console.log(`LIVE Google run: ${script} against ${domain} as ${callerLabel}`);
}

/** Reads the value of `--name value`, or null when the flag is absent. */
export function argValue(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

/** Refuses a JSON file that holds key material anywhere in .secrets/. */
export function assertSecretsFolderKeyless(dir: string): void {
  if (!existsSync(dir)) return;
  const offenders: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      const problems = keyMaterialProblems(parsed);
      if (problems.length > 0) offenders.push(`${relative(dir, path)} ${problems.join(', ')}`);
    }
  };
  walk(dir);
  if (offenders.length > 0) {
    throw new Error(`Refusing: key material in ${dir}: ${offenders.join('; ')}. Use workload identity federation or impersonated ADC`);
  }
}

/** Recordings and probe reports never land in the repo, except under evals/out/. */
export function assertOutsideRepo(path: string, repoRoot: string = process.cwd(), allowedInside: string[] = []): string {
  const target = resolve(path);
  const root = resolve(repoRoot);
  const rel = relative(root, target);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) return target;
  const allowed = allowedInside.some((a) => {
    const r = relative(resolve(root, a), target);
    return r === '' || (!r.startsWith('..') && !isAbsolute(r));
  });
  if (!allowed) {
    const hint = allowedInside.length > 0 ? ` (only ${allowedInside.join(', ')} is allowed inside the repo)` : '';
    throw new Error(`Refusing to write inside the repo: ${target}${hint}`);
  }
  return target;
}

export function defaultProbeDir(): string {
  return join(homedir(), '.conductia', 'google-probe');
}
