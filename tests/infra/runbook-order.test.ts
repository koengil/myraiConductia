// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * A lint over docs/04-operations/discovery-worker-aws-runbook.md (#344, design
 * R17, R20 and R21). It catches an edit that reorders the numbered steps, starts
 * the worker early, drops a gate, a lever or a rotation row, writes an
 * incomplete command, or names a variable, output, rule or log group the module
 * does not have. It is not the control: the
 * start_approved precondition, the count = 0 stages and the gates are. It cannot
 * stop an owner skipping a step.
 */

const root = process.cwd();
const runbook = readFileSync(join(root, 'docs/04-operations/discovery-worker-aws-runbook.md'), 'utf8');
const moduleText = ['locals.tf', 'secrets.tf', 'variables.tf'].map((f) => readFileSync(join(root, 'infra/discovery-worker', f), 'utf8')).join('\n');

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

/** Everything before the start step (13), numbered or not. The whole text while step 13 does not exist. */
const beforeStart = (() => {
  const start = /^## 13\. /m.exec(runbook);
  return start ? runbook.slice(0, start.index) : runbook;
})();

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

describe('the numbered steps', () => {
  it('are 0 to 15, in order, with no gap', () => {
    expect(all.map((s) => s.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });

  it('carries no partial-revision banner', () => {
    expect(runbook).not.toMatch(/stop after step 4|Status of this revision|Pending with the/i);
  });

  it('each end with a Verify: line', () => {
    for (const s of all) expect(s.body, `step ${s.number}`).toMatch(/^Verify: /m);
  });
});

describe('the bootstrap order (design R17, R20)', () => {
  it('pushes the image before stage 2, and both stages follow the bootstrap', () => {
    const push = numberOf(/push the image/i);
    const stage1 = numberOf(/^Stage 1/);
    const stage2 = numberOf(/^Stage 2/);
    expect(numberOf(/bootstrap/i)).toBeLessThan(stage1);
    expect(stage1).toBeLessThan(push);
    expect(push).toBeLessThan(stage2);
  });

  it('signs G0 before the kit and the delegation grant', () => {
    const g0 = numberOf(/^G0/);
    const kit = numberOf(/kit/);
    expect(g0).toBeLessThan(kit);
    expect(step(kit).body).toMatch(/Only after G0/);
    for (const s of all.filter((x) => x.number < g0)) {
      expect(s.body, `step ${s.number}`).not.toMatch(/put-secret-value --secret-id google-wif-/);
    }
  });

  it('runs the persona pre-step before the probe, and the probe and G2 after stage 2', () => {
    const stage2 = numberOf(/^Stage 2/);
    const persona = numberOf(/persona/);
    const probe = numberOf(/probe from the task/);
    const g2 = numberOf(/\(G2\)/);
    expect(persona).toBeLessThan(probe);
    expect(stage2).toBeLessThan(probe);
    expect(stage2).toBeLessThan(g2);
    expect(probe).toBeLessThan(g2);
  });

  it('sets the secrets the stage 2 tasks read before stage 2, and checks them there', () => {
    const stage2 = numberOf(/^Stage 2/);
    const key = all.find((s) => /put-secret-value --secret-id supabase-worker-secret-key/.test(s.body));
    const queue = all.find((s) => /put-secret-value --secret-id discovery-queue-database-url/.test(s.body));
    expect(key?.number).toBeLessThan(stage2);
    expect(queue?.number).toBeLessThan(stage2);
    expect(step(stage2).body).toMatch(/list-secret-version-ids --secret-id supabase-worker-secret-key/);
    expect(step(stage2).body).toMatch(/list-secret-version-ids --secret-id discovery-queue-database-url/);
  });

  it('keeps the one-allowed-mailbox stop rule in the G2 step, before its run', () => {
    const g2 = step(numberOf(/\(G2\)/)).body;
    const stopRule = g2.indexOf('If the tenant has any allowed mailbox but the persona, stop');
    expect(stopRule).toBeGreaterThan(-1);
    expect(stopRule).toBeLessThan(g2.indexOf('aws ecs run-task'));
  });

  it('has the pooler stop rule in the queue credential step', () => {
    expect(step(4).body).toMatch(/If the pooler refuses the role, stop/);
  });
});

describe('nothing before step 13 can start the worker', () => {
  it('never sets start_approved, a desired count above zero, or the worker flag on', () => {
    expect(beforeStart).not.toMatch(/start_approved\s*=\s*true/);
    expect(beforeStart).not.toMatch(/(classify|extract)_desired_count\s*=\s*[1-9]/);
    expect(beforeStart).not.toMatch(/--desired-count\s+[1-9]/);
    expect(beforeStart).not.toMatch(/enabled\s*=\s*true[^;]*'discovery_worker_enabled'/);
  });

  it('uses --overrides only in the G8 exception run (step 12)', () => {
    for (const s of all) {
      if (s.number === 12) continue;
      expect(s.body, `step ${s.number}`).not.toMatch(/--overrides/);
    }
    expect(runbook.replace(all.find((s) => s.number === 12)?.body ?? '', '')).not.toMatch(/--overrides/);
  });
});

describe('every command is complete and names what the module creates', () => {
  const families = [...new Set([...moduleText.matchAll(/^\s+\w+\s*=\s*"(conductia-discovery-(?:classify-propose|classify|extract|probe|once|estimate))"/gm)].map((m) => m[1]))];

  it('writes every run-task in full: cluster, a fixed-command family, Fargate, private subnets, no public IP', () => {
    const runTasks = commands(runbook, 'aws ecs run-task');
    expect(runTasks.length).toBeGreaterThanOrEqual(2);
    for (const command of runTasks) {
      expect(command).toMatch(/--cluster conductia-discovery /);
      expect(command).toMatch(/--task-definition conductia-discovery-(probe|once|estimate) /);
      expect(command).toMatch(/--launch-type FARGATE/);
      expect(command).toMatch(
        /--network-configuration 'awsvpcConfiguration=\{subnets=\[<private subnet a>,<private subnet b>\],securityGroups=\[<security group id>\],assignPublicIp=DISABLED\}'/,
      );
    }
  });

  it('names only task families the module registers', () => {
    expect(families.sort()).toEqual([
      'conductia-discovery-classify',
      'conductia-discovery-classify-propose',
      'conductia-discovery-estimate',
      'conductia-discovery-extract',
      'conductia-discovery-once',
      'conductia-discovery-probe',
    ]);
    for (const match of runbook.matchAll(/--task-definition "?(conductia-discovery-[a-z$-]+)/g)) {
      if (match[1].includes('$')) continue; // the describe loop over the five families
      expect(families, match[1]).toContain(match[1]);
    }
  });

  it('names only secrets and parameters the module creates', () => {
    const secretNames = [...moduleText.matchAll(/^\s+name\s*=\s*"([a-z-]+)"/gm)].map((m) => m[1]);
    const workerKey = /variable "worker_supabase_secret_name" \{[^}]*default\s*=\s*"([^"]+)"/.exec(moduleText)?.[1];
    for (const match of runbook.matchAll(/--secret-id ([a-z-]+)/g)) {
      expect([...secretNames, workerKey], match[1]).toContain(match[1]);
    }
    const prefix = /probe_parameter_prefix\s*=\s*"([^"]+)"/.exec(moduleText)?.[1];
    for (const match of runbook.matchAll(/--name (\/conductia\/[a-z/-]+)/g)) {
      expect([`${prefix}/mailbox`, `${prefix}/out-of-scope`], match[1]).toContain(match[1]);
    }
  });

  it('reads the probe, once and estimate logs from the module log group and the family stream prefixes', () => {
    for (const command of commands(runbook, 'aws logs get-log-events')) {
      expect(command).toMatch(/--log-group-name \/conductia\/discovery-worker /);
      expect(command).toMatch(/--log-stream-name (probe|once|estimate)\/worker\/<task id>/);
    }
  });
});

describe('house rules', () => {
  it('prints no secret: every value goes in from a file', () => {
    for (const command of commands(runbook, 'aws secretsmanager put-secret-value')) {
      expect(command).toMatch(/--secret-string file:\/\//);
    }
    for (const command of commands(runbook, 'aws ssm put-parameter')) {
      expect(command).toMatch(/--value file:\/\//);
    }
    for (const command of commands(runbook, 'aws ')) {
      expect(command).not.toMatch(/get-secret-value|--with-decryption/);
    }
  });

  it('holds no address-shaped literal', () => {
    expect(runbook).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });

  it('has no em dash', () => {
    expect(runbook).not.toContain('—');
  });
});

/** Step 13's `### 13.n` subsections, in document order. */
function moves(): { number: string; title: string; body: string }[] {
  const body = step(13).body;
  const headings = [...body.matchAll(/^### (13\.\d) (.+)$/gm)].map((m) => ({ number: m[1], title: m[2], index: m.index ?? 0 }));
  return headings.map((h, i) => ({ number: h.number, title: h.title, body: body.slice(h.index, i + 1 < headings.length ? headings[i + 1].index : body.length) }));
}

describe('the gates and the start (design R17, R20, R21)', () => {
  it('ticks G1 to G9 at step 12, before the start step', () => {
    const gates = numberOf(/^Gates G1 to G9/);
    expect(gates).toBe(12);
    expect(gates).toBeLessThan(numberOf(/^Start/));
    const body = step(gates).body;
    for (const gate of ['G1', 'G3', 'G4', 'G8', 'G9']) expect(body, gate).toMatch(new RegExp(`\\*\\*${gate}\\b`));
    expect(body).toMatch(/If any gate cannot be evidenced, stop: step 13 does not start/);
  });

  it('starts in three moves: the persona alone, then G10, then the real users', () => {
    expect(numberOf(/^Start/)).toBe(13);
    const [start, g10, users] = moves();
    expect([start?.number, g10?.number, users?.number]).toEqual(['13.1', '13.2', '13.3']);
    expect(start.body).toMatch(/start_approved\s*=\s*true/);
    expect(start.body).toMatch(/classify_desired_count\s*=\s*1/);
    expect(start.body).toMatch(/set enabled = true where key = 'discovery_worker_enabled'/);
    // The one-allowed-mailbox stop rule comes before the flag goes on.
    const stopRule = start.body.indexOf('Both must be 1. Otherwise stop.');
    expect(stopRule).toBeGreaterThan(-1);
    expect(stopRule).toBeLessThan(start.body.indexOf("set enabled = true where key = 'discovery_worker_enabled'"));
    expect(g10.title).toMatch(/^G10/);
    expect(users.body).toMatch(/^Only after G10 is signed\./m);
  });

  it('rehearses every lever of the kill switch at G10, and records the token tail as a bound', () => {
    const g10 = moves()[1].body;
    for (const lever of ['Lever 1', 'Lever 2', 'Lever 3', 'Lever 4', 'Lever 5']) expect(g10, lever).toContain(`**${lever},`);
    expect(g10).toMatch(/pg_terminate_backend/);
    expect(g10).toMatch(/--desired-count 0/);
    expect(g10).toMatch(/upper bound/);
  });

  it('has the kill switch, the fully dark bound and a rotation row per secret in step 14', () => {
    const kill = step(14).body;
    for (const lever of [1, 2, 3, 4, 5, 6]) expect(kill, `lever ${lever}`).toMatch(new RegExp(`^\\| ${lever} \\|`, 'm'));
    expect(kill).toMatch(/fully dark is the last lever plus up to 1 hour/i);
    expect(kill).toMatch(/upper bound/);
    expect(kill).toMatch(/classify_desired_count = 0` and `start_approved = false` in tfvars/);
    for (const secret of ['supabase-worker-secret-key', 'discovery-queue-database-url', 'google-wif-dwd-config', 'google-wif-directory-config', 'ai-gateway-api-key', 'Probe parameters']) {
      expect(kill, secret).toMatch(new RegExp(`^\\|[^\\n]*${secret}[^\\n]*\\|`, 'm'));
    }
  });

  it('keeps the gate table complete, with When, Evidence and Signed by', () => {
    const table = runbook.slice(runbook.indexOf('## Go-live gates'), runbook.indexOf('## 0. '));
    expect(table).toMatch(/^\| Gate \| When \| Evidence \| Signed by \|$/m);
    for (let gate = 0; gate <= 10; gate += 1) expect(table, `G${gate}`).toMatch(new RegExp(`^\\| G${gate} \\|[^|]+\\|[^|]+\\|[^|]+\\|$`, 'm'));
    expect(table).toMatch(/^\| G0 \| Step 7, before the delegation grant/m);
    expect(table).toMatch(/^\| G10 \| Step 13\.2, before any real user is allowlisted/m);
  });

  it('turns deal_discovery on at step 9 only, and the DNS Firewall to BLOCK no earlier than step 10', () => {
    for (const s of all) {
      if (s.number !== 9) expect(s.body, `step ${s.number}`).not.toMatch(/set enabled = true where key = 'deal_discovery'/);
      if (s.number < 10) expect(s.body, `step ${s.number}`).not.toMatch(/dns_firewall_action\s*=\s*"BLOCK"/);
    }
    expect(step(9).body).toMatch(/set enabled = true where key = 'deal_discovery'/);
    expect(step(10).body).toMatch(/dns_firewall_action\s*=\s*"BLOCK"/);
  });

  it('runs the one override exception at step 12 only, once', () => {
    expect(step(12).body.match(/--overrides/g)).toHaveLength(1);
  });
});

describe('every reference names what the module declares', () => {
  const variables = readFileSync(join(root, 'infra/discovery-worker/variables.tf'), 'utf8');
  const declared = new Set([...variables.matchAll(/^variable "([a-z0-9_]+)"/gm)].map((m) => m[1]));
  const outputText = ['infra/discovery-worker/outputs.tf', 'infra/discovery-worker/bootstrap/main.tf'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
  const outputs = new Set([...outputText.matchAll(/^output "([a-z0-9_]+)"/gm)].map((m) => m[1]));

  it('sets only declared variables in every tfvars block', () => {
    const blocksOfHcl = [...runbook.matchAll(/```hcl\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocksOfHcl.length).toBeGreaterThanOrEqual(5);
    for (const block of blocksOfHcl) {
      for (const match of block.matchAll(/^([a-z0-9_]+)\s*=/gm)) expect(declared, match[1]).toContain(match[1]);
    }
  });

  it('names only outputs the module has, in placeholders and output commands', () => {
    const named = [
      ...[...runbook.matchAll(/<([a-z0-9]+(?:_[a-z0-9]+)+)>/g)].map((m) => m[1]),
      ...[...runbook.matchAll(/tofu -chdir=\S+ output ([a-z0-9_]+)/g)].map((m) => m[1]),
    ];
    expect(named).toEqual(expect.arrayContaining(['deploy_role_arn', 'alert_topic_arn', 'dns_firewall_rule_group_id', 'guardduty_detector_id']));
    for (const name of named) expect(outputs, name).toContain(name);
  });

  it('names the deploy role, the alert rules and the log groups the module creates', () => {
    const moduleSource = ['deploy_role.tf', 'alerts.tf', 'alarms.tf', 'detection.tf', 'locals.tf'].map((f) => readFileSync(join(root, 'infra/discovery-worker', f), 'utf8')).join('\n');
    expect(moduleSource).toMatch(/deploy_role_name = "\$\{local\.name\}-deploy"/);
    expect(moduleSource).toMatch(/name\s*=\s*"discovery-worker-deploy"/);
    expect(runbook).toMatch(/--role-name conductia-discovery-worker-deploy --policy-name discovery-worker-deploy/);
    for (const rule of runbook.matchAll(/`((?:deploy-role-assumed|ecs-operation|ecs-task-overrides|secret-changed|tamper-[a-z]+))`/g)) {
      expect(moduleSource, rule[1]).toContain(`"${rule[1]}" = {`);
    }
    for (const alarm of runbook.matchAll(/(conductia-discovery-(?:no-tick|no-running-task|extract-no-running-task|dns-firewall-hits|sync-failures|address-in-logs))\b/g)) {
      expect(moduleSource, alarm[1]).toContain(`"${alarm[1]}"`);
    }
    expect(moduleSource).toMatch(/dns_query_log_group_name = "\/conductia\/discovery-worker\/resolver-queries"/);
    for (const group of runbook.matchAll(/--log-group-name (\/conductia\/[a-z/-]+)/g)) {
      expect(['/conductia/discovery-worker', '/conductia/discovery-worker/resolver-queries'], group[1]).toContain(group[1]);
    }
  });

  it('carries no stale #432 arrival wording and states the unpriced versus busy precedence', () => {
    expect(runbook).not.toMatch(/arrives with #432/);
    expect(runbook).toMatch(/reports `unpriced`\s+at the start of the next pass[^]*`busy` describes a reservation\s+refused during the current pass/);
  });
});
