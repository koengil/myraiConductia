import type { Finding, Severity } from './findings';
import type { Route } from './router';

export type Decision = {
  conclusion: 'success' | 'failure';
  needsHuman: boolean;
  reasons: string[];
  summary: string;
};

const ORDER: Severity[] = ['blocking', 'major', 'minor', 'nit'];

/** Plain code on purpose: the verdict never depends on a model's prose. `findings` are already validated and evaluated. */
export function decide({ route, findings }: { route: Pick<Route, 'fenced'>; findings: Finding[] }): Decision {
  const counts = Object.fromEntries(ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity] += 1;

  const reasons: string[] = [];
  if (counts.blocking > 0) reasons.push(`${counts.blocking} confirmed blocking finding(s)`);
  if (route.fenced.length > 0) reasons.push(`${route.fenced.length} path(s) inside the human-reviewed fence`);

  const lines = [
    '### AI review',
    '',
    ORDER.map((s) => `${s}: ${counts[s]}`).join(' | '),
  ];
  if (route.fenced.length > 0) {
    lines.push('', 'Fenced paths, including the old path of a rename (a human reviewer is required):', ...route.fenced.map((p) => `- \`${p}\``));
  }

  return {
    conclusion: counts.blocking > 0 ? 'failure' : 'success',
    needsHuman: counts.blocking > 0 || route.fenced.length > 0,
    reasons,
    summary: lines.join('\n'),
  };
}
