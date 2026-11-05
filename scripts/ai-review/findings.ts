/*
 * The contract between reviewers, the validator and the evaluator. Every model
 * reply is untrusted text, so each shape is checked at runtime before it is used.
 */

export const SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LENSES = ['generalist', 'governance', 'tests-agentic'] as const;
export type Lens = (typeof LENSES)[number];

export const VERDICTS = ['confirmed', 'rejected', 'unclear'] as const;
export type VerdictValue = (typeof VERDICTS)[number];

export type Finding = {
  id: string;
  lens: Lens;
  file: string;
  line: number;
  severity: Severity;
  claim: string;
  evidence: string;
  /** A read-only command or trace the validator can repeat. */
  check?: string;
};

export type ReviewerOutput = {
  lens: Lens;
  findings: Finding[];
};

export type Verdict = {
  id: string;
  verdict: VerdictValue;
  evidence: string;
};

function fail(where: string, why: string): never {
  throw new Error(`ai-review: invalid ${where}: ${why}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') fail(where, `"${key}" must be a non-empty string`);
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[], where: string): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(where, `"${key}" must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}

function parseFinding(raw: unknown, index: number): Finding {
  const where = `finding[${index}]`;
  if (!isRecord(raw)) fail(where, 'must be an object');
  const line = raw.line;
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) fail(where, '"line" must be a positive integer');
  const finding: Finding = {
    id: str(raw, 'id', where),
    lens: oneOf(raw, 'lens', LENSES, where),
    file: str(raw, 'file', where),
    line,
    severity: oneOf(raw, 'severity', SEVERITIES, where),
    claim: str(raw, 'claim', where),
    evidence: str(raw, 'evidence', where),
  };
  if (raw.check !== undefined) {
    if (typeof raw.check !== 'string') fail(where, '"check" must be a string when present');
    finding.check = raw.check;
  }
  return finding;
}

export function parseFindings(json: unknown): Finding[] {
  if (!Array.isArray(json)) fail('findings', 'must be an array');
  return json.map(parseFinding);
}

export function parseReviewerOutput(json: unknown): ReviewerOutput {
  if (!isRecord(json)) fail('reviewer output', 'must be an object');
  const lens = oneOf(json, 'lens', LENSES, 'reviewer output');
  const findings = parseFindings(json.findings);
  const ids = new Set<string>();
  for (const f of findings) {
    if (ids.has(f.id)) fail('reviewer output', `duplicate finding id "${f.id}"`);
    ids.add(f.id);
  }
  return { lens, findings };
}

export function parseVerdicts(json: unknown): Verdict[] {
  const list = isRecord(json) ? json.verdicts : json;
  if (!Array.isArray(list)) fail('verdicts', 'must be an array or an object with a "verdicts" array');
  return list.map((raw, i) => {
    const where = `verdict[${i}]`;
    if (!isRecord(raw)) fail(where, 'must be an object');
    return {
      id: str(raw, 'id', where),
      verdict: oneOf(raw, 'verdict', VERDICTS, where),
      evidence: str(raw, 'evidence', where),
    };
  });
}
