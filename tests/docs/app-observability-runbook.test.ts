// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EventTable, Shape } from '@/lib/log/clean';
import { FIELD_TABLE } from '@/lib/log/fields';

/*
 * A lint over docs/04-operations/app-observability-runbook.md (#474 slice 1,
 * design Q-A, Q-B, Q5, Q8, threads T1, T3, T6 and T7). It catches a runbook
 * that drifts from the logger: an event, a field, a required flag or a value
 * the field table does not have, or one it has and the page leaves out. It
 * also catches an alarm name the module does not create, a reordered or
 * unverified owner step, a dropped limit or open item, and a SOC 2 row that
 * stops naming what is still open. It is not the control: it cannot stop an
 * owner skipping a step.
 */

const root = process.cwd();
const runbookPath = join(root, 'docs/04-operations/app-observability-runbook.md');
const registerPath = join(root, 'docs/08-security/soc2-control-register.md');
const decisionLogPath = join(root, 'docs/07-decisions/decision-log.md');
const awsRunbookPath = join(root, 'docs/04-operations/discovery-worker-aws-runbook.md');

const read = (path: string) => readFileSync(path, 'utf8');
const runbook = read(runbookPath);
const register = read(registerPath);
const decisionLog = read(decisionLogPath);
const awsRunbook = read(awsRunbookPath);
const alarmsTf = read(join(root, 'infra/discovery-worker/alarms.tf'));
const localsTf = read(join(root, 'infra/discovery-worker/locals.tf'));
const loggerIndex = read(join(root, 'src/lib/log/index.ts'));

const TABLE: EventTable = FIELD_TABLE;
const EVENTS = Object.keys(TABLE);

/** The text of the unnumbered `## <title>` section, up to the next `## ` heading. */
function section(title: string): string {
  const start = runbook.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`section ${title} not found`);
  const next = runbook.indexOf('\n## ', start + 1);
  return runbook.slice(start, next < 0 ? runbook.length : next);
}

type Step = { number: number; title: string; body: string };

/** The numbered `## N. Title` steps, each with its text up to the next `## ` heading. */
function steps(text: string): Step[] {
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => ({ heading: m[1], index: m.index ?? 0 }));
  return headings.flatMap((h, i) => {
    const numbered = /^(\d+)\. (.+)$/.exec(h.heading);
    if (!numbered) return [];
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    return [{ number: Number(numbered[1]), title: numbered[2], body: text.slice(h.index, end) }];
  });
}

const all = steps(runbook);
const numberOf = (pattern: RegExp): number => {
  const found = all.find((s) => pattern.test(s.title));
  if (!found) throw new Error(`no step title matches ${pattern}`);
  return found.number;
};
const stepBody = (pattern: RegExp): string => all.find((s) => s.number === numberOf(pattern))?.body ?? '';

/** The `### \`evt\`` subsections of the Events section. */
function eventSections(): Map<string, string> {
  const events = section('Events');
  const headings = [...events.matchAll(/^### (.+)$/gm)].map((m) => ({ heading: m[1], index: m.index ?? 0 }));
  const out = new Map<string, string>();
  headings.forEach((h, i) => {
    const evt = /^`(\w+)`$/.exec(h.heading)?.[1];
    if (evt) out.set(evt, events.slice(h.index, i + 1 < headings.length ? headings[i + 1].index : events.length));
  });
  return out;
}

type Row = { field: string; required: boolean; values: string };

/** The rows of the `| Field | Required | Values |` table in `text`. */
function fieldRows(text: string): Row[] {
  const start = text.indexOf('| Field | Required | Values |');
  if (start < 0) return [];
  const rows: Row[] = [];
  for (const line of text.slice(start).split('\n').slice(2)) {
    const m = /^\| `(\w+)` \| (yes|no) \| (.+) \|$/.exec(line);
    if (!m) break;
    rows.push({ field: m[1], required: m[2] === 'yes', values: m[3] });
  }
  return rows;
}

/** How the page writes the values a cleaner accepts. */
function expectedValues(shape: Shape): { backticked: string[] } | { text: string } {
  if ('oneOf' in shape) return { backticked: shape.oneOf.map(String) };
  if ('uuid' in shape) return { text: 'a UUID' };
  return { text: `an integer, ${shape.int[0]} to ${shape.int[1]}` };
}

/** Every shell command that begins with `prefix`, joined across its `\` continuation lines. */
function commands(text: string, prefix: string): string[] {
  const lines = text.split('\n');
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith(prefix)) continue;
    let command = lines[i].trim();
    while (command.endsWith('\\') && i + 1 < lines.length) {
      i += 1;
      command = `${command.slice(0, -1).trim()} ${lines[i].trim()}`;
    }
    found.push(command);
  }
  return found;
}

/** Relative markdown link targets (`](./x)` or `](../x)`), without any anchor. */
function relativeLinks(text: string): string[] {
  return [...text.matchAll(/\]\((\.{1,2}\/[^)\s#]+)(?:#[^)\s]*)?\)/g)].map((m) => m[1]);
}

describe('the events section (design Q1)', () => {
  it('has one subsection per FIELD_TABLE event, and no other', () => {
    expect([...eventSections().keys()].sort()).toEqual([...EVENTS].sort());
  });

  it('lists every field in table order, with its required flag and exactly the values its cleaner accepts', () => {
    const sections = eventSections();
    for (const evt of EVENTS) {
      const rows = fieldRows(sections.get(evt) ?? '');
      const spec = TABLE[evt];
      // Table order is the order of the line, which the literal full-text searches rely on.
      expect(rows.map((r) => r.field), evt).toEqual(Object.keys(spec));
      for (const row of rows) {
        const field = spec[row.field];
        expect(row.required, `${evt}.${row.field} required`).toBe(field.required);
        const expected = expectedValues(field.clean.shape);
        if ('backticked' in expected) {
          const written = [...row.values.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
          expect(written, `${evt}.${row.field} values`).toEqual(expected.backticked);
        } else {
          expect(row.values, `${evt}.${row.field} values`).toBe(expected.text);
        }
      }
    }
  });

  it('states each event at the level the logger writes it', () => {
    const levels = new Map([...loggerIndex.matchAll(/^\s+(\w+): '(info|warn|error)',$/gm)].map((m): [string, string] => [m[1], m[2]]));
    expect([...levels.keys()].sort()).toEqual([...EVENTS].sort());
    const sections = eventSections();
    for (const evt of EVENTS) {
      expect(sections.get(evt), evt).toMatch(new RegExp(`^Level ${levels.get(evt)}\\b`, 'm'));
    }
    // A success is logged at info: the one exception levelOf() makes.
    expect(loggerIndex).toMatch(/line\.evt === 'model_outcome' && line\.outcome === 'ok'\) return 'info'/);
    expect(sections.get('model_outcome')).toMatch(/^Level error for a failure, info for `ok`\./m);
  });

  it('names the rejected line exactly as the logger writes it', () => {
    expect(loggerIndex).toContain("evt: 'log_line_rejected'");
    expect(section('Events')).toContain('`{"evt":"log_line_rejected"}`');
  });

  it('cites only events the logger writes', () => {
    for (const m of runbook.matchAll(/"evt":"(\w+)"/g)) expect([...EVENTS, 'log_line_rejected'], m[1]).toContain(m[1]);
  });

  it('states the counting rule: one line per attempt, up to three ZDR lines per item (Q-B, D106)', () => {
    expect(section('Events')).toMatch(/\*\*Counting rule: one line is one attempt, not one incident\.\*\*/);
    expect(section('Events')).toMatch(/up to three `zdr_unavailable` lines/);
    expect(section('Events')).toContain('ZDR_RETRY_DELAYS_MS');
  });
});

describe('the alarms it cites (design Q5)', () => {
  const alarmNames = new Set([...alarmsTf.matchAll(/alarm_name\s*=\s*"([a-z-]+)"/g)].map((m) => m[1]));
  const localNames = new Set([...localsTf.matchAll(/=\s*"(conductia-discovery[a-z-]*)"/g)].map((m) => m[1]));

  it('names only alarms, services and families the module creates', () => {
    const cited = [...runbook.matchAll(/\bconductia-discovery-[a-z-]*[a-z]/g)].map((m) => m[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const name of cited) expect(alarmNames.has(name) || localNames.has(name), name).toBe(true);
  });

  it('cites the extract alarm and both classify alarms, each an alarm the module declares', () => {
    for (const name of ['conductia-discovery-extract-no-running-task', 'conductia-discovery-no-tick', 'conductia-discovery-no-running-task']) {
      expect(runbook, name).toContain(name);
      expect(alarmNames.has(name), name).toBe(true);
    }
  });
});

describe('the owner steps (design Q-A, Q-B, Q5, T1, T6)', () => {
  it('are 1 to 7, in order, with no gap', () => {
    expect(all.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('are each a human step ending with a Verify: line', () => {
    for (const s of all) {
      expect(s.title, `step ${s.number}`).toMatch(/\(human step\)$/);
      expect(s.body, `step ${s.number}`).toMatch(/^\*\*Verify:\*\* /m);
    }
  });

  it('confirms the plan first and verifies delivery last', () => {
    expect(numberOf(/Observability Plus/)).toBe(1);
    expect(numberOf(/^Vercel error anomaly alerts, 5xx and 4xx/)).toBeGreaterThan(1);
    expect(numberOf(/saved log searches, checked weekly/)).toBeGreaterThan(1);
    expect(numberOf(/^Verify alert delivery/)).toBe(Math.max(...all.map((s) => s.number)));
    for (const pattern of [/^Supabase Auth: rate limits and the Auth log/, /extract "no running task" alarm/, /classify alarms are live/]) {
      expect(numberOf(pattern), String(pattern)).toBeGreaterThan(0);
    }
  });

  it('records the retention Observability Plus gives (Q-A)', () => {
    expect(stepBody(/Observability Plus/)).toContain('30 days, 14 consecutive days viewable');
    expect(stepBody(/Observability Plus/)).toMatch(/log retention defined/);
  });

  it('leaves every recipient TODO(owner) until T1, and counts an unverified recipient as not delivered', () => {
    expect(stepBody(/^Vercel error anomaly alerts/)).toMatch(/`TODO\(owner\)` \(T1\)/);
    expect(stepBody(/saved log searches/)).toMatch(/`TODO\(owner\)` \(T1\)/);
    expect(stepBody(/^Verify alert delivery/)).toMatch(/Needs T1 decided/);
    expect(runbook).toMatch(/An alert without a named, verified recipient does not count as delivered\./);
  });

  it('gives the three searches as literal strings, weekly, and daily without Observability Plus (Q-B)', () => {
    const body = stepBody(/saved log searches/);
    for (const search of ['`"outcome":"zdr_unavailable"`', '`"outcome":"no_key"`', '`"evt":"auth_denied"`', '`"evt":"audit_write_failed"`']) {
      expect(body, search).toContain(search);
    }
    expect(body).toMatch(/Check weekly with Observability Plus\. Check daily without it/);
    expect(body).toMatch(/\[unsure: saved queries depend on the plan\]/);
    // The worker half of search 1 reads the worker's log group for the same two outcomes.
    const [worker] = commands(body, 'aws logs filter-log-events');
    expect(worker).toContain('--log-group-name /conductia/discovery-worker ');
    expect(worker).toContain('($.evt = "model_outcome")');
    expect(worker).toContain('($.outcome = "zdr_unavailable") || ($.outcome = "no_key")');
  });

  it('reads the extract alarm together with search 1 (ZDR crash loop) and applies it as admin', () => {
    const body = stepBody(/extract "no running task" alarm/);
    expect(body).toMatch(/ZDR crash loop/);
    expect(body).toMatch(/search 1/);
    expect(body).toContain('tofu -chdir=infra/discovery-worker plan -var-file=ignatious.tfvars -out=extract-alarm.tfplan');
    expect(body).toContain('aws_cloudwatch_metric_alarm.extract_running_tasks[0]');
    expect(alarmsTf).toMatch(/resource "aws_cloudwatch_metric_alarm" "extract_running_tasks"/);
  });

  it('cross-links the classify alarms to gate G8 and the Supabase step to T6', () => {
    expect(stepBody(/classify alarms are live/)).toMatch(/gate G8/);
    expect(stepBody(/^Supabase Auth/)).toMatch(/T6/);
    expect(stepBody(/^Supabase Auth/)).toMatch(/Change nothing\./);
  });

  it('says nothing has been applied', () => {
    expect(runbook.slice(0, runbook.indexOf('## Events'))).toContain('Nothing on this page has been applied.');
  });
});

describe('the limits, the open items and slice 2 (design Q4, Q8, Q9)', () => {
  it('names where the other refusals are already recorded, with audit actions the code has', () => {
    const body = section('Where refusals are already recorded');
    for (const needle of ['[conductia-seam]', 'skill_publication.admission_denied', 'mailbox.connect_refused']) expect(body, needle).toContain(needle);
    expect(read(join(root, 'src/lib/skillPublication/audit.ts'))).toContain('"skill_publication.admission_denied"');
    expect(read(join(root, 'src/lib/constants/audit.ts'))).toContain("'mailbox.connect_refused'");
  });

  it("names what is outside the logger's guarantee", () => {
    const body = section("Outside the logger's guarantee");
    expect(body).toMatch(/Vercel's request record/);
    expect(body).toMatch(/Next's uncaught-error print \(T7\)/);
    expect(body).toMatch(/Audit rows written inside an RPC/);
    expect(body).toMatch(/429 path/);
    expect(body).toMatch(/Per-attempt counting/);
  });

  it('keeps Q-B, T1 and T6 open, with Q-A to confirm', () => {
    const body = section('Open with the owner');
    expect(body).toMatch(/^\| Q-A \|[^\n]*owner to confirm/m);
    expect(body).toMatch(/^\| Q-B \|[^\n]*\| OPEN exception/m);
    expect(body).toMatch(/^\| T1 \|[^\n]*\| OPEN \|/m);
    expect(body).toMatch(/^\| T6 \|[^\n]*\| OPEN requirement \|/m);
  });

  it('puts the slice-2 swap at the sink only', () => {
    const body = section('Slice 2');
    expect(body).toContain('`src/lib/log/sink.ts` is the only place the logger touches the console');
    expect(body).toMatch(/CloudWatch/);
    expect(body).toMatch(/GlitchTip/);
    expect(body).toMatch(/ADR-0017 decision 5/);
  });
});

describe('house rules', () => {
  it('has no em dash', () => {
    expect(runbook).not.toContain('—');
  });

  it('holds no address, id, or secret-shaped string', () => {
    expect(runbook).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    expect(runbook).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(runbook).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(runbook).not.toMatch(/sb_(secret|publishable)_/);
    // No hyphen in the class: the alarm names are long hyphenated words, not tokens.
    expect(runbook).not.toMatch(/\b[A-Za-z0-9_]{32,}\b/);
  });

  it('puts no token in a command, and reads no secret value', () => {
    const curls = commands(runbook, 'curl');
    expect(curls.length).toBeGreaterThan(0);
    for (const command of curls) {
      for (const match of command.matchAll(/Authorization: Bearer (\S+)/g)) expect(match[1].replace(/"$/, '')).toBe('$SUPABASE_ACCESS_TOKEN');
    }
    for (const command of commands(runbook, 'aws ')) expect(command).not.toMatch(/get-secret-value|--with-decryption/);
  });

  it('cites only repo paths that exist', () => {
    const paths = [...runbook.matchAll(/`((?:src|tests|infra|supabase|worker|scripts|docs)\/[^`\s]+)`/g)].map((m) => m[1].replace(/:\d+(?:-\d+)?$/, ''));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(existsSync(join(root, path)), path).toBe(true);
  });
});

describe('the other docs this PR touches', () => {
  const soc2Row = register.split('\n').find((l) => l.startsWith('| Monitoring and alerting (CC7.2, CC7.3) |')) ?? '';
  const decisionRows = decisionLog.split('\n').filter((l) => /^\| D\d+ /.test(l));
  const d111 = decisionRows.find((l) => l.startsWith('| D111 ')) ?? '';
  const awsLine = awsRunbook.split('\n').find((l) => l.includes('app-observability-runbook.md')) ?? '';

  it('keeps the SOC 2 row Partial and names Q-B, T1 and T6 as open, with the runbook', () => {
    expect(soc2Row).toMatch(/^\| Monitoring and alerting \(CC7\.2, CC7\.3\) \| Partial \|/);
    for (const id of ['Q-B', 'T1', 'T6']) expect(soc2Row, id).toContain(id);
    expect(soc2Row).toContain('app-observability-runbook.md');
    expect(soc2Row).toMatch(/\| #474 \|$/);
  });

  it('adds D111 once, after D106, Proposed, with the number to confirm and the exception open', () => {
    const ids = decisionRows.map((l) => Number(/^\| D(\d+) /.exec(l)?.[1]));
    expect(ids.filter((n) => n === 111)).toHaveLength(1);
    expect(ids.indexOf(106)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(106)).toBeLessThan(ids.indexOf(111));
    expect(d111).toMatch(/Proposed/);
    expect(d111).toMatch(/number to confirm at merge/);
    expect(d111).toMatch(/Exception, OPEN/);
    expect(d111).toContain('FIELD_TABLE');
    expect(d111).not.toContain('—');
  });

  it('cross-links the extract alarm from the AWS runbook', () => {
    expect(awsRunbook).toContain('`conductia-discovery-extract-no-running-task`');
    expect(awsLine).toContain('(./app-observability-runbook.md)');
  });

  it('has relative links that resolve, in the runbook and in the lines this PR adds elsewhere', () => {
    const cases: [string, string, string][] = [
      ['runbook', runbookPath, runbook],
      ['SOC 2 row', registerPath, soc2Row],
      ['decision log D111', decisionLogPath, d111],
      ['AWS runbook', awsRunbookPath, awsLine],
    ];
    for (const [name, file, text] of cases) {
      const links = relativeLinks(text);
      expect(links.length, name).toBeGreaterThan(0);
      for (const link of links) expect(existsSync(resolve(dirname(file), link)), `${name}: ${link}`).toBe(true);
    }
  });
});
