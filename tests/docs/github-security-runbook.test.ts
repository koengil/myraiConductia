// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * A lint over docs/04-operations/github-security-runbook.md (#473, design R10).
 * It catches an edit that reorders the numbered steps, drops a Verify: line or a
 * STOP wording, loses the rotate-first order, the separate-PR allowlist rule, the
 * Q2 SLA values or the X1 and X2 exceptions, puts a hard-coded repo or a
 * credential in a command, or lets a secret-shaped string into the page. It also
 * pins the D110 decision-log row, the CC7.1 register row and the docs index entry.
 * It is not the control: it cannot stop an owner skipping a step.
 */

const root = process.cwd();
const runbookPath = join(root, 'docs/04-operations/github-security-runbook.md');
const decisionLogPath = join(root, 'docs/07-decisions/decision-log.md');
const registerPath = join(root, 'docs/08-security/soc2-control-register.md');
const docsIndexPath = join(root, 'docs/README.md');

const runbook = readFileSync(runbookPath, 'utf8');
const decisionLog = readFileSync(decisionLogPath, 'utf8');
const register = readFileSync(registerPath, 'utf8');
const docsIndex = readFileSync(docsIndexPath, 'utf8');

/** The fixed STOP wording, stated once as the rule in the intro and again in every STOP step. */
const STOP_SENTENCE = 'If the remedy does not clear it by its deadline, escalate to the owner and record the miss in the evidence record.';

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
const step = (number: number): Step => {
  const found = all.find((s) => s.number === number);
  if (!found) throw new Error(`step ${number} not found`);
  return found;
};
const numberOf = (pattern: RegExp): number => {
  const found = all.find((s) => pattern.test(s.title));
  if (!found) throw new Error(`no step title matches ${pattern}`);
  return found.number;
};

/** The `### 2b.` style sub-step of `body`, up to the next heading of any level. */
function subStep(body: string, id: string): string {
  const start = body.search(new RegExp(`^### ${id}\\. `, 'm'));
  if (start < 0) throw new Error(`sub-step ${id} not found`);
  const rest = body.slice(start + 4);
  const next = rest.search(/^#{2,3} /m);
  return next < 0 ? body.slice(start) : body.slice(start, start + 4 + next);
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

const row = (text: string, prefix: string): string => text.split('\n').find((l) => l.startsWith(prefix)) ?? '';

describe('the numbered steps', () => {
  it('are 1 to 12, in order, with no gap', () => {
    expect(all.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('each end with a Verify: line', () => {
    for (const s of all) expect(s.body, `step ${s.number}`).toMatch(/^Verify: /m);
  });

  it('give the sub-steps 2b and 5b their own Verify: line', () => {
    expect(subStep(step(2).body, '2b')).toMatch(/^Verify: /m);
    expect(subStep(step(5).body, '5b')).toMatch(/^Verify: /m);
  });

  it('keeps the evidence record after the steps', () => {
    expect(runbook).toMatch(/^## Evidence record$/m);
    expect(runbook.indexOf('## Evidence record')).toBeGreaterThan(runbook.indexOf('## 12. '));
  });

  it('runs the steps in the design order (R10)', () => {
    const order = [
      numberOf(/^Secret risk assessment/),
      numberOf(/^Dependency graph and Dependabot alerts/),
      numberOf(/^Security updates/),
      numberOf(/^Triage owner/),
      numberOf(/^Add "Secret scan"/),
      numberOf(/^Secret Protection decision/),
      numberOf(/^The promotion that activates/),
      numberOf(/^Critical alert/),
      numberOf(/^Secret-scan finding/),
      numberOf(/^Allowlist change/),
      numberOf(/^Fork-PR workflow settings/),
      numberOf(/^CODEOWNERS owner list/),
    ];
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('puts 2b inside step 2 and 5b inside step 5', () => {
    expect(step(2).body).toMatch(/^### 2b\. Initial alert inventory/m);
    expect(step(5).body).toMatch(/^### 5b\. Add it to the agents-backend `main` and `prod` rulesets/m);
  });
});

describe('the conventions and intro', () => {
  const intro = runbook.slice(0, runbook.indexOf('## 1. '));

  it('uses the m365 and csp runbook conventions: the human-step marker, placeholders, no secrets', () => {
    expect(runbook).toMatch(/\(human step\)/);
    for (const placeholder of ['<org>', '<repo>', '<triage owner>', '<alert number>', '<develop ruleset id>', '<ruleset id>']) {
      expect(runbook, placeholder).toContain(placeholder);
    }
    expect(intro).toMatch(/No token, key or secret value is written in this page/);
  });

  it('states the STOP wording once as the rule', () => {
    expect(intro).toContain(STOP_SENTENCE);
  });

  it('says no setting is applied by an agent or a CI job', () => {
    expect(intro).toMatch(/No GitHub setting is applied by an agent or a CI job/);
  });

  it('is marked Proposed and names D110 as the number to confirm at merge', () => {
    expect(intro).toMatch(/Status: Proposed/);
    expect(intro).toMatch(/D110 \(number to confirm at merge\)/);
  });
});

describe('what is in place', () => {
  const section = () => runbook.slice(runbook.indexOf('## What is in place'), runbook.indexOf('## 1. '));

  it('names the three controls with their check names and pinned versions', () => {
    for (const needle of ['`Secret scan`', '`Static analysis`', 'gitleaks 8.30.1', 'Semgrep CE 1.182.0', '`.github/dependabot.yml`']) {
      expect(section(), needle).toContain(needle);
    }
  });

  it('says the Dependabot file takes effect at the next promotion, and Static analysis is advisory', () => {
    expect(section()).toMatch(/it takes effect at the next promotion/);
    expect(section()).toMatch(/Advisory, not in any ruleset/);
  });

  it('cites the Semgrep Rules License and keeps p/default out', () => {
    expect(section()).toContain('https://semgrep.dev/legal/rules-license');
    expect(section()).toMatch(/`p\/default` is not used/);
  });

  it('does not create SECURITY.md here: it waits on a monitored contact', () => {
    expect(section()).toMatch(/Waits on a monitored security contact/);
    expect(section()).toMatch(/never merges with a placeholder/);
  });

  it('calls the agents-backend check advisory until step 5b', () => {
    expect(section()).toMatch(/Until step 5b is done there, its check is advisory/);
  });

  it('says plainly that Secret scan does not block develop merges until step 5', () => {
    expect(section()).toMatch(/\*\*It does not block a merge into `develop` until step 5 is done\*\*/);
  });

  it('describes the scanner-side routes as closed and the workflow edit as the open residual (audit items 1, 2, 4)', () => {
    expect(section()).toMatch(/every scan ignores inline `gitleaks:allow` comments/);
    expect(section()).toMatch(/a new credential in every allowlisted path/);
    expect(section()).toMatch(/^\*\*Residual risk/m);
    expect(section()).toMatch(/a PR that edits `\.github\/workflows\/ci\.yml` can make the check report green without scanning/);
    expect(section()).toMatch(/closes only when code-owner review is required on the workflow and scanner paths with a narrow owner list \(step 12\)/);
  });

  it('says the advisory check reports red, never fails a merge, and that the baseline is to be confirmed', () => {
    expect(section()).toMatch(/reports red for new ERROR findings/);
    expect(section()).not.toMatch(/A PR fails on new ERROR findings/);
    expect(section()).toMatch(/4 ERROR findings \(to be confirmed/);
  });

  it('says how the Semgrep lock is bumped, since Dependabot does not cover it (audit item 9)', () => {
    expect(section()).toMatch(/Dependabot does not update `\.github\/semgrep\/requirements\.txt`/);
    expect(section()).toContain('`.github/semgrep/requirements.in`');
    expect(section()).toMatch(/uv pip compile/);
  });
});

describe('the decisions, exceptions and SLA values', () => {
  const section = () => runbook.slice(runbook.indexOf('## Decisions this runbook carries'), runbook.indexOf('## 1. '));

  it('records Q1 = buy nothing, with exceptions X1 and X2', () => {
    expect(section()).toMatch(/Buy nothing now/);
    expect(section()).toMatch(/Exception X1\s*\|\s*Push protection is deferred/);
    expect(section()).toMatch(/Exception X2\s*\|\s*Dependabot security updates stay off on `Conductia`/);
  });

  it('gives X1 its compensating controls, exit and review date', () => {
    expect(section()).toMatch(/Compensating controls/);
    expect(section()).toMatch(/Exit:/);
    expect(section()).toContain('2026-12-15');
    expect(section()).toContain('#467');
  });

  it('states the Q2 SLA values and the main clock', () => {
    expect(section()).toMatch(/critical 7, high 30, medium 90, low 180/);
    expect(section()).toMatch(/clock runs on `main`/);
  });

  it('marks every decision Proposed', () => {
    expect(runbook).toMatch(/## Decisions this runbook carries \(all Proposed, owner to confirm\)/);
  });
});

describe('the STOP steps', () => {
  const stops = all.filter((s) => /\(STOP\)/.test(s.title));

  it('are the critical alert and the secret-scan finding', () => {
    expect(stops.map((s) => s.number)).toEqual([numberOf(/^Critical alert/), numberOf(/^Secret-scan finding/)]);
  });

  it('each use the fixed escalation wording', () => {
    for (const s of stops) expect(s.body, `step ${s.number}`).toContain(STOP_SENTENCE);
  });

  it('say what good looks like, where to look and the remedy in every STOP step', () => {
    for (const s of stops) {
      expect(s.body, `step ${s.number}`).toMatch(/\bGood\b/);
      expect(s.body, `step ${s.number}`).toMatch(/\bRemedy\b/i);
      expect(s.body, `step ${s.number}`).toMatch(/\bCheck\b/);
      expect(s.body, `step ${s.number}`).toMatch(/\bWhere\b/);
    }
  });

  it('tags no other step STOP', () => {
    expect(all.filter((s) => /STOP/.test(s.title))).toHaveLength(2);
  });
});

describe('step 1, the secret risk assessment', () => {
  it('is free, covers both repos, has no REST route, and never records a finding value', () => {
    const body = step(1).body;
    expect(body).toMatch(/Free for Team organizations/);
    expect(body).toMatch(/\*\*REST\.\*\* None known/);
    expect(body).toMatch(/Never paste a finding's value/);
    expect(body).toMatch(/Go to step 9/);
  });
});

describe('step 2, alerts and the initial inventory (R2)', () => {
  it('turns alerts on per repo, never with the organization recommended configuration', () => {
    const body = step(2).body;
    expect(body).toMatch(/\*\*per repo\*\*/);
    expect(body).toMatch(/Do not attach the organization's "GitHub recommended" security configuration/);
    expect(body).toContain('gh api -X PUT repos/<org>/<repo>/vulnerability-alerts');
    expect(body).toMatch(/prints `204`/);
  });

  it('lists the open alerts by severity with the paginated alerts API', () => {
    const inventory = subStep(step(2).body, '2b');
    expect(inventory).toContain('dependabot/alerts?state=open');
    expect(inventory).toContain('--paginate');
    expect(inventory).toMatch(/uniq -c/);
  });

  it('starts the SLA clock on the enablement date with the Q2 due dates', () => {
    const inventory = subStep(step(2).body, '2b');
    expect(inventory).toMatch(/Start each alert's SLA clock on `<enablement date>`/);
    expect(inventory).toMatch(/7 days for critical, 30 for high, 90 for medium and 180 for low \(Proposed values\)/);
  });

  it('opens an issue for every critical or high alert and marks alerts fixed on develop', () => {
    const inventory = subStep(step(2).body, '2b');
    expect(inventory).toMatch(/every critical or high alert, open an issue titled `security: <GHSA id> <package>`/);
    expect(inventory).toContain('"fixed on develop, pending promotion"');
  });
});

describe('step 3, security updates (X2)', () => {
  it('keeps them on for agents-backend and off for Conductia, with the REST read', () => {
    const body = step(3).body;
    expect(body).toMatch(/keep them \*\*off\*\* \(exception X2\)/);
    expect(body).toContain('gh api repos/<org>/<repo>/automated-security-fixes');
    expect(body).toMatch(/`conductia-agents-backend` returns `"enabled":true`, and `Conductia` returns `"enabled":false`/);
  });
});

describe('step 4, the triage owner and the label', () => {
  it('names a triage owner, the 1 business day rule, and creates the security label repeatably', () => {
    const body = step(4).body;
    expect(body).toMatch(/Name one engineer, or a weekly rota, as `<triage owner>`/);
    expect(body).toMatch(/within 1 business day/);
    expect(body).toContain('gh label create security --repo <org>/<repo>');
    expect(body).toContain('--force');
  });

  it('keeps the develop fix path: fix(deps) PR, no waiting for the weekly PR, owner approval for a critical dismissal', () => {
    const body = step(4).body;
    expect(body).toMatch(/fix\(deps\): bump <package> to <version> \(<GHSA id>\)/);
    expect(body).toMatch(/does not wait for the weekly Dependabot version PR/);
    expect(body).toMatch(/critical or high dismissal needs the owner's approval/);
  });
});

describe('step 5 and 5b, the required check in the rulesets', () => {
  it('adds "Secret scan" to the Conductia develop ruleset, keeps the four, and leaves Static analysis out', () => {
    const body = step(5).body;
    expect(body).toContain('`Secret scan`');
    expect(body).toMatch(/Keep the four existing checks/);
    expect(body).toMatch(/do not add `Static analysis`/);
    expect(body).toMatch(/lists five names, the original four and `Secret scan`/);
    expect(body).toContain('rulesets/<develop ruleset id>');
  });

  it('says only the promotion Action enforces REQUIRED_CHECKS and that org admins can bypass the ruleset (#687 review)', () => {
    const body = step(5).body;
    expect(body).toMatch(/a direct push to `staging` or `main` does not run that Action/);
    expect(body).toMatch(/`OrganizationAdmin` with bypass mode `always`/);
    expect(body).toMatch(/The bypass log is the evidence/);
  });

  it('adds it to the agents-backend main and prod rulesets only after its workflow is merged, and says advisory until then', () => {
    const body = subStep(step(5).body, '5b');
    expect(body).toMatch(/Only after the agents-backend owner has merged its `secret-scan\.yml`/);
    expect(body).toMatch(/no path filter/);
    expect(body).toContain('rulesets/<ruleset id>');
    expect(body).toMatch(/advisory, never as required/);
    expect(body).toMatch(/Run it once per ruleset id/);
  });

  it('names the live ruleset ids in the placeholder table', () => {
    for (const id of ['23657662', '21065246', '22299380']) expect(runbook, id).toContain(id);
  });
});

describe('step 6, the Secret Protection decision', () => {
  it('is optional, keeps X1 recorded either way, and has the settings call behind an approval', () => {
    const body = step(6).body;
    expect(step(6).title).toMatch(/optional/);
    expect(body).toMatch(/No paid toggle is assumed/);
    expect(body).toMatch(/X1 is recorded either way/);
    expect(body).toContain('security_and_analysis[secret_scanning_push_protection][status]=enabled');
    expect(body).toMatch(/only after the owner approves the cost/);
    expect(body).toContain('2026-12-15');
  });
});

describe('step 7, the promotion that activates dependabot.yml', () => {
  it('says Dependabot reads the default branch, and points to the delivery-model manual path', () => {
    const body = step(7).body;
    expect(body).toMatch(/Dependabot reads `\.github\/dependabot\.yml` from the default branch/);
    expect(body).toMatch(/Merging the file to `develop` changes nothing/);
    expect(body).toContain('refusing to allow a GitHub App to create or update workflow');
    expect(body).toContain('docs/03-engineering/delivery-model.md');
    expect(existsSync(join(root, 'docs/03-engineering/delivery-model.md'))).toBe(true);
  });

  it('verifies the file on main and the Dependabot tab, and names the untrusted-code risk', () => {
    const body = step(7).body;
    expect(body).toContain('contents/.github/dependabot.yml?ref=main');
    expect(body).toMatch(/Insights, Dependency graph, Dependabot/);
    expect(body).toMatch(/third-party code execution/);
  });
});

describe('step 8, the critical alert (Q2)', () => {
  const body = () => step(8).body;

  it('gives a 7-day window measured on main', () => {
    expect(body()).toMatch(/7-day window/);
    expect(body()).toMatch(/clock runs on `main`/);
  });

  it('runs an out-of-cycle develop to staging to main promotion by the two Actions', () => {
    expect(body()).toContain('**Promote develop to staging**');
    expect(body()).toContain('**Promote staging to main**');
    expect(body().indexOf('Promote develop to staging')).toBeLessThan(body().indexOf('Promote staging to main'));
    expect(body()).toMatch(/the same day and outside the schedule/);
  });

  it('reads the alert state with the alerts API, and never bypasses a ruleset for a bump', () => {
    expect(body()).toContain('dependabot/alerts?state=open&severity=critical');
    expect(body()).toContain('dependabot/alerts/<alert number>');
    expect(body()).toMatch(/do not bypass a ruleset for a dependency bump/);
  });
});

describe('step 9, the rotation rule (R6)', () => {
  const body = () => step(9).body;

  it('rotates first, then removes, then rewrites, in that order', () => {
    const rotate = body().indexOf('**Rotate it**');
    const remove = body().indexOf('**Remove it**');
    const rewrite = body().indexOf('**Rewrite**');
    expect(rotate).toBeGreaterThan(0);
    expect(rotate).toBeLessThan(remove);
    expect(remove).toBeLessThan(rewrite);
  });

  it('says rotation is the remediation, not the rewrite, and never writes the value', () => {
    expect(body()).toMatch(/GitHub keeps PR refs, so rewriting history is not remediation\. Rotation is\./);
    expect(body()).toMatch(/Never write the value/);
    expect(body()).toMatch(/with the value redacted/);
  });

  it('never fingerprint-ignores a PR-branch finding, and reserves the ignore file for rotated develop or tree findings', () => {
    expect(body()).toMatch(/Never add a PR-branch finding to `\.gitleaksignore`/);
    expect(body()).toContain('`file:rule:line`');
    expect(body()).toContain('`commit:file:rule:line`');
    expect(body()).toMatch(/reserved for a finding that is already on `develop` history or in the tree and has been \*\*rotated\*\*/);
  });

  it('states the merge-commit blind spot and the tree scan that covers it', () => {
    expect(body()).toMatch(/shows no diff for a merge commit/);
    expect(body()).toMatch(/merge-tree scan/);
  });
});

describe('step 10, the allowlist change', () => {
  it('lands the allowlist in its own PR first, because a PR is scanned with the base config', () => {
    const body = step(10).body;
    expect(body).toMatch(/scanned with the \*\*base branch's\*\* `\.gitleaks\.toml` and `\.gitleaksignore`/);
    expect(body).toMatch(/Open a small PR that changes only `\.gitleaks\.toml` or `\.gitleaksignore`/);
    expect(body).toMatch(/After it merges, open the fixture PR/);
    expect(body.indexOf('small PR')).toBeLessThan(body.indexOf('fixture PR'));
    expect(body).toMatch(/Never allowlist a real credential/);
  });

  it('allowlists one exact value, never a whole file or rule, and names the workflow-edit residual', () => {
    const body = step(10).body;
    expect(body).toMatch(/every scan ignores inline `gitleaks:allow` comments/);
    expect(body).toMatch(/condition = "AND"/);
    expect(body).toMatch(/A path-only or rule-only entry would hide every new credential in that file/);
    expect(body).toMatch(/One route stays open until step 12/);
    expect(body).not.toMatch(/Allowlist by \*\*path\*\*/);
  });
});

describe('step 11, the fork-PR settings', () => {
  it('records the private-repo fork workflow and workflow permission settings, with a UI fallback', () => {
    const body = step(11).body;
    expect(body).toContain('actions/permissions/workflow');
    expect(body).toContain('actions/permissions/fork-pr-workflows-private-repos');
    expect(body).toMatch(/If the second call returns `404`, read the same fields from the UI/);
    expect(body).toMatch(/Dependabot runs are treated as if they were opened from a fork/);
  });
});

describe('step 12, the CODEOWNERS owner list and required code-owner review', () => {
  it('lists the scanner paths and says it is a review request, not enforcement, today', () => {
    const body = step(12).body;
    for (const path of ['/.gitleaks.toml', '/.gitleaksignore', '/.github/workflows/', '/.github/dependabot.yml']) expect(body, path).toContain(path);
    expect(body).toMatch(/\*\*review request, not enforcement\*\*/);
  });

  it('turns on code-owner review in the develop ruleset, with a REST check and a fallback if the UI refuses it (audit item 4)', () => {
    const body = step(12).body;
    expect(body).toMatch(/"Require review from Code Owners"/);
    expect(body).toContain('rulesets/<develop ruleset id>');
    expect(body).toContain('.parameters.require_code_owner_review');
    expect(body).toMatch(/If the UI does not offer it/);
  });

  it('names a narrow owner for all of /.github/, CODEOWNERS itself included, and verifies it (#687 review)', () => {
    const body = step(12).body;
    expect(body).toMatch(/narrow owner list for `\/\.github\/` as a whole/);
    for (const path of ['/.github/CODEOWNERS', '/.github/workflows/', '/.github/semgrep/', '/.github/ai-review/']) expect(body, path).toContain(path);
    expect(body).toMatch(/grep -n 'CODEOWNERS\\\|/);
  });

  it('closes the residual only with a narrow owner list, and asserts no plan limit (#687 review)', () => {
    const body = step(12).body;
    expect(body).toMatch(/The full current list does not close the residual/);
    expect(body).toMatch(/a setting, not a plan limit/);
    expect(runbook).not.toMatch(/Team plan limit/);
    expect(register).not.toMatch(/Team plan limit/);
  });
});

describe('the evidence record', () => {
  const record = () => runbook.slice(runbook.indexOf('## Evidence record'));

  it('has a row for every numbered step and for the exceptions', () => {
    for (const label of [
      'Step 1:', 'Step 2:', 'Step 2b:', 'Step 3:', 'Step 4:', 'Step 5:', 'Step 5b:', 'Step 6:',
      'Step 7:', 'Step 8:', 'Step 9:', 'Step 10:', 'Step 11:', 'Step 12:', 'Exceptions X1 and X2',
    ]) {
      expect(record(), label).toContain(`| ${label}`);
    }
  });

  it('says no secret values, finding values or tokens go in it', () => {
    expect(record()).toMatch(/No secret values, no finding values, no tokens/);
  });
});

describe('the commands', () => {
  it('run gh api on the <org>/<repo> placeholders, with no hard-coded repo', () => {
    const calls = commands(runbook, 'gh api').filter((c) => /repos\//.test(c));
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) expect(call, call).toMatch(/repos\/<org>\/<repo>(\/|\s|$)/);
    expect(runbook).not.toMatch(/repos\/Conductia\//);
  });

  it('put no token or key in a command: gh uses the operator login', () => {
    expect(runbook).not.toMatch(/Authorization: Bearer/i);
    expect(runbook).not.toMatch(/\b(GH_TOKEN|GITHUB_TOKEN)=/);
    expect(runbook).not.toMatch(/--(with-)?token/);
  });

  it('change a setting only with the documented write calls', () => {
    const writes = commands(runbook, 'gh api -X');
    expect(writes.map((c) => /-X (\w+)/.exec(c)?.[1])).toEqual(['PUT', 'PATCH']);
    expect(writes[0]).toContain('vulnerability-alerts');
    expect(writes[1]).toContain('security_and_analysis');
  });
});

describe('house rules', () => {
  it('holds no secret-shaped string, tenant id or address', () => {
    expect(runbook).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // a JWT
    expect(runbook).not.toMatch(/sb_(secret|publishable)_/);
    expect(runbook).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/); // a GitHub token
    expect(runbook).not.toMatch(/\bgithub_pat_[A-Za-z0-9_]{20,}/);
    expect(runbook).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/); // an AWS access key id
    expect(runbook).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(runbook).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(runbook).not.toMatch(/\b[A-Za-z0-9_-]{40,}\b/); // a long opaque token
    expect(runbook).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });

  it('has no em dash', () => {
    expect(runbook).not.toContain('—');
  });

  it('asks no question in its prose', () => {
    const prose = runbook.replace(/```[\s\S]*?```/g, '');
    expect(prose).not.toMatch(/\?(\s|$)/);
  });
});

describe('the decision log row D110', () => {
  const rows = decisionLog.split('\n').filter((l) => /^\| D\d+ /.test(l));
  const ids = rows.map((l) => Number(/^\| D(\d+) /.exec(l)?.[1]));
  const d110 = row(decisionLog, '| D110 ');

  it('is added once, after D106, as a row of the table', () => {
    // Other PRs append their own rows, so only the relative order is pinned.
    expect(ids.filter((n) => n === 110)).toHaveLength(1);
    expect(ids.indexOf(106)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(106)).toBeLessThan(ids.indexOf(110));
    expect(d110).toMatch(/\|\s*$/);
  });

  it('is Proposed, with the number to confirm at merge, and carries Q1, X1, X2 and the Q2 values', () => {
    expect(d110).toMatch(/Proposed/);
    expect(d110).toMatch(/number to confirm at merge/);
    expect(d110).toMatch(/Exception X1/);
    expect(d110).toMatch(/Exception X2/);
    expect(d110).toMatch(/critical 7, high 30, medium 90, low 180/);
    expect(d110).toMatch(/buy nothing now/);
    expect(d110).toMatch(/Semgrep Rules License v1\.0/);
    expect(d110).not.toContain('—');
  });

  it('links the runbook and the register row', () => {
    expect(d110).toContain('github-security-runbook.md');
    expect(d110).toContain('soc2-control-register.md');
  });
});

describe('the CC7.1 register row', () => {
  const cc71 = row(register, '| Vulnerability management (CC7.1) ');

  it('stays Partial and names exceptions X1 and X2', () => {
    expect(cc71).toMatch(/\| Partial; push protection deferred \(exception X1\); Dependabot security updates narrowed on Conductia \(exception X2\) \|/);
  });

  it('lists what exists and marks the SLA values Proposed', () => {
    expect(cc71).toContain('npm audit --audit-level=moderate');
    expect(cc71).toContain('`Secret scan`');
    expect(cc71).toContain('`Static analysis`');
    expect(cc71).toMatch(/Dependabot version updates/);
    expect(cc71).toMatch(/Remediation SLAs \*\*Proposed\*\*/);
    expect(cc71).toMatch(/critical 7 \/ high 30 \/ medium 90 \/ low 180/);
  });

  it('names the promotion-only gate and the org-admin bypass (#687 review)', () => {
    expect(cc71).toMatch(/required by the promotion Action from `develop` to `staging`/);
    expect(cc71).toMatch(/a direct push to `staging` or `main` skips it \(CC8\.1\)/);
    expect(cc71).toMatch(/org admins can bypass the `develop` and `main` rulesets \(bypass mode always\)/);
    expect(cc71).not.toMatch(/required for promotion/);
  });

  it('keeps the SECURITY.md gap and the issue number, and has no em dash', () => {
    expect(cc71).toMatch(/`SECURITY\.md` waits on a monitored contact/);
    expect(cc71).toMatch(/\| #473 \|$/);
    expect(cc71).not.toContain('—');
  });
});

describe('links and the docs index', () => {
  it('lists the runbook in the docs index', () => {
    expect(docsIndex).toContain('(./04-operations/github-security-runbook.md)');
  });

  it('has relative links that resolve, in the runbook and in the lines this PR adds elsewhere', () => {
    const cases: [string, string, string][] = [
      ['runbook', runbookPath, runbook],
      ['decision log D110', decisionLogPath, row(decisionLog, '| D110 ')],
      ['register CC7.1', registerPath, row(register, '| Vulnerability management (CC7.1) ')],
      ['docs index', docsIndexPath, row(docsIndex, '| `04-operations/` ')],
    ];
    for (const [name, file, text] of cases) {
      const links = relativeLinks(text);
      expect(links.length, name).toBeGreaterThan(0);
      for (const link of links) expect(existsSync(resolve(dirname(file), link)), `${name}: ${link}`).toBe(true);
    }
  });
});
