// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { logServerEvent } from '@/lib/log';
import { FIELD_TABLE } from '@/lib/log/fields';

/*
 * A static scan of infra/discovery-worker (#344, design R6 to R8, R10 to R12,
 * R14, R15, R18, R20): the container contract the module and the worker code
 * share; the no-ingress, no-exec, no-secret-value rules; the deploy role's
 * guard; the alerts, their code-only bodies and the alarms' tie to the worker's
 * own log lines. `tofu test` (scripts/infra/validate.sh)
 * checks the plan; this checks the text, so a rule cannot be dropped by an edit
 * that still plans.
 */

const root = process.cwd();
const MODULE = join(root, 'infra/discovery-worker');

function tfFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '.terraform' ? [] : tfFiles(path);
    return name.endsWith('.tf') ? [path] : [];
  });
}

const files = tfFiles(MODULE);
const rootFiles = files.filter((f) => !relative(MODULE, f).includes('/'));
const text = rootFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/** The text with comments removed, string contents kept. */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"') {
      const start = i;
      i += 1;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      out += source.slice(start, i + 1);
      i += 1;
    } else if (c === '#' || (c === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const code = stripComments(text);

/** The body of every `<keyword> "<a>" "<b>" {` block, braces matched outside strings. */
function blocks(source: string, keyword: string, type: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const header = new RegExp(`^${keyword}\\s+"${type}"\\s+"([^"]+)"\\s*\\{`, 'gm');
  for (const match of source.matchAll(header)) {
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '"') {
        i += 1;
        while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      } else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      i += 1;
    }
    found.push({ name: match[1], body: source.slice(start, i - 1) });
  }
  return found;
}

const resource = (type: string, name: string): string => {
  const block = blocks(code, 'resource', type).find((b) => b.name === name);
  if (!block) throw new Error(`resource ${type}.${name} not found`);
  return block.body;
};
const locals = blocks(code.replace(/^locals\s*\{/gm, 'locals "x" "locals" {'), 'locals', 'x').map((b) => b.body).join('\n');

const taskDefinitions = blocks(code, 'resource', 'aws_ecs_task_definition');
const services = blocks(code, 'resource', 'aws_ecs_service');

describe('the module exists and is the one scanned', () => {
  it('has the root files and the bootstrap module', () => {
    for (const name of [
      'versions.tf', 'variables.tf', 'network.tf', 'ecr.tf', 'kms.tf', 'secrets.tf', 'iam.tf', 'ecs.tf', 'logs.tf', 'outputs.tf',
      'deploy_role.tf', 'detection.tf', 'cloudtrail.tf', 'alerts.tf', 'alarms.tf',
    ]) {
      expect(rootFiles.map((f) => relative(MODULE, f)), name).toContain(name);
    }
    expect(files.map((f) => relative(MODULE, f))).toContain('bootstrap/main.tf');
  });

  it('declares exactly the six families and the two services', () => {
    expect(taskDefinitions.map((b) => b.name).sort()).toEqual(['classify', 'classify_propose', 'estimate', 'extract', 'once', 'probe']);
    expect(services.map((b) => b.name).sort()).toEqual(['classify', 'extract']);
    // Each family has its fixed name in locals, so the deploy role and the runbook name the same resources.
    const families = between(locals, 'families = {', '}');
    expect([...families.matchAll(/^\s*(\w+)\s*=\s*"conductia-discovery-[a-z-]+"/gm)].map((m) => m[1]).sort()).toEqual(
      taskDefinitions.map((b) => b.name).sort(),
    );
    expect(families).toMatch(/classify_propose\s*=\s*"conductia-discovery-classify-propose"/);
  });
});

describe('the container contract (design R18)', () => {
  it('sets every production-required variable for the base container', () => {
    expect(locals).toMatch(/name\s*=\s*"NEXT_PUBLIC_APP_ENV",\s*value\s*=\s*"prod"/);
    expect(locals).toMatch(/name\s*=\s*"DISCOVERY_READER_MODE",\s*value\s*=\s*"live"/);
    expect(locals).toMatch(/name\s*=\s*"NEXT_PUBLIC_SUPABASE_URL",\s*value\s*=\s*var\.supabase_url/);
    for (const secret of ['SUPABASE_SECRET_KEY', 'DISCOVERY_QUEUE_DATABASE_URL', 'GOOGLE_WIF_DWD_CONFIG', 'GOOGLE_WIF_DIRECTORY_CONFIG', 'DISCOVERY_INDEX_DIGEST_KEY']) {
      expect(locals, secret).toMatch(new RegExp(`name\\s*=\\s*"${secret}",\\s*valueFrom\\s*=\\s*aws_secretsmanager_secret\\.`));
    }
  });

  it('runs classify, probe, once, estimate and classify_propose on the base container', () => {
    for (const name of ['classify', 'probe', 'once', 'estimate', 'classify_propose']) {
      expect(resource('aws_ecs_task_definition', name), name).toMatch(/merge\(local\.base_container,/);
    }
  });

  it('names no DATABASE_URL other than the queue URL', () => {
    expect(code.match(/(?<![A-Z_])DATABASE_URL/g)).toBeNull();
  });

  it('injects the probe addresses into the probe family only, from the two SSM parameters', () => {
    const probe = resource('aws_ecs_task_definition', 'probe');
    expect(probe).toMatch(/name\s*=\s*"PROBE_MAILBOX",\s*valueFrom\s*=\s*local\.probe_parameter_arns\.mailbox/);
    expect(probe).toMatch(/name\s*=\s*"PROBE_OUT_OF_SCOPE",\s*valueFrom\s*=\s*local\.probe_parameter_arns\.out_of_scope/);
    // No designated P05 message is injected: in the task P05 never reads a raw message.
    expect(code).not.toMatch(/PROBE_RAW_TEST_MESSAGE_ID/);
    const elsewhere = code.replace(probe, '');
    expect(elsewhere).not.toMatch(/name\s*=\s*"PROBE_/);
    expect(elsewhere).not.toMatch(/valueFrom\s*=\s*local\.probe_parameter_arns/);
    expect(locals).toMatch(
      /probe_parameter_arns = \{\s*for key, name in local\.probe_parameter_names : key => "arn:aws:ssm:\$\{var\.region\}:\$\{var\.aws_account_id\}:parameter\$\{name\}"/,
    );
  });

  it('gives the probe and once families fixed commands that name no address', () => {
    const probe = resource('aws_ecs_task_definition', 'probe');
    expect(probe).toMatch(/"probe", "--live",\s*"--confirm-domain", var\.probe_workspace_domain,\s*"--tenant", var\.probe_tenant_id,\s*"--allow-remote-db",\s*"--out", "\/tmp\/probe"/);
    expect(probe).not.toMatch(/--mailbox|--out-of-scope|--registration/);
    expect(resource('aws_ecs_task_definition', 'once')).toMatch(/command\s*=\s*\["classify-once", "--tenant", var\.probe_tenant_id\]/);
  });

  it('gives the estimate family a fixed command and no gateway key', () => {
    const estimate = resource('aws_ecs_task_definition', 'estimate');
    expect(estimate).toMatch(/command\s*=\s*\["estimate", "--tenant", var\.probe_tenant_id\]/);
    expect(estimate).not.toMatch(/AI_GATEWAY_API_KEY|DISCOVERY_EXTRACT_TRANSPORT|task_role_arn/);
  });

  it('keeps the model gateway key in extract and classify_propose only, each behind its own flag', () => {
    const extract = resource('aws_ecs_task_definition', 'extract');
    const propose = resource('aws_ecs_task_definition', 'classify_propose');
    expect(extract).toMatch(/var\.extract_gateway_enabled \? \[\{ name = "AI_GATEWAY_API_KEY"/);
    expect(extract).toMatch(/"DISCOVERY_EXTRACT_TRANSPORT", value = var\.extract_gateway_enabled \? "gateway" : "recorded"/);
    // The propose family carries the key unconditionally, because the whole family exists only behind its flag.
    expect(propose).toMatch(/^\s*count\s*=\s*local\.stage2 && var\.propose_gateway_enabled \? 1 : 0/m);
    expect(propose).toMatch(/\{ name = "AI_GATEWAY_API_KEY", valueFrom = aws_secretsmanager_secret\.ai_gateway\.arn \}/);
    expect(code.replace(extract, '').replace(propose, '')).not.toMatch(/AI_GATEWAY_API_KEY/);
  });

  // Demo-only (#460): the reader task that holds the gateway key is a one-off run, never the service.
  it('gives classify_propose the once command plus --propose and the gateway transport, and nothing else of the model', () => {
    const propose = resource('aws_ecs_task_definition', 'classify_propose');
    expect(propose).toMatch(/family\s*=\s*local\.families\.classify_propose/);
    expect(propose).toMatch(/command = \["classify-once", "--tenant", var\.probe_tenant_id, "--propose"\]/);
    expect(propose).not.toMatch(/--serve|--allow-remote-db|--replies|--transport/);
    expect(propose).toMatch(/environment = concat\(local\.base_environment, \[\s*\{ name = "DISCOVERY_PROPOSE_TRANSPORT", value = "gateway" \},\s*\]\)/);
    expect(propose).toMatch(/secrets = concat\(local\.base_secrets, \[/);
    expect(propose).toMatch(/logConfiguration = local\.log_configuration\.classify_propose/);
    expect(code.replace(propose, '')).not.toMatch(/DISCOVERY_PROPOSE_TRANSPORT|"--propose"/);
  });

  it('never gives the classify service, once or probe the gateway key or the propose transport', () => {
    for (const name of ['classify', 'once', 'probe']) {
      expect(resource('aws_ecs_task_definition', name), name).not.toMatch(/AI_GATEWAY_API_KEY|DISCOVERY_PROPOSE_TRANSPORT|--propose|ai_gateway/);
    }
    expect(resource('aws_ecs_task_definition', 'classify')).toMatch(/command\s*=\s*\["classify"\]/);
    // The service runs the classify family, never the propose one.
    expect(code).not.toMatch(/aws_ecs_task_definition\.classify_propose\[0\]\.arn/);
  });

  // The exact command per flag value is asserted by bootstrap.tftest.hcl; this pins only what fmt cannot reflow.
  it('names the tenant in the extract command only behind the gateway flag', () => {
    const extract = resource('aws_ecs_task_definition', 'extract');
    expect(extract).toMatch(/command = var\.extract_gateway_enabled \?/);
    expect(extract.match(/var\.probe_tenant_id/g)).toHaveLength(1);
    expect(extract).not.toMatch(/--allow-remote-db|--replies/);
  });

  it('never sets the entrypoint test knob WORKER_GOOGLE_CONFIG_DIR in a task definition', () => {
    expect(text).not.toMatch(/WORKER_GOOGLE_CONFIG_DIR/);
  });
});

describe('the filesystem and the user (design R6)', () => {
  it('runs every container with a read-only root and /tmp as the one volume', () => {
    expect(locals).toMatch(/readonlyRootFilesystem\s*=\s*true/);
    expect(code).not.toMatch(/readonlyRootFilesystem\s*=\s*false/);
    expect(locals).toMatch(/mountPoints\s*=\s*\[\{ sourceVolume = "tmp", containerPath = "\/tmp", readOnly = false \}\]/);
    for (const { name, body } of taskDefinitions) {
      expect(body, name).toMatch(/merge\(local\.base_container,/);
      expect(body, name).toMatch(/volume\s*\{\s*name\s*=\s*"tmp"\s*\}/);
    }
  });

  it('never overrides the image user', () => {
    expect(code).not.toMatch(/\buser\s*=/);
  });
});

describe('the network and the services (design R1, R11)', () => {
  it('has no ingress rule of any form', () => {
    expect(code).not.toMatch(/\bingress\s*\{/);
    expect(code).not.toMatch(/aws_vpc_security_group_ingress_rule|aws_security_group_rule/);
    expect(code).not.toMatch(/type\s*=\s*"ingress"/);
  });

  it('allows egress on tcp 443 and 5432 only', () => {
    const egress = blocks(code, 'resource', 'aws_vpc_security_group_egress_rule');
    expect(egress.map((b) => (/from_port\s*=\s*(\d+)/.exec(b.body) ?? [])[1]).sort()).toEqual(['443', '5432']);
    for (const { body } of egress) {
      expect(body).toMatch(/ip_protocol\s*=\s*"tcp"/);
      expect((/from_port\s*=\s*(\d+)/.exec(body) ?? [])[1]).toBe((/to_port\s*=\s*(\d+)/.exec(body) ?? [])[1]);
    }
  });

  it('gives no subnet a public IP on launch and no service a public IP or ECS Exec', () => {
    expect(code).not.toMatch(/map_public_ip_on_launch\s*=\s*true/);
    for (const { name, body } of services) {
      expect(body, name).toMatch(/enable_execute_command\s*=\s*false/);
      expect(body, name).toMatch(/assign_public_ip\s*=\s*false/);
      expect(body, name).toMatch(/deployment_maximum_percent\s*=\s*100/);
    }
    expect(code).not.toMatch(/enable_execute_command\s*=\s*true/);
  });
});

describe('the bootstrap order (design R20)', () => {
  it('gates every task definition and service on the image digest', () => {
    expect(locals).toMatch(/stage2\s*=\s*var\.image_digest != null/);
    for (const { name, body } of [...taskDefinitions, ...services]) {
      // classify_propose also needs its own flag (#460); every other family exists once the image does.
      const count = name === 'classify_propose' ? /^\s*count\s*=\s*local\.stage2 && var\.propose_gateway_enabled \? 1 : 0/m : /^\s*count\s*=\s*local\.stage2 \? 1 : 0/m;
      expect(body, name).toMatch(count);
    }
  });

  it('pins the image by digest, never by tag', () => {
    expect(locals).toMatch(/image\s*=\s*local\.stage2 \? "\$\{aws_ecr_repository\.worker\.repository_url\}@\$\{var\.image_digest\}" : null/);
    expect(code).not.toMatch(/:latest/);
  });

  it('refuses any desired count above 0 without start_approved, on both services', () => {
    const want = { classify: 'classify_desired_count', extract: 'extract_desired_count' } as const;
    for (const { name, body } of services) {
      const variable = want[name as keyof typeof want];
      expect(body, name).toMatch(new RegExp(`desired_count\\s*=\\s*var\\.${variable}`));
      expect(body, name).toMatch(new RegExp(`precondition\\s*\\{\\s*condition\\s*=\\s*var\\.${variable} == 0 \\|\\| var\\.start_approved`));
    }
    expect(code).not.toMatch(/ignore_changes\s*=\s*\[[^\]]*desired_count/);
  });

  it('defaults to nothing running', () => {
    const variables = readFileSync(join(MODULE, 'variables.tf'), 'utf8');
    for (const name of ['classify_desired_count', 'extract_desired_count']) {
      expect(variables).toMatch(new RegExp(`variable "${name}" \\{[^}]*default\\s*=\\s*0`));
    }
    expect(variables).toMatch(/variable "extract_gateway_enabled" \{[^}]*default\s*=\s*false/);
    expect(variables).toMatch(/variable "propose_gateway_enabled" \{[^}]*type\s*=\s*bool[^}]*default\s*=\s*false/);
    expect(variables).toMatch(/variable "start_approved" \{[^}]*default\s*=\s*false/);
    expect(variables).toMatch(/variable "image_digest" \{[^}]*default\s*=\s*null/);
  });
});

describe('roles and secrets (design R7, R9)', () => {
  it('lets only ECS tasks of this account and region assume the task and execution roles; the task role holds no policy', () => {
    // The documented account-scoped form: a cluster-specific aws:SourceArn is not supported for task roles.
    expect(locals).toMatch(
      /ecs_trust_condition = \{\s*StringEquals = \{ "aws:SourceAccount" = var\.aws_account_id \}\s*ArnLike\s*= \{ "aws:SourceArn" = "arn:aws:ecs:\$\{var\.region\}:\$\{var\.aws_account_id\}:\*" \}\s*\}/,
    );
    for (const name of ['task', 'execution']) {
      const role = resource('aws_iam_role', name);
      expect(role, name).toMatch(/Principal\s*=\s*\{ Service = "ecs-tasks\.amazonaws\.com" \}/);
      expect(role, name).toMatch(/Condition\s*=\s*local\.ecs_trust_condition/);
    }
    expect(code).not.toMatch(/role\s*=\s*aws_iam_role\.task\./);
    expect(code).not.toMatch(/aws_iam_role_policy_attachment|managed_policy_arns|inline_policy/);
  });

  it('gives the execution role exactly its resources, statement by statement', () => {
    const policy = resource('aws_iam_role_policy', 'execution');
    const statements = Object.fromEntries(
      [...policy.matchAll(/Sid\s*=\s*"(\w+)"[\s\S]*?Resource\s*=\s*([^\n]+)/g)].map((m) => [m[1], m[2].trim()]),
    );
    expect(statements).toEqual({
      EcrAuthorizationToken: '"*"',
      EcrPullTheWorkerImageAndTheGuardDutyAgent: '[aws_ecr_repository.worker.arn, local.guardduty_agent_repository_arn]',
      WriteTheWorkerLogGroup: '["${aws_cloudwatch_log_group.worker.arn}:*"]',
      ReadTheNamedSecrets: 'local.readable_secret_arns',
      ReadTheTwoProbeParameters: 'values(local.probe_parameter_arns)',
      DecryptWithTheWorkerKey: '[aws_kms_key.worker.arn]',
      WriteTheLogGroupThroughLogs: '[aws_kms_key.worker.arn]',
    });
    expect(policy.slice(policy.indexOf('"WriteTheLogGroupThroughLogs"'))).toMatch(/"kms:ViaService" = "logs\.\$\{var\.region\}\.amazonaws\.com"/);
    expect(between(policy, '"ReadTheTwoProbeParameters"', '}')).toMatch(/Action\s*=\s*"ssm:GetParameters"/);
    // The secret read: exactly GetSecretValue, on exactly the five injected secrets, the gateway key only under P2 = B.
    expect(between(policy, '"ReadTheNamedSecrets"', '}')).toMatch(/Effect\s*=\s*"Allow"\s*Action\s*=\s*"secretsmanager:GetSecretValue"\s*Resource\s*=\s*local\.readable_secret_arns\s*$/);
    const readable = between(locals, 'readable_secret_arns = concat(', '\n  )');
    expect([...readable.matchAll(/aws_secretsmanager_secret\.(\w+)\.arn/g)].map((m) => m[1])).toEqual([
      'supabase_worker_key',
      'queue_url',
      'wif_dwd',
      'wif_directory',
      'index_digest_key',
      'ai_gateway',
    ]);
    expect(readable).toMatch(/var\.extract_gateway_enabled \|\| var\.propose_gateway_enabled \? \[aws_secretsmanager_secret\.ai_gateway\.arn\] : \[\]/);
  });

  it('declares secret containers only, never a secret value', () => {
    expect(code).not.toMatch(/aws_secretsmanager_secret_version/);
    expect(code).not.toMatch(/secret_string/);
  });

  it('manages and reads no SSM parameter: refresh would put its decrypted value in state', () => {
    // ignore_changes does not stop a refresh reading a SecureString value; a data source reads it too.
    expect(code).not.toMatch(/(resource|data)\s+"aws_ssm_parameter"/);
    expect(code).not.toMatch(/"aws_ssm_parameters_by_path"/);
  });

  it('encrypts every secret, the log group and the repository with the worker key', () => {
    for (const { name, body } of blocks(code, 'resource', 'aws_secretsmanager_secret')) {
      expect(body, name).toMatch(/kms_key_id\s*=\s*aws_kms_key\.worker\.arn/);
    }
    expect(resource('aws_cloudwatch_log_group', 'worker')).toMatch(/kms_key_id\s*=\s*aws_kms_key\.worker\.arn/);
    expect(resource('aws_ecr_repository', 'worker')).toMatch(/kms_key\s*=\s*aws_kms_key\.worker\.arn/);
    expect(resource('aws_ecr_repository', 'worker')).toMatch(/image_tag_mutability\s*=\s*"IMMUTABLE"/);
    expect(resource('aws_kms_key', 'worker')).toMatch(/enable_key_rotation\s*=\s*true/);
  });
});

describe('no address in the module', () => {
  it('holds no address-shaped literal in any .tf file', () => {
    const address = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z.]{2,}/;
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), relative(root, file)).not.toMatch(address);
    }
  });
});

describe('the image provenance (design R3)', () => {
  const dockerfile = readFileSync(join(root, 'worker/Dockerfile'), 'utf8');

  it('refuses a GIT_SHA that is not 40 lowercase hex and labels the image with it', () => {
    expect(dockerfile).toMatch(/ARG GIT_SHA=""/);
    expect(dockerfile).toMatch(/\$\{#GIT_SHA\}" -ne 40/);
    expect(dockerfile).toMatch(/tr -d '0-9a-f'/);
    expect(dockerfile).toMatch(/LABEL org\.opencontainers\.image\.revision=\$GIT_SHA/);
    expect(dockerfile).toMatch(/COPY --from=revision/);
  });
});

describe('the image runs as node under a read-only root (design R6)', () => {
  const dockerfile = readFileSync(join(root, 'worker/Dockerfile'), 'utf8');
  // Instructions only: comments dropped, continuation lines joined.
  const instructions = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const runtime = instructions.slice(instructions.findLastIndex((line) => /^FROM\b/.test(line)));
  const indexOf = (pattern: RegExp) => runtime.findIndex((line) => pattern.test(line));

  it('switches to node last, and no stage after it switches back', () => {
    const users = instructions.filter((line) => /^USER\b/.test(line));
    expect(users.at(-1)).toBe('USER node');
    expect(runtime.filter((line) => /^USER\b/.test(line))).toEqual(['USER node']);
    expect(indexOf(/^USER node$/)).toBeLessThan(indexOf(/^ENTRYPOINT\b/));
  });

  it('gives /tmp/google to node, mode 0700, before VOLUME /tmp seeds the task volume from it', () => {
    const prepare = indexOf(/^RUN .*chown node:node \/tmp\/google\b.*chmod 0700 \/tmp\/google\b/);
    const volume = indexOf(/^VOLUME \/tmp$/);
    expect(prepare).toBeGreaterThan(-1);
    expect(volume).toBeGreaterThan(prepare);
    // Nothing after the VOLUME line touches /tmp: Docker discards build changes to a declared volume.
    for (const line of runtime.slice(volume + 1)) expect(line).not.toMatch(/\/tmp\b/);
  });

  it('runs every task definition with a read-only root, through the shared base container', () => {
    expect(locals).toMatch(/base_container = \{[\s\S]*?readonlyRootFilesystem\s*=\s*true/);
    for (const { name, body } of taskDefinitions) {
      expect(body, name).toMatch(/container_definitions = jsonencode\(\[merge\(local\.base_container, \{/);
      expect(body, name).not.toMatch(/readonlyRootFilesystem/);
    }
  });
});

/** The text from `start` up to (not including) the first `end` after it. */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  if (from === -1) throw new Error(`${start} not found`);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? source.length : to);
}

const fileCode = (name: string): string => stripComments(readFileSync(join(MODULE, name), 'utf8'));

describe('the deploy role (design R8)', () => {
  const trust = between(locals, 'deploy_trust_statement = {', 'deploy_principal_shape = {');
  const iamUser = between(trust, 'iam_user = {', 'sso = {');
  const sso = trust.slice(trust.indexOf('sso = {'));
  const shapes = between(locals, 'deploy_principal_shape = {', 'deploy_run_task_arns');
  const role = resource('aws_iam_role', 'deploy');
  const policy = resource('aws_iam_role_policy', 'deploy');

  it('trusts named IAM users only, with MFA in the last hour, under iam_user', () => {
    expect(iamUser).toMatch(/Principal\s*=\s*\{ AWS = var\.deploy_trusted_principal_arns \}/);
    expect(iamUser).toMatch(/Bool\s*=\s*\{ "aws:MultiFactorAuthPresent" = "true" \}/);
    expect(iamUser).toMatch(/NumericLessThan\s*=\s*\{ "aws:MultiFactorAuthAge" = "3600" \}/);
    expect(iamUser).not.toMatch(/:root|"\*"/);
    expect(shapes).toMatch(/iam_user\s*=\s*"\^arn:aws:iam::\$\{var\.aws_account_id\}:user\//);
  });

  it('trusts only the Identity Center permission-set role pattern under sso', () => {
    expect(sso).toMatch(/ArnLike\s*=\s*\{ "aws:PrincipalArn" = var\.deploy_trusted_principal_arns \}/);
    expect(sso).not.toMatch(/MultiFactorAuth/);
    expect(shapes).toMatch(/sso\s*=\s*"\^arn:aws:iam::\$\{var\.aws_account_id\}:role\/aws-reserved\/sso\\\\\.amazonaws\\\\\.com\/.*AWSReservedSSO_.*_\\\\\*\$"/);
  });

  it('checks every principal against the type, and caps the session at one hour', () => {
    expect(role).toMatch(/Statement\s*=\s*\[local\.deploy_trust_statement\[var\.deploy_principal_type\]\]/);
    expect(role).toMatch(/precondition\s*\{\s*condition\s*=\s*alltrue\(\[for arn in var\.deploy_trusted_principal_arns : can\(regex\(local\.deploy_principal_shape\[var\.deploy_principal_type\], arn\)\)\]\)/);
    expect(role).toMatch(/max_session_duration\s*=\s*3600/);
  });

  it('denies exec, IAM writes, every secret action and every key action', () => {
    const denies = policy.split(/\n\s*\{\n/).filter((statement) => /Effect\s*=\s*"Deny"/.test(statement)).join('\n');
    expect(denies).toMatch(/Action\s*=\s*"ecs:ExecuteCommand"/);
    for (const verb of ['Create', 'Put', 'Attach', 'Detach', 'Update', 'Delete', 'Add', 'Remove', 'Tag', 'Untag', 'Set']) {
      expect(denies, verb).toContain(`"iam:${verb}*"`);
    }
    expect(denies).toMatch(/Action\s*=\s*"secretsmanager:\*"/);
    expect(denies).toMatch(/Action\s*=\s*"kms:\*"/);
  });

  it('allows only what the runbook does as deploy, each scoped', () => {
    expect(policy).toMatch(/Action\s*=\s*"ecr:GetAuthorizationToken"\s*Resource\s*=\s*"\*"/);
    expect(policy).toMatch(/"ecr:PutImage",[\s\S]*?\]\s*Resource\s*=\s*aws_ecr_repository\.worker\.arn/);
    // tofu registers the families as admin; deploy registers nothing and reads no log group (kms:* is denied).
    expect(policy).not.toMatch(/RegisterTaskDefinition/);
    expect(policy).not.toMatch(/"logs:/);
    const cluster = 'Condition\\s*=\\s*\\{\\s*ArnEquals = \\{ "ecs:cluster" = aws_ecs_cluster\\.worker\\.arn \\}';
    expect(policy).toMatch(new RegExp(`Action\\s*=\\s*"ecs:UpdateService"\\s*Resource\\s*=\\s*local\\.deploy_service_arns\\s*${cluster}`));
    expect(policy).toMatch(new RegExp(`Action\\s*=\\s*"ecs:RunTask"\\s*Resource\\s*=\\s*local\\.deploy_run_task_arns\\s*${cluster}`));
    // Kill-switch lever 2 stops every task of the cluster, standalone runs included.
    expect(policy).toMatch(
      new RegExp(`Action\\s*=\\s*"ecs:StopTask"\\s*Resource\\s*=\\s*"arn:aws:ecs:\\$\\{var\\.region\\}:\\$\\{var\\.aws_account_id\\}:task\\/\\$\\{local\\.cluster_name\\}\\/\\*"\\s*${cluster}`),
    );
    expect(policy).toMatch(new RegExp(`Action\\s*=\\s*"ecs:ListTasks"\\s*Resource\\s*=\\s*"\\*"\\s*${cluster}`));
    // The three fixed families, plus the demo-only classify-propose run only while its flag is on (#460).
    expect(locals).toMatch(
      /deploy_run_task_arns = \[\s*for family in concat\(\s*\[local\.families\.probe, local\.families\.once, local\.families\.estimate\],\s*var\.propose_gateway_enabled \? \[local\.families\.classify_propose\] : \[\],\s*\) :/,
    );
    expect(between(locals, 'deploy_run_task_arns = [', '\n  ]').match(/local\.families\.\w+/g)).toEqual([
      'local.families.probe',
      'local.families.once',
      'local.families.estimate',
      'local.families.classify_propose',
    ]);
    expect(policy).toMatch(/Action\s*=\s*"iam:PassRole"\s*Resource\s*=\s*\[aws_iam_role\.task\.arn, aws_iam_role\.execution\.arn\]\s*Condition\s*=\s*\{\s*StringEquals = \{ "iam:PassedToService" = "ecs-tasks\.amazonaws\.com" \}/);
    // No allow is a whole service or every action.
    expect(policy).not.toMatch(/Action\s*=\s*"\*"|"(ecs|ecr|iam|logs):\*"/);
  });
});

describe('the alerts (design R10)', () => {
  const alerts = fileCode('alerts.tf');

  /** The body of the alert rule keyed `name` (its first definition), braces matched outside strings. */
  const rule = (name: string): string => {
    const at = alerts.search(new RegExp(`^\\s*"${name}" = \\{`, 'm'));
    if (at === -1) throw new Error(`rule ${name} not found`);
    let i = alerts.indexOf('{', at) + 1;
    const start = i;
    for (let depth = 1; depth > 0 && i < alerts.length; i += 1) {
      if (alerts[i] === '"') {
        i += 1;
        while (i < alerts.length && alerts[i] !== '"') i += alerts[i] === '\\' ? 2 : 1;
      } else if (alerts[i] === '{') depth += 1;
      else if (alerts[i] === '}') depth -= 1;
    }
    return alerts.slice(start, i - 1);
  };

  // Every event R10 names, bound to the rule that pages it (UpdateDetectorFeature is not a
  // GuardDuty API: feature changes go through UpdateDetector).
  const r10Events: Record<string, string[]> = {
    'ecs-operation': ['RegisterTaskDefinition', 'RunTask', 'StartTask', 'StopTask', 'UpdateService', 'CreateService', 'DeleteService', 'ExecuteCommand'],
    'ecs-task-overrides': ['RunTask', 'StartTask'],
    'task-role-assumed-outside-ecs': ['AssumeRole'],
    'deploy-role-assumed': ['AssumeRole'],
    'secret-read-outside-ecs': ['GetSecretValue', 'BatchGetSecretValue'],
    'secret-changed': ['PutSecretValue', 'UpdateSecret', 'DeleteSecret', 'PutResourcePolicy'],
    'probe-parameter-changed': ['PutParameter', 'DeleteParameter', 'DeleteParameters', 'LabelParameterVersion'],
    'iam-role-change': ['UpdateAssumeRolePolicy', 'PutRolePolicy', 'AttachRolePolicy', 'DetachRolePolicy', 'DeleteRolePermissionsBoundary', 'DeleteRole'],
    'iam-access-key-created': ['CreateAccessKey'],
    'root-console-login': ['ConsoleLogin'],
    'tamper-sns': ['Unsubscribe', 'SetSubscriptionAttributes', 'SetTopicAttributes', 'DeleteTopic', 'RemovePermission'],
    'tamper-cloudtrail': ['StopLogging', 'UpdateTrail', 'PutEventSelectors', 'PutInsightSelectors', 'DeleteTrail'],
    'tamper-trail-bucket': ['PutBucketPolicy', 'DeleteBucketPolicy', 'PutBucketVersioning', 'DeleteBucketPublicAccessBlock', 'PutBucketLifecycle', 'DeleteBucket'],
    'tamper-guardduty': ['DeleteDetector', 'UpdateDetector', 'UpdateMalwareScanSettings', 'DisassociateFromMasterAccount', 'CreateFilter'],
    'tamper-resolver': [
      'DeleteFirewallRuleGroup', 'DisassociateFirewallRuleGroup', 'UpdateFirewallRule', 'UpdateFirewallRuleGroupAssociation',
      'DeleteResolverQueryLogConfig', 'DisassociateResolverQueryLogConfig',
    ],
    'tamper-flow-logs': ['DeleteFlowLogs'],
    'tamper-security-group': ['AuthorizeSecurityGroupIngress', 'AuthorizeSecurityGroupEgress', 'RevokeSecurityGroupEgress', 'ModifySecurityGroupRules', 'DeleteSecurityGroup'],
    'tamper-kms': ['PutKeyPolicy', 'ScheduleKeyDeletion', 'DisableKey', 'DisableKeyRotation', 'CreateGrant', 'RevokeGrant', 'UpdateAlias', 'DeleteAlias'],
    'tamper-eventbridge': ['DeleteRule', 'DisableRule', 'PutRule', 'RemoveTargets', 'PutTargets'],
    'tamper-cloudwatch': ['DeleteAlarms', 'DisableAlarmActions', 'PutMetricAlarm', 'DeleteMetricFilter', 'PutRetentionPolicy', 'DeleteLogGroup', 'DisassociateKmsKey'],
  };

  it('pages every event R10 names, each from its own rule', () => {
    for (const [name, events] of Object.entries(r10Events)) {
      const body = rule(name);
      for (const event of events) expect(body, `${name}: ${event}`).toMatch(new RegExp(`eventName\\s*=\\s*\\[[^\\]]*"${event}"`));
    }
  });

  it('scopes the targeted tamper rules to the module\'s own resources', () => {
    expect(rule('tamper-trail-bucket')).toMatch(/requestParameters = \{ bucketName = \[local\.trail_bucket_name\] \}/);
    const sg = rule('tamper-security-group');
    expect(sg).toMatch(/\{ requestParameters = \{ groupId = \[aws_security_group\.worker\.id\] \} \}/);
    expect(sg).toMatch(/ModifySecurityGroupRulesRequest = \{ GroupId = \[aws_security_group\.worker\.id\] \}/);
    const kms = rule('tamper-kms');
    expect(kms).toMatch(/\{ eventName = \["RevokeGrant", "RetireGrant"\], resources = \{ ARN = local\.module_key_arns \} \}/);
    // A grant a service makes for the caller carries invokedBy; only a direct grant pages.
    expect(kms).toMatch(/\{ eventName = \["CreateGrant"\], resources = \{ ARN = local\.module_key_arns \}, userIdentity = \{ invokedBy = \[\{ exists = false \}\] \} \}/);
    expect(kms).toMatch(/requestParameters = \{ aliasName = local\.module_alias_names \}/);
    expect(locals).toMatch(/module_key_arns\s*=\s*\[aws_kms_key\.worker\.arn, aws_kms_key\.trail\.arn\]/);
    expect(locals).toMatch(/module_alias_names\s*=\s*\["alias\/\$\{local\.name\}", "alias\/\$\{local\.name\}-trail"\]/);
    for (const name of ['worker', 'trail']) {
      expect(resource('aws_kms_alias', name)).toMatch(name === 'worker' ? /name\s*=\s*"alias\/\$\{local\.name\}"/ : /name\s*=\s*"alias\/\$\{local\.name\}-trail"/);
    }
  });

  it('scopes the probe-parameter rule to the probe prefix, single and batch deletes alike', () => {
    const parameters = rule('probe-parameter-changed');
    expect(parameters).toMatch(/\{ requestParameters = \{ name = \[\{ prefix = "\$\{local\.probe_parameter_prefix\}\/" \}\] \} \}/);
    expect(parameters).toMatch(/\{ requestParameters = \{ names = \[\{ prefix = "\$\{local\.probe_parameter_prefix\}\/" \}\] \} \}/);
  });

  it('watches the alert path in us-east-1 too when the region is elsewhere', () => {
    const shared = between(alerts, 'alert_path_tamper_rules = {', 'regional_alert_rules = merge(');
    for (const name of ['"tamper-sns"', '"tamper-eventbridge"', '"tamper-cloudwatch"']) expect(shared).toContain(name);
    expect(alerts).toMatch(/regional_alert_rules = merge\(local\.sts_rules, local\.alert_path_tamper_rules, \{/);
    expect(alerts).toMatch(
      /\{ for name, rule in merge\(local\.sts_rules, local\.alert_path_tamper_rules\) : name => rule if !local\.global_in_main_topic \}/,
    );
  });

  it('names every role the module creates in the IAM change rule', () => {
    expect(rule('iam-role-change')).toMatch(/requestParameters = \{ roleName = local\.module_role_names \}/);
    const listed = /module_role_names\s*=\s*\[([^\]]+)\]/.exec(locals)?.[1].split(',').map((x) => x.trim()) ?? [];
    expect(listed).toEqual(['var.task_role_name', '"${local.name}-exec"', 'local.deploy_role_name', '"${local.name}-flow-logs"']);
    const roleNames = blocks(code, 'resource', 'aws_iam_role').map((b) => /^\s*name\s*=\s*([^\n]+)/m.exec(b.body)?.[1].trim());
    expect(roleNames.sort()).toEqual([...listed].sort());
  });

  it('gives a RunTask or StartTask with overrides its own rule', () => {
    const overrides = rule('ecs-task-overrides');
    expect(overrides).toMatch(/eventName\s*=\s*\["RunTask", "StartTask"\]/);
    // A command override, a task role (the execution role named as the task role included) and an execution role.
    expect(overrides).toMatch(/\{ requestParameters = \{ overrides = \{ containerOverrides = \{ name = \[\{ exists = true \}\] \} \} \} \}/);
    expect(overrides).toMatch(/\{ requestParameters = \{ overrides = \{ taskRoleArn = \[\{ exists = true \}\] \} \} \}/);
    expect(overrides).toMatch(/\{ requestParameters = \{ overrides = \{ executionRoleArn = \[\{ exists = true \}\] \} \} \}/);
    expect(overrides.match(/requestParameters = /g)).toHaveLength(3);
  });

  it('pages a task-role assumption not made by ECS, and a secret read by anyone but the execution role', () => {
    const task = rule('task-role-assumed-outside-ecs');
    expect(task).toMatch(/requestParameters = \{ roleArn = \[local\.task_role_arn\] \}/);
    expect(task).toMatch(/invokedBy = \[\{ "anything-but" = \["ecs-tasks\.amazonaws\.com"\] \}\]/);
    expect(task).toMatch(/invokedBy = \[\{ exists = false \}\]/);
    const secret = rule('secret-read-outside-ecs');
    expect(secret).toMatch(/arn = \[\{ "anything-but" = \{ prefix = local\.execution_session \} \}\]/);
    expect(locals).toMatch(/execution_session\s*=\s*"arn:aws:sts::\$\{var\.aws_account_id\}:assumed-role\/\$\{local\.name\}-exec\/"/);
    // Read-only events reach only a rule in the all-management-events state.
    for (const block of [task, secret]) expect(block).toMatch(/all_management_events = true/);
  });

  it('puts the IAM, access-key and root sign-in rules on the us-east-1 alias', () => {
    const global = alerts.slice(alerts.indexOf('global_alert_rules = merge('));
    for (const name of ['"iam-role-change"', '"iam-access-key-created"', '"root-console-login"']) {
      expect(global.slice(0, global.indexOf('alert_input = {')), name).toContain(name);
    }
    expect(resource('aws_cloudwatch_event_rule', 'global')).toMatch(/provider\s*=\s*aws\.us_east_1/);
    expect(resource('aws_cloudwatch_event_target', 'global')).toMatch(/provider\s*=\s*aws\.us_east_1/);
  });

  it('sends every target through a transformer that names fields and never a request, a response or a finding body', () => {
    for (const type of ['regional', 'global']) {
      const target = resource('aws_cloudwatch_event_target', type);
      expect(target, type).toMatch(/input_transformer\s*\{\s*input_paths\s*=\s*local\.alert_input\[each\.value\.kind\]\.paths/);
      expect(target, type).not.toMatch(/\binput\s*=|\binput_path\s*=/);
    }
    expect(blocks(code, 'resource', 'aws_cloudwatch_event_target').map((b) => b.name).sort()).toEqual(['global', 'regional']);
    const input = between(alerts, 'alert_input = {', 'global_alert_topic_arn');
    const paths = [...input.matchAll(/=\s*"(\$\.[^"]*)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThanOrEqual(10);
    for (const path of paths) {
      expect(path).not.toMatch(/requestParameters|responseElements|additionalEventData/);
      expect(path).not.toMatch(/^\$\.detail\.(resource|service)\b/);
      expect(path).not.toBe('$');
    }
    expect(between(input, 'guardduty = {', 'template')).toMatch(/type\s*=\s*"\$\.detail\.type"[\s\S]*severity\s*=\s*"\$\.detail\.severity"[\s\S]*id\s*=\s*"\$\.detail\.id"/);
  });

  it('subscribes the owner and the CCO to each topic', () => {
    const subscriptions = blocks(code, 'resource', 'aws_sns_topic_subscription');
    expect(subscriptions.map((b) => b.name).sort()).toEqual(['cco', 'global_cco', 'global_owner', 'owner']);
    const want = {
      owner: ['aws_sns_topic.alerts.arn', 'var.alarm_email'],
      cco: ['aws_sns_topic.alerts.arn', 'var.cco_alarm_email'],
      global_owner: ['aws_sns_topic.global_alerts[0].arn', 'var.alarm_email'],
      global_cco: ['aws_sns_topic.global_alerts[0].arn', 'var.cco_alarm_email'],
    } as const;
    for (const { name, body } of subscriptions) {
      const [topic, endpoint] = want[name as keyof typeof want];
      expect(body, name).toContain(`topic_arn = ${topic}`);
      expect(body, name).toMatch(new RegExp(`endpoint\\s*=\\s*${endpoint.replace('.', '\\.')}\\n`));
      expect(body, name).toMatch(/protocol\s*=\s*"email"/);
    }
    // The global topic and its two subscriptions exist together.
    const globalCount = /count\s*=\s*local\.global_in_main_topic \? 0 : 1/;
    for (const name of ['global_owner', 'global_cco']) expect(resource('aws_sns_topic_subscription', name)).toMatch(globalCount);
    expect(resource('aws_sns_topic', 'global_alerts')).toMatch(globalCount);
  });
});

describe('the alarms follow the worker log lines (design R12, R14; Phase 3)', () => {
  const alarms = fileCode('alarms.tf');
  const jobLog = readFileSync(join(root, 'worker/jobLog.ts'), 'utf8');
  const jobLine = between(jobLog, 'export type JobLine =', '\n\n');
  const evtNames = new Set([...jobLine.matchAll(/evt: ((?:'[a-z_]+'(?: \| )?)+)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((n) => n[1])));

  it('reads the Phase 3 event names', () => {
    expect([...evtNames].sort()).toEqual([
      'accept', 'accept_expiry_failed', 'census', 'census_contacts', 'discover', 'fatal', 'group_removal_failed',
      'group_removal_held', 'group_removal_overdue', 'orphan_collection_failed', 'queue_error', 'sync', 'tick',
    ]);
  });

  it('filters only on event names the worker prints', () => {
    const filtered = [...alarms.matchAll(/\$\.evt = \\"([a-z_]+)\\"/g)].map((m) => m[1]);
    expect(filtered.sort()).toEqual([
      'accept_expiry_failed', 'group_removal_failed', 'group_removal_held', 'group_removal_overdue', 'orphan_collection_failed',
      'sync', 'tick',
    ]);
    for (const name of filtered) expect(evtNames, name).toContain(name);
  });

  it('counts a tick that ran, and a sync that failed, as the worker writes them', () => {
    expect(resource('aws_cloudwatch_log_metric_filter', 'ticks')).toContain('{ ($.evt = \\"tick\\") && ($.status NOT EXISTS) }');
    expect(resource('aws_cloudwatch_log_metric_filter', 'sync_failures')).toContain('{ ($.evt = \\"sync\\") && ($.status = \\"failed\\") }');
    // A breaker hold is a notice of its own, not deletion-stuck; a hold 24 hours overdue is stuck (D93).
    const stuck = resource('aws_cloudwatch_log_metric_filter', 'deletion_steps');
    expect(stuck).toContain('($.evt = \\"group_removal_overdue\\")');
    expect(stuck).not.toContain('group_removal_held');
    // A failed accept expiry leaves stale accept text unpurged, so it counts as a stuck deletion step (G-02b #173).
    expect(stuck).toContain('($.evt = \\"accept_expiry_failed\\")');
    expect(resource('aws_cloudwatch_log_metric_filter', 'group_removal_held')).toContain('{ $.evt = \\"group_removal_held\\" }');
    expect(resource('aws_cloudwatch_metric_alarm', 'group_removal_held')).toContain('Notice, not a failure');
    // The worker side: a tick that ran carries no status; a failed tick or sync carries status 'failed'.
    expect(between(jobLog, "case 'tick':", "case 'sync':")).toMatch(/compact\(\{ evt, queued: countOf\(outcome\.queued\) \}\)/);
    const failed = between(jobLog, 'function failedLineOf', '\n}\n');
    expect(failed).toMatch(/case 'tick':\s*return \{ evt, status: 'failed', reason \}/);
    expect(failed).toMatch(/case 'sync':\s*return \{ evt, tenant: idOf\(ids\.tenant\), source: idOf\(ids\.source\), status: 'failed', reason \}/);
  });

  it('keeps the tick and running-task alarms only while the worker is meant to run, missing data breaching', () => {
    expect(locals).toMatch(/worker_running\s*=\s*var\.classify_desired_count > 0/);
    for (const name of ['ticks', 'running_tasks']) {
      const alarm = resource('aws_cloudwatch_metric_alarm', name);
      expect(alarm, name).toMatch(/^\s*count\s*=\s*local\.worker_running \? 1 : 0/m);
      expect(alarm, name).toMatch(/treat_missing_data\s*=\s*"breaching"/);
    }
    expect(resource('aws_cloudwatch_metric_alarm', 'running_tasks')).toMatch(/namespace\s*=\s*"ECS\/ContainerInsights"[\s\S]*metric_name\s*=\s*"RunningTaskCount"/);
  });

  it('keeps an extract running-task alarm gated like the extract service, to the alert topic (#474)', () => {
    expect(resource('aws_ecs_service', 'extract')).toMatch(/^\s*count\s*=\s*local\.stage2 \? 1 : 0/m);
    const alarm = resource('aws_cloudwatch_metric_alarm', 'extract_running_tasks');
    expect(alarm).toMatch(/^\s*count\s*=\s*local\.stage2 && var\.extract_desired_count > 0 \? 1 : 0/m);
    expect(alarm).toMatch(/alarm_name\s*=\s*"conductia-discovery-extract-no-running-task"/);
    expect(alarm).toMatch(/namespace\s*=\s*"ECS\/ContainerInsights"[\s\S]*metric_name\s*=\s*"RunningTaskCount"/);
    expect(alarm).toMatch(/treat_missing_data\s*=\s*"breaching"/);
    expect(alarm).toMatch(/ServiceName\s*=\s*local\.services\.extract/);
    expect(alarm).toMatch(/alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/);
    expect(alarm).toMatch(/ok_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/);
  });

  // The worker's stream gains failed model_outcome lines (#474, design Q6): they must move no metric.
  const modelOutcomeLine = (): string => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logServerEvent({
        evt: 'model_outcome', feature: 'milestone_extract', outcome: 'zdr_unavailable', failure: 'upstream_status',
        zdrReason: 'no_providers_available', status: 400, tenant: '00000000-0000-4000-8000-000000000001', ms: 15_000,
      });
      return String(error.mock.calls[0]?.[0]);
    } finally {
      error.mockRestore();
    }
  };

  it('keys no metric filter on a model_outcome line (#474)', () => {
    expect(code).not.toContain('model_outcome');
    const shared = Object.keys(FIELD_TABLE.model_outcome).filter((field) => new RegExp(`\\b${field}\\??:`).test(jobLine));
    const modelOnly = Object.keys(FIELD_TABLE.model_outcome).filter((field) => !shared.includes(field));
    expect(shared.sort()).toEqual(['status', 'tenant']);
    for (const { name, body } of blocks(code, 'resource', 'aws_cloudwatch_log_metric_filter')) {
      for (const field of modelOnly) expect(body, `${name} reads $.${field}`).not.toContain(`$.${field}`);
      // A field both lines carry is read only beside a worker event name, which a model_outcome line never has.
      if (shared.some((field) => body.includes(`$.${field}`))) {
        const evt = /\(\$\.evt = \\"([a-z_]+)\\"\) && /.exec(body)?.[1];
        expect(evtNames, name).toContain(evt);
      }
    }
  });

  it('sends every alarm to the alert topic', () => {
    for (const { name, body } of blocks(code, 'resource', 'aws_cloudwatch_metric_alarm')) {
      expect(body, name).toMatch(/alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\]/);
    }
  });

  it('writes the address regex in the subset CloudWatch filter patterns accept, and it finds an address', () => {
    const hcl = /address_pattern\s*=\s*"([^"]+)"/.exec(alarms)?.[1] ?? '';
    const pattern = hcl.replace(/\\\\/g, '\\');
    expect(pattern.startsWith('%') && pattern.endsWith('%')).toBe(true);
    const body = pattern.slice(1, -1);
    // Alphanumerics, : _ # = @ / ; , - and ^ $ ? [ ] { } | \ * + . only; no parentheses.
    expect(body).toMatch(/^[A-Za-z0-9:_#=@/;,\-^$?[\]{}|\\*+.]+$/);
    const regex = new RegExp(body);
    expect(regex.test(['someone', 'bank.example'].join('@'))).toBe(true);
    expect(regex.test('{"evt":"sync","tenant":"00000000-0000-4000-8000-000000000001","status":"complete","fetched":1}')).toBe(false);
    const modelLine = modelOutcomeLine();
    expect(modelLine).toContain('"evt":"model_outcome"');
    expect(regex.test(modelLine)).toBe(false);
    expect(resource('aws_cloudwatch_log_metric_filter', 'address_in_logs')).toMatch(/pattern\s*=\s*local\.address_pattern/);
  });

  it('alarms on DNS Firewall ALERT and BLOCK hits in the query log', () => {
    const filter = resource('aws_cloudwatch_log_metric_filter', 'dns_firewall_hits');
    expect(filter).toMatch(/log_group_name\s*=\s*aws_cloudwatch_log_group\.dns\.name/);
    expect(filter).toContain('($.firewall_rule_action = \\"ALERT\\") || ($.firewall_rule_action = \\"BLOCK\\")');
  });
});

describe('egress and runtime detection (design R11)', () => {
  it('allows the allowlist and applies dns_firewall_action to everything else, ALERT by default', () => {
    expect(resource('aws_route53_resolver_firewall_rule', 'allowed')).toMatch(/action\s*=\s*"ALLOW"/);
    const rest = resource('aws_route53_resolver_firewall_rule', 'everything_else');
    expect(rest).toMatch(/action\s*=\s*var\.dns_firewall_action/);
    expect(rest).toMatch(/block_response\s*=\s*var\.dns_firewall_action == "BLOCK" \? "NXDOMAIN" : null/);
    expect(resource('aws_route53_resolver_firewall_domain_list', 'everything')).toMatch(/domains\s*=\s*\["\*\."\]/);
    const variables = readFileSync(join(MODULE, 'variables.tf'), 'utf8');
    expect(variables).toMatch(/variable "dns_firewall_action" \{[^}]*default\s*=\s*"ALERT"/);
    expect(resource('aws_route53_resolver_firewall_rule_group_association', 'worker')).toMatch(/vpc_id\s*=\s*aws_vpc\.worker\.id/);
    expect(resource('aws_route53_resolver_firewall_config', 'worker')).toMatch(/firewall_fail_open\s*=\s*"DISABLED"/);
  });

  it('logs every flow and every lookup to KMS log groups', () => {
    expect(resource('aws_flow_log', 'worker')).toMatch(/traffic_type\s*=\s*"ALL"/);
    for (const name of ['flow', 'dns']) {
      expect(resource('aws_cloudwatch_log_group', name), name).toMatch(/kms_key_id\s*=\s*aws_kms_key\.worker\.arn/);
    }
    expect(resource('aws_route53_resolver_query_log_config_association', 'worker')).toMatch(/resource_id\s*=\s*aws_vpc\.worker\.id/);
  });

  it('creates a GuardDuty detector only when none exists, and pulls its Fargate agent with the execution role', () => {
    expect(resource('aws_guardduty_detector', 'worker')).toMatch(/count\s*=\s*var\.guardduty_detector_id == null \? 1 : 0/);
    const feature = resource('aws_guardduty_detector_feature', 'runtime_monitoring');
    expect(feature).toMatch(/name\s*=\s*"RUNTIME_MONITORING"/);
    expect(feature).toMatch(/name\s*=\s*"ECS_FARGATE_AGENT_MANAGEMENT"\s*status\s*=\s*"ENABLED"/);
    expect(resource('aws_iam_role_policy', 'execution')).toMatch(/Resource\s*=\s*\[aws_ecr_repository\.worker\.arn, local\.guardduty_agent_repository_arn\]/);
  });

  it('keeps a multi-region, validated trail in a KMS bucket', () => {
    const trail = resource('aws_cloudtrail', 'worker');
    expect(trail).toMatch(/is_multi_region_trail\s*=\s*true/);
    expect(trail).toMatch(/include_global_service_events\s*=\s*true/);
    expect(trail).toMatch(/enable_log_file_validation\s*=\s*true/);
    expect(trail).toMatch(/kms_key_id\s*=\s*aws_kms_key\.trail\.arn/);
    expect(resource('aws_s3_bucket_versioning', 'trail')).toMatch(/status\s*=\s*"Enabled"/);
    expect(resource('aws_s3_bucket_public_access_block', 'trail')).toMatch(/restrict_public_buckets\s*=\s*true/);
  });
});
