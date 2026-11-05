// Pure decisions for the deploy runner launcher (deploy.mjs; infra/deploy-runner,
// ADR-0028). No AWS or GitHub call here, so `node --test infra/*/lambda/` runs
// it offline. Every function takes its inputs, including the time, as arguments.
import { createSign } from "node:crypto";

export const COMPONENT = "deploy-runner";
export const DEPLOY_LABEL = "conductia-deploy";
export const JIT_PLACEHOLDER = "__JIT_CONFIG__";
// The six reason codes a tripwire record can carry (design R17): four from
// admission and provenance, then a deploy runner that took a refused job (R25)
// and a group that is not exactly what it must be (R0).
export const REASONS = [
  "not_allowlisted",
  "expired",
  "provenance",
  "foreign_repo",
  "served_refused",
  "group_misconfigured",
];

// R0, review 1 #11: the configured group must resolve to exactly one group,
// visibility "selected", public repositories off, and exactly one selected
// repository, this one. Anything else, an empty name included (the repo-mode
// fallback is not built), mints nothing. `facts` is what the handler read:
// { groups: runner-groups list, repositories: that group's repositories, or
// null when the name did not resolve to exactly one group }.
export function groupOk(facts, wanted) {
  const no = { ok: false };
  if (!wanted?.name || !wanted?.repository) return no;
  const named = (facts?.groups ?? []).filter((g) => g?.name === wanted.name);
  if (named.length !== 1) return no;
  const [g] = named;
  if (g.visibility !== "selected" || g.allows_public_repositories !== false)
    return no;
  const repos = facts.repositories;
  if (!Array.isArray(repos) || repos.length !== 1) return no;
  if (repos[0]?.full_name !== wanted.repository) return no;
  if (!Number.isInteger(g.id) || g.id <= 0) return no;
  return { ok: true, id: g.id };
}

// R25: a queued job could take a deploy runner when its labels are a subset of
// the runner's labels, compared case-insensitively. No labels at all (a
// group-only target) is a subset of everything, so it counts.
export function targetsDeploy(job, runnerLabels) {
  const have = new Set(runnerLabels.map((l) => String(l).toLowerCase()));
  return (job?.labels ?? []).every((l) => have.has(String(l).toLowerCase()));
}

// R8, R16: the run must come from this repository, and match an allowlist entry
// on workflow path, branch and event whose expiry has not passed. A called
// workflow runs inside its caller's run, so run.path is the caller's. An entry
// whose expiry cannot be read counts as expired (fail closed).
export function admit(run, allowlist, now, repository) {
  if (
    run?.head_repository?.full_name !== repository ||
    run?.repository?.full_name !== repository
  )
    return "foreign_repo";
  const matching = allowlist.filter(
    (e) =>
      e.workflow === run.path &&
      e.branch === run.head_branch &&
      Array.isArray(e.events) &&
      e.events.includes(run.event),
  );
  if (matching.length === 0) return "not_allowlisted";
  const t = now.getTime();
  const live = matching.some((e) => {
    if (e.expires === undefined || e.expires === null) return true;
    const until = Date.parse(e.expires);
    return Number.isFinite(until) && t <= until;
  });
  return live ? "ok" : "expired";
}

// R16: compare/<head_sha>...<tip of heads/<branch>>. behind_by == 0 means the
// run's commit is the tip or an ancestor of it (the #651 rule, migrate.yml).
export function provenance(comparePayload) {
  return comparePayload?.behind_by === 0 ? "ok" : "provenance";
}

// R26: launch for admitted jobs not already covered by an idle minted runner,
// without exceeding `cap` live deploy VMs in total.
export function toLaunch(admitted, idle, live, cap = 3) {
  return Math.max(0, Math.min(admitted - idle, cap - live));
}

// R25: fail closed. One refused job that could take a deploy runner holds all
// minting this tick, whatever the admitted count. `verdicts` holds one reason
// per queued targeting job ("ok" or a refusal code). `blind` is true when the
// tick could not read every queued job or decide every queued run: a refused
// job may be among the unread ones, so it holds the same way (audit V1). While
// held, every idle minted runner is deregistered (round 2 #4): a connected
// leftover would otherwise stay eligible for the refused job. The handler
// terminates its VM only after the delete succeeded (round 2 #1).
export function decide(
  verdicts,
  idle,
  live,
  cap = 3,
  idleIds = [],
  blind = false,
) {
  const admitted = verdicts.filter((v) => v === "ok").length;
  const refused = verdicts.length - admitted;
  const held = refused > 0 || blind;
  return {
    admitted,
    refused,
    held,
    launch: held ? 0 : toLaunch(admitted, idle, live, cap),
    deregister: held ? [...idleIds] : [],
  };
}

// Review 1 #14: the generate-jitconfig body. GitHub requires a name.
export function jitRequest(groupId, rand) {
  if (!Number.isInteger(groupId) || groupId <= 0)
    throw new Error("jitRequest: bad group id");
  if (!/^[0-9a-f]{12}$/.test(rand))
    throw new Error("jitRequest: rand must be 12 hex digits");
  return {
    name: `deploy-${rand}`,
    runner_group_id: groupId,
    labels: [DEPLOY_LABEL],
    work_folder: "_work",
  };
}

const tag = (instance, key) =>
  instance?.Tags?.find((t) => t.Key === key)?.Value;

// R23, round 2 #9: an instance takes part only if it carries Component =
// deploy-runner, a RunnerId and the deploy template's aws:ec2launchtemplate:id.
// AWS sets the last one on every launch from the template, and nobody can set
// an aws: tag by hand. Any other instance is never counted or acted on.
export function trusted(instance, templateId) {
  return (
    Boolean(templateId) &&
    tag(instance, "Component") === COMPONENT &&
    /^[0-9]+$/.test(tag(instance, "RunnerId") ?? "") &&
    tag(instance, "aws:ec2launchtemplate:id") === templateId
  );
}

// A deploy VM is live while pending or running. Every other state means its
// runner has nothing to run on: shutting-down and terminated after its job or
// its hard cap, and stopping or stopped only by someone else's hand (a deploy VM
// that shuts itself down terminates).
export const LIVE_STATES = ["pending", "running"];
const isLive = (i) => LIVE_STATES.includes(i?.State?.Name);
const isGone = (i) => ["shutting-down", "terminated"].includes(i?.State?.Name);

// Audit V6: a deploy VM boots and connects its runner in about 2 minutes. A
// runner still listed offline and not busy on a VM launched more than
// BOOT_GRACE_MS ago never connected (a hung boot: a stalled download or
// dependency install) or lost its connection. It is not capacity: it neither
// counts as idle nor holds back a launch, and staleInstances retires it. A VM
// whose launch time cannot be read is never judged stuck.
export const BOOT_GRACE_MS = 10 * 60 * 1000;

const launchedAt = (i) => new Date(i?.LaunchTime ?? NaN).getTime();
const stuck = (r, i, t) =>
  Boolean(r) &&
  r.busy !== true &&
  r.status !== "online" &&
  Number.isFinite(t) &&
  Number.isFinite(launchedAt(i)) &&
  t - launchedAt(i) > BOOT_GRACE_MS;

// R23 over trusted instances only (the template id is passed so an untrusted
// instance can never be classified, whoever calls this). Each group runner is:
//   known    its id is tagged on a live instance (a booting one included);
//   idle     known and not busy. A runner that has not connected yet is listed
//            offline and not busy, so a booting VM counts as idle capacity and
//            the next tick does not launch a second VM for the same job (R26).
//            Past BOOT_GRACE_MS it is stuck, not idle (audit V6; needs `now`);
//   reap     its id is tagged only on an instance that is no longer live, and
//            GitHub still lists it: delete it;
//   unknown  its id is tagged on no trusted instance: the launcher never minted
//            it, or minted it and lost its VM before tagging could say so.
// `live` counts the trusted live instances, for the cap (R26). The runner lists
// hold GitHub's runner objects.
export function classifyRunners(runners, instances, templateId, now) {
  const mine = instances.filter((i) => trusted(i, templateId));
  const liveVm = new Map(
    mine.filter(isLive).map((i) => [tag(i, "RunnerId"), i]),
  );
  const onAny = new Set(mine.map((i) => tag(i, "RunnerId")));
  const t = now?.getTime();
  const out = { known: [], idle: [], reap: [], unknown: [] };
  for (const r of runners) {
    const id = String(r?.id);
    if (liveVm.has(id)) {
      out.known.push(r);
      if (r.busy !== true && !stuck(r, liveVm.get(id), t)) out.idle.push(r);
    } else if (onAny.has(id)) out.reap.push(r);
    else out.unknown.push(r);
  }
  return { ...out, live: mine.filter(isLive).length };
}

// R23: an unknown runner, ids and state only. No name: whoever registered the
// runner chose it.
export function unknownRunner(r) {
  return {
    event: "deploy_unknown_runner",
    runner_id: Number.isInteger(r?.id) ? r.id : null,
    status: r?.status === "online" ? "online" : "offline",
    busy: r?.busy === true,
  };
}

// R26, round 2 #1 and #4. A deploy VM boots in about 2 minutes, so an instance
// older than 7 minutes whose runner is online and idle has sat idle about 5
// minutes. At 130 minutes a VM is past its own 120-minute shutdown and every job
// timeout.
export const IDLE_AFTER_MS = 7 * 60 * 1000;
export const HARD_CAP_MS = 130 * 60 * 1000;

// R26: which trusted VMs to retire. Candidates only: the handler acts on them.
//   deleteFirst  a live VM whose runner is online and idle, launched more than
//                IDLE_AFTER_MS ago; a live VM whose runner is stuck (never
//                online past BOOT_GRACE_MS, audit V6); and, while more than
//                `cap` VMs are live,
//                the newest VMs with an idle runner, enough to come back to the
//                cap. The busy flag is from earlier in the tick, so the handler
//                deletes the runner first and terminates only if the delete
//                succeeded and no in-progress job carries the runner's id.
//   hardCap      a VM launched more than HARD_CAP_MS ago, in any state but gone,
//                busy or not. Terminated without the delete.
// A VM whose launch time cannot be read is never a candidate: guessing could
// end a production migration. Each candidate is { instanceId, runnerId }.
export function staleInstances(instances, runners, now, cap = 3, templateId) {
  const t = now.getTime();
  const byId = new Map(runners.map((r) => [String(r?.id), r]));
  const candidate = (i) => ({
    instanceId: i.InstanceId,
    runnerId: Number(tag(i, "RunnerId")),
  });
  const mine = instances.filter(
    (i) =>
      trusted(i, templateId) && !isGone(i) && Number.isFinite(launchedAt(i)),
  );
  const hardCap = mine.filter((i) => t - launchedAt(i) > HARD_CAP_MS);
  const live = mine.filter((i) => isLive(i) && !hardCap.includes(i));
  const runnerOf = (i) => byId.get(tag(i, "RunnerId"));
  const idleRunner = (i) => runnerOf(i) && runnerOf(i).busy !== true;

  const idle = live.filter(
    (i) =>
      (idleRunner(i) &&
        runnerOf(i).status === "online" &&
        t - launchedAt(i) > IDLE_AFTER_MS) ||
      stuck(runnerOf(i), i, t),
  );
  // Over the cap once the idle ones are gone: the newest idle VMs next.
  const excess = live.length - idle.length - cap;
  const overCap =
    excess > 0
      ? live
          .filter((i) => idleRunner(i) && !idle.includes(i))
          .sort((a, b) => launchedAt(b) - launchedAt(a))
          .slice(0, excess)
      : [];
  return {
    deleteFirst: [...idle, ...overCap].map(candidate),
    hardCap: hardCap.map(candidate),
  };
}

// The deleteFirst list a tick acts on: the stale candidates, plus, while held,
// every idle minted runner on a live VM (the purge, R25 round 2 #4). One entry
// per VM; a hard-capped VM is left to the hard cap.
export function retireList(stale, deregisterIds, instances, templateId) {
  const hard = new Set(stale.hardCap.map((c) => c.instanceId));
  const purge = new Set(deregisterIds.map(String));
  const held = instances
    .filter(
      (i) =>
        trusted(i, templateId) && isLive(i) && purge.has(tag(i, "RunnerId")),
    )
    .map((i) => ({
      instanceId: i.InstanceId,
      runnerId: Number(tag(i, "RunnerId")),
    }));
  const seen = new Set();
  return [...stale.deleteFirst, ...held].filter((c) => {
    if (hard.has(c.instanceId) || seen.has(c.instanceId)) return false;
    seen.add(c.instanceId);
    return true;
  });
}

// Every runner id the launcher minted that DescribeInstances still returns, in
// any state (terminated instances stay listed for about an hour). Trusted
// instances only, so a forged tag never makes a runner look minted.
export function mintedRunnerIds(instances, templateId) {
  return new Set(
    instances
      .filter((i) => trusted(i, templateId))
      .map((i) => tag(i, "RunnerId")),
  );
}

// R17: one tripwire record, ids and a code only. Never a branch, workflow name,
// actor or message: a branch name is attacker-chosen text. group_misconfigured
// carries no ids (R0); served_refused adds the runner that took the job (R25).
export function tripwire(run, job, reason, runnerId) {
  if (!REASONS.includes(reason))
    throw new Error("tripwire: unknown reason code");
  if (reason === "group_misconfigured")
    return { event: "deploy_tripwire", reason };
  const record = {
    event: "deploy_tripwire",
    run_id: run?.id,
    job_id: job?.id,
    reason,
  };
  if (reason === "served_refused") record.runner_id = runnerId;
  return record;
}

// R25, round 2 #5: each held tick says how many admitted jobs wait behind the
// refusal, so a renewed freeze on a release day alarms (DeployHeldWithAdmittedWaiting).
export function holdRecord(refused, admittedWaiting) {
  return {
    event: "deploy_hold",
    refused,
    admitted_waiting: admittedWaiting,
  };
}

// Audit V1: a read the tick could not finish, so a check ran on less than it
// should. scope "queued": a run list, a run's jobs or a queued run's admission
// read failed, so the tick holds (decide, blind). scope "posthoc": the
// completed-run list or a run's jobs or verdict failed, so a deploy runner may
// have taken a refused job unseen. The error is a name (TooManyPages,
// GitHubError:<status>, TimeoutError, OutOfTime), never a message. The tripwire
// alarm fires on it, and the tick goes on with what it read.
export const BLIND_SCOPES = ["queued", "posthoc"];
// A run whose ref or compare read failed: neither admitted nor refused.
export const UNREADABLE = "unreadable";
export function blindRecord(scope, errorName) {
  if (!BLIND_SCOPES.includes(scope))
    throw new Error("blindRecord: unknown scope");
  return { event: "deploy_blind", scope, error: String(errorName) };
}

// Audit V8: the tick's own time budget, inside the function's 50 s timeout. No
// GitHub read or delete starts after READ_BUDGET_MS, and no mint after
// MINT_BUDGET_MS: a mint is up to 8 s of generate-jitconfig, the launch, and up
// to 8 s of cleanup if the launch fails, and a tick killed in between leaves a
// runner with no VM. A held tick mints nothing, so its purge (the deletes of
// idle minted runners and the jobs re-read before their terminate) may run on
// to PURGE_BUDGET_MS: a hold that cannot purge leaves an idle runner open to
// the refused job (fix check N1). Its last call still ends inside the timeout.
export const READ_BUDGET_MS = 25 * 1000;
export const MINT_BUDGET_MS = 28 * 1000;
export const PURGE_BUDGET_MS = 36 * 1000;
export function outOfTime() {
  const e = new Error("the tick's time budget is spent");
  e.name = "OutOfTime";
  return e;
}

// R25 post-hoc check, round 2 #3. Completed runs are listed only back to
// created >= now - 130 min (a deploy VM lives at most 120), and of those only
// the runs updated in the last 5 minutes have their jobs re-read. A run whose
// updated_at cannot be read is re-read too: checking costs one call, missing
// costs the alert.
export const COMPLETED_LOOKBACK_MS = 130 * 60 * 1000;
export const POST_HOC_WINDOW_MS = 5 * 60 * 1000;

export function completedSince(now) {
  const from = new Date(now.getTime() - COMPLETED_LOOKBACK_MS);
  return `>=${from.toISOString().replace(/\.\d{3}Z$/, "Z")}`;
}

export function postHocRuns(completedRuns, now) {
  const from = now.getTime() - POST_HOC_WINDOW_MS;
  return completedRuns.filter((r) => {
    const t = Date.parse(r?.updated_at);
    return !Number.isFinite(t) || t >= from;
  });
}

// A job ran on a deploy runner if GitHub says it ran in the deploy group, or if
// its runner is one the launcher minted. The group id needs no EC2 tag, so it
// still holds after the instance drops out of DescribeInstances.
export function servedByDeploy(job, groupId, mintedIds) {
  if (Number.isInteger(groupId) && job?.runner_group_id === groupId)
    return true;
  const id = job?.runner_id;
  return id !== null && id !== undefined && mintedIds.has(String(id));
}

// R25: every job a deploy runner took whose run the launcher would refuse.
// `entries` are { run, job } pairs (jobs read with filter=all, so every attempt
// counts); `verdictOf(run)` is that run's admit-then-provenance reason. A run
// with no verdict counts as refused: loud by mistake is the right failure.
export function servedRefused(entries, groupId, mintedIds, verdictOf) {
  return entries
    .filter(({ job }) => servedByDeploy(job, groupId, mintedIds))
    .filter(({ run }) => verdictOf(run) !== "ok")
    .map(({ run, job }) => tripwire(run, job, "served_refused", job.runner_id));
}

// R7: each tick's installation token carries only what group mode needs, for
// this repository only. Never Administration (that is the cut fallback, O3b).
export function tokenRequest(repository) {
  return {
    repositories: [repository.split("/")[1]],
    permissions: {
      actions: "read",
      contents: "read",
      metadata: "read",
      organization_self_hosted_runners: "write",
    },
  };
}

const b64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

// R7: the App JWT, RS256, issued 60 s in the past (clock drift) and expiring
// within GitHub's 10-minute limit.
export function appJwt(appId, privateKeyPem, nowMs) {
  if (!/^[0-9]+$/.test(String(appId ?? "")))
    throw new Error("appJwt: bad App id");
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ iat, exp: iat + 540, iss: Number(appId) }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(signer.sign(privateKeyPem))}`;
}

// The VM's user data: the rendered boot script with one runner's JIT config in
// place of the placeholder. The config is base64, so it is safe inside the
// script's single quotes; anything else is refused.
export function userData(script, encodedJitConfig) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedJitConfig ?? ""))
    throw new Error("userData: the JIT config is not base64");
  const parts = script.split(JIT_PLACEHOLDER);
  if (parts.length !== 2)
    throw new Error("userData: the script must hold the placeholder once");
  return Buffer.from(parts.join(encodedJitConfig), "utf8").toString("base64");
}

// R7: RunInstances always names the template by id and the version tofu pinned,
// never $Default or $Latest, and tags every resource it creates with Component
// and the runner it carries (the role checks aws:RequestTag/Component).
export function launchParams({
  templateId,
  version,
  userData: data,
  runnerId,
  dryRun = false,
}) {
  if (!/^[0-9]+$/.test(String(version ?? "")))
    throw new Error("launchParams: the template version must be pinned");
  const tags = [
    { Key: "Component", Value: COMPONENT },
    { Key: "RunnerId", Value: String(runnerId) },
    { Key: "Name", Value: "conductia-deploy-runner" },
    { Key: "Project", Value: "conductia" },
  ];
  const params = {
    LaunchTemplate: { LaunchTemplateId: templateId, Version: String(version) },
    MinCount: 1,
    MaxCount: 1,
    TagSpecifications: ["instance", "volume", "network-interface"].map(
      (ResourceType) => ({ ResourceType, Tags: tags }),
    ),
  };
  if (data !== undefined) params.UserData = data;
  if (dryRun) params.DryRun = true;
  return params;
}

// Round 2 #7: the cold-start DryRun of RunInstances. DryRunOperation means the
// role may launch; UnauthorizedOperation means it may not.
export function selfcheck(errorName) {
  const run_instances =
    errorName === "DryRunOperation"
      ? "authorized"
      : errorName === "UnauthorizedOperation"
        ? "denied"
        : "error";
  return { event: "deploy_selfcheck", run_instances };
}

// The Lambda's environment (launcher.tf), parsed once. A missing or malformed
// value throws, so the tick fails before any GitHub or EC2 call.
export function config(env) {
  const need = (k) => {
    if (!env[k]) throw new Error(`config: ${k} is not set`);
    return env[k];
  };
  const allowlist = JSON.parse(need("ALLOWLIST"));
  if (!Array.isArray(allowlist)) throw new Error("config: ALLOWLIST");
  const cap = Number(env.CAP ?? 3);
  if (!Number.isInteger(cap) || cap < 0) throw new Error("config: CAP");
  return {
    repository: need("REPO"),
    org: need("REPO").split("/")[0],
    appId: need("GITHUB_APP_ID"),
    installationId: need("GITHUB_APP_INSTALLATION_ID"),
    appKeyParam: need("APP_KEY_PARAM"),
    groupName: env.GROUP_NAME ?? "",
    runnerLabels: need("RUNNER_LABELS").split(",").filter(Boolean),
    allowlist,
    templateId: need("TEMPLATE_ID"),
    templateVersion: need("LAUNCH_TEMPLATE_VERSION"),
    cap,
  };
}
