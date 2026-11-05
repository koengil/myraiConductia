// node --test infra/deploy-runner/lambda/  (not shipped in the Lambda zip)
// One launcher tick (deploy.mjs) against a stubbed GitHub and EC2: what it reads,
// what it mints and launches, and that it fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tick } from "./deploy.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const TEMPLATE = "lt-0123456789abcdef0";
const MAIN_TIP = fixture("ref-heads-main.json").object.sha;
const promoteRun = { ...fixture("run-promote-develop-to-staging.json"), status: "in_progress" };
const queuedMigrate = fixture("jobs-promote-queued-migrate.json").jobs[0];
const SCRIPT = "#!/bin/bash\nshutdown -h +120\njit='__JIT_CONFIG__'\n";

const cfg = (over = {}) => ({
  repository: "Conductia/Conductia",
  org: "Conductia",
  appId: "123",
  installationId: "456",
  appKeyParam: "/conductia/deploy-runner/github-app-key",
  groupName: "conductia-deploy",
  runnerLabels: ["conductia-deploy", "self-hosted", "Linux", "X64"],
  allowlist: [
    { workflow: ".github/workflows/promote-develop-to-staging.yml", branch: "main", events: ["workflow_dispatch"] },
    { workflow: ".github/workflows/migrate.yml", branch: "main", events: ["push", "workflow_dispatch"] },
  ],
  templateId: TEMPLATE,
  templateVersion: "4",
  cap: 3,
  ...over,
});

// A stubbed GitHub: runs, their jobs, the group, its runners, refs and compares.
// `runs` maps a run to its jobs; `compare` answers compare/<sha>...<tip>.
// `deleteStatus(id)` answers DELETE /orgs/Conductia/actions/runners/{id} (204 by default).
function github({ runs = [], groups = fixture("runner-groups.json"), runners = { runners: [] }, compare = () => fixture("compare-on-branch.json"), deleteStatus = () => 204 } = {}) {
  const calls = [];
  const gh = async (method, path, body, label) => {
    calls.push({ method, path, body, label });
    const p = path.replace(/[?&]per_page=\d+&page=\d+$/, "");
    if (method === "POST" && p === "/orgs/Conductia/actions/runners/generate-jitconfig") return fixture("generate-jitconfig.json");
    if (p === "/orgs/Conductia/actions/runner-groups") return groups;
    if (p === "/orgs/Conductia/actions/runner-groups/7/repositories") return fixture("runner-group-repositories.json");
    if (p === "/orgs/Conductia/actions/runner-groups/7/runners") return runners;
    const del = method === "DELETE" && p.match(/^\/orgs\/Conductia\/actions\/runners\/(\d+)$/)?.[1];
    if (del) {
      const status = deleteStatus(Number(del));
      if (status === 204) return null;
      const e = new Error(`GitHub delete runner -> ${status}`);
      e.name = "GitHubError";
      e.status = status;
      throw e;
    }
    const list = p.match(/^\/repos\/Conductia\/Conductia\/actions\/runs\?status=(\w+)(?:&created=([^&]+))?$/);
    if (list) {
      const [, status, created] = list;
      assert.equal(status === "completed", created !== undefined, "only the completed list is bounded by created");
      const since = created && Date.parse(decodeURIComponent(created).slice(2));
      return {
        workflow_runs: runs
          .map((r) => r.run)
          .filter((r) => r.status === status && (!since || Date.parse(r.created_at) >= since)),
      };
    }
    const jobsOf = p.match(/^\/repos\/Conductia\/Conductia\/actions\/runs\/(\d+)\/jobs\?filter=all$/)?.[1];
    if (jobsOf) return { jobs: runs.find((r) => String(r.run.id) === jobsOf).jobs };
    if (p === "/repos/Conductia/Conductia/git/ref/heads/main") return fixture("ref-heads-main.json");
    const cmp = p.match(/^\/repos\/Conductia\/Conductia\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
    if (cmp) return compare(cmp[1], cmp[2]);
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { gh, calls };
}

function ec2({ instances = [], runError, terminateError } = {}) {
  const runs = [];
  const terminated = [];
  return {
    runs,
    terminated,
    terminate: async (id) => {
      if (terminateError) {
        const e = new Error("no");
        e.name = terminateError;
        throw e;
      }
      terminated.push(id);
      return { TerminatingInstances: [{ InstanceId: id }] };
    },
    describe: async () => instances,
    run: async (params) => {
      runs.push(params);
      if (params.DryRun) {
        const e = new Error("dry run");
        e.name = "DryRunOperation";
        throw e;
      }
      if (runError) {
        const e = new Error("no capacity");
        e.name = runError;
        throw e;
      }
      return { Instances: [{ InstanceId: "i-new" }] };
    },
  };
}

async function drive({ gh, ec2: e, config = cfg(), doSelfcheck = false, now = new Date("2026-10-22T12:00:00Z"), clock }) {
  const logs = [];
  const summary = await tick({
    ...(clock ? { clock } : {}),
    cfg: config,
    connect: async () => gh,
    ec2: e,
    now,
    rand: () => "0123456789ab",
    script: SCRIPT,
    log: (r) => logs.push(r),
    doSelfcheck,
  });
  return { summary, logs };
}

const minted = (calls) => calls.filter((c) => c.label === "generate-jitconfig");

test("an admitted queued job on its branch gets one JIT runner and one VM from the pinned template", async () => {
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  const e = ec2();
  const { summary } = await drive({ gh, ec2: e });

  assert.equal(minted(calls).length, 1);
  assert.deepEqual(minted(calls)[0].body, { name: "deploy-0123456789ab", runner_group_id: 7, labels: ["conductia-deploy"], work_folder: "_work" });
  assert.equal(e.runs.length, 1);
  const [launch] = e.runs;
  assert.deepEqual(launch.LaunchTemplate, { LaunchTemplateId: TEMPLATE, Version: "4" });
  assert.ok(launch.TagSpecifications.every((t) => t.Tags.some((x) => x.Key === "RunnerId" && x.Value === "5003")));
  const data = Buffer.from(launch.UserData, "base64").toString("utf8");
  assert.ok(data.includes(`jit='${fixture("generate-jitconfig.json").encoded_jit_config}'`));
  assert.deepEqual(summary, {
    event: "deploy_tick",
    group: "ok",
    queued: 1,
    admitted: 1,
    refused: 0,
    served_refused: 0,
    unknown: 0,
    reaped: 0,
    deregistered: 0,
    terminated: 0,
    launched: 1,
    idle: 0,
    live: 0,
    github_calls: calls.length,
  });
  assert.equal(calls.length, 10, "group, its repositories and runners, three run lists, one jobs read, ref, compare, mint");
});

test("provenance compares the run's commit with the tip read from refs/heads, never the bare name", async () => {
  const seen = [];
  const { gh, calls } = github({
    runs: [{ run: promoteRun, jobs: [queuedMigrate] }],
    compare: (sha, tip) => (seen.push([sha, tip]), fixture("compare-on-branch.json")),
  });
  await drive({ gh, ec2: ec2() });
  assert.deepEqual(seen, [[promoteRun.head_sha, MAIN_TIP]]);
  assert.ok(calls.some((c) => c.path === "/repos/Conductia/Conductia/git/ref/heads/main"));
});

test("a run whose commit is off its branch mints nothing", async () => {
  const { gh, calls } = github({
    runs: [{ run: promoteRun, jobs: [queuedMigrate] }],
    compare: () => fixture("compare-off-branch.json"),
  });
  const e = ec2();
  const { summary } = await drive({ gh, ec2: e });
  assert.equal(minted(calls).length, 0);
  assert.equal(e.runs.length, 0);
  assert.equal(summary.refused, 1);
});

test("the hold: one refused targeting job means nothing is minted, even for an admitted one", async () => {
  const scratch = { ...promoteRun, id: 900, head_branch: "canary/deploy-refused" };
  const { gh, calls } = github({
    runs: [
      { run: promoteRun, jobs: [queuedMigrate] },
      { run: scratch, jobs: [{ ...queuedMigrate, id: 901, run_id: 900, labels: ["conductia-deploy"] }] },
    ],
  });
  const e = ec2();
  const { summary, logs } = await drive({ gh, ec2: e });
  assert.equal(minted(calls).length, 0);
  assert.equal(e.runs.length, 0);
  assert.equal(summary.admitted, 1);
  assert.equal(summary.refused, 1);
  assert.equal(summary.launched, 0);
  assert.doesNotMatch(JSON.stringify(logs), /canary|deploy-refused/, "no branch name reaches the log");
  assert.ok(!calls.some((c) => c.path.includes("canary")), "a refused run's branch is never resolved");
});

test("jobs that cannot take a deploy runner are ignored", async () => {
  const hosted = fixture("jobs-promote-develop-to-staging.json").jobs.map((j) => ({ ...j, status: "queued" }));
  const scratch = { ...promoteRun, id: 902, head_branch: "feature/x" };
  const { gh, calls } = github({ runs: [{ run: scratch, jobs: hosted }] });
  const { summary } = await drive({ gh, ec2: ec2() });
  assert.equal(summary.queued, 0);
  assert.equal(summary.refused, 0);
  assert.equal(minted(calls).length, 0);
});

test("a misconfigured or unnamed group mints nothing and reads no runs", async () => {
  const groups = fixture("runner-groups.json");
  const variants = {
    "visibility all": { groups: { ...groups, runner_groups: groups.runner_groups.map((g) => (g.id === 7 ? { ...g, visibility: "all" } : g)) } },
    "public repositories": { groups: { ...groups, runner_groups: groups.runner_groups.map((g) => (g.id === 7 ? { ...g, allows_public_repositories: true } : g)) } },
    "missing group": { groups: { ...groups, runner_groups: [groups.runner_groups[0]] } },
  };
  for (const [name, over] of Object.entries(variants)) {
    const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], ...over });
    const e = ec2();
    const { summary, logs } = await drive({ gh, ec2: e });
    assert.equal(summary.group, "misconfigured", name);
    assert.deepEqual(logs[0], { event: "deploy_tripwire", reason: "group_misconfigured" }, name);
    assert.equal(minted(calls).length + e.runs.length, 0, name);
    assert.ok(!calls.some((c) => c.label === "runs"), name);
  }
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  const { summary } = await drive({ gh, ec2: ec2(), config: cfg({ groupName: "" }) });
  assert.equal(summary.group, "misconfigured", "empty group name");
  assert.equal(minted(calls).length, 0);
});

test("the cap counts trusted live VMs only; a forged instance neither fills nor frees it", async () => {
  const tags = (runnerId, template = TEMPLATE) => [
    { Key: "Component", Value: "deploy-runner" },
    { Key: "RunnerId", Value: String(runnerId) },
    { Key: "aws:ec2launchtemplate:id", Value: template },
  ];
  const full = [1, 2, 3].map((n) => ({ InstanceId: `i-${n}`, State: { Name: "running" }, Tags: tags(6000 + n) }));
  let { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  let out = await drive({ gh, ec2: ec2({ instances: full }) });
  assert.equal(out.summary.live, 3);
  assert.equal(minted(calls).length, 0, "three live deploy VMs: at the cap");

  const forged = [1, 2, 3].map((n) => ({ InstanceId: `i-${n}`, State: { Name: "running" }, Tags: tags(6000 + n, "lt-other") }));
  ({ gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] }));
  out = await drive({ gh, ec2: ec2({ instances: forged }) });
  assert.equal(out.summary.live, 0);
  assert.equal(minted(calls).length, 1);
});

test("an idle minted runner on a booting VM covers the job: no second VM", async () => {
  const instances = [{
    InstanceId: "i-1",
    State: { Name: "pending" },
    Tags: [
      { Key: "Component", Value: "deploy-runner" },
      { Key: "RunnerId", Value: "5001" },
      { Key: "aws:ec2launchtemplate:id", Value: TEMPLATE },
    ],
  }];
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners: fixture("group-runners.json") });
  const { summary } = await drive({ gh, ec2: ec2({ instances }) });
  assert.equal(summary.idle, 1);
  assert.equal(minted(calls).length, 0);
});

test("a failed launch deletes the runner just minted, records the error name and stops launching this tick", async () => {
  const second = { ...queuedMigrate, id: 115925600002 };
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate, second] }] });
  const e = ec2({ runError: "InsufficientInstanceCapacity" });
  const { summary } = await drive({ gh, ec2: e });
  assert.equal(minted(calls).length, 1);
  assert.equal(summary.launched, 0);
  assert.equal(summary.error, "InsufficientInstanceCapacity");
  const jitAt = calls.findIndex((c) => c.label === "generate-jitconfig");
  const delAt = calls.findIndex((c) => c.method === "DELETE");
  assert.ok(jitAt >= 0 && delAt > jitAt, "the DELETE follows the mint");
  assert.equal(calls[delAt].path, `/orgs/Conductia/actions/runners/${fixture("generate-jitconfig.json").runner.id}`);
  assert.equal(summary.reaped, 1);
  assert.equal(e.terminated.length, 0);
});

test("a failed launch whose cleanup DELETE fails too keeps both error names; the next tick reports the runner as unknown", async () => {
  const { gh } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], deleteStatus: () => 503 });
  const { summary } = await drive({ gh, ec2: ec2({ runError: "InsufficientInstanceCapacity" }) });
  assert.equal(summary.error, "InsufficientInstanceCapacity,GitHubError:503");
  assert.equal(summary.reaped, 0);

  const left = { runners: [{ ...fixture("generate-jitconfig.json").runner }] };
  const next = github({ runners: left });
  const { logs } = await drive({ gh: next.gh, ec2: ec2() });
  assert.deepEqual(logs.filter((l) => l.event === "deploy_unknown_runner"), [
    { event: "deploy_unknown_runner", runner_id: 5003, status: "offline", busy: false },
  ]);
});

test("the cold-start self-check is a DryRun of the real launch, logged once as a record", async () => {
  const { gh } = github();
  const e = ec2();
  const { logs } = await drive({ gh, ec2: e, doSelfcheck: true });
  assert.equal(e.runs.length, 1);
  assert.equal(e.runs[0].DryRun, true);
  assert.deepEqual(e.runs[0].LaunchTemplate, { LaunchTemplateId: TEMPLATE, Version: "4" });
  assert.deepEqual(logs[0], { event: "deploy_selfcheck", run_instances: "authorized" });

  const again = await drive({ gh, ec2: ec2(), doSelfcheck: false });
  assert.ok(!again.logs.some((l) => l.event === "deploy_selfcheck"));
});

test("every record is an object of counts and codes", async () => {
  const { gh } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  const { logs } = await drive({ gh, ec2: ec2(), doSelfcheck: true });
  for (const r of logs) {
    assert.equal(typeof r, "object");
    for (const v of Object.values(r)) assert.ok(["number", "string", "boolean"].includes(typeof v));
  }
  const text = JSON.stringify(logs);
  assert.doesNotMatch(text, /ZmFrZS1qaXQ|deploy-0123456789ab|22cf73bf/, "no JIT config, runner name or commit");
});

// Phase 3: the tripwire, the hold and its purge, the post-hoc check ---------------------------

const deployInstance = (id, runnerId, state = "running", launchTime) => ({
  InstanceId: id,
  State: { Name: state },
  ...(launchTime ? { LaunchTime: launchTime } : {}),
  Tags: [
    { Key: "Component", Value: "deploy-runner" },
    { Key: "RunnerId", Value: String(runnerId) },
    { Key: "aws:ec2launchtemplate:id", Value: TEMPLATE },
  ],
});
const scratchRun = { ...promoteRun, id: 900, head_branch: "canary/deploy-refused" };
const scratchJob = { ...queuedMigrate, id: 901, run_id: 900, labels: ["conductia-deploy"] };
const prRun = fixture("run-ci-pull-request-attempt-2.json");
const prJobs = fixture("jobs-ci-pull-request-attempt-2-served.json").jobs;
const deletes = (calls) => calls.filter((c) => c.method === "DELETE").map((c) => c.path);
const byEvent = (logs, event) => logs.filter((l) => l.event === event);

test("a refused targeting job is logged as a tripwire with ids and a code only, once per tick", async () => {
  const { gh } = github({ runs: [{ run: scratchRun, jobs: [scratchJob] }] });
  const { logs } = await drive({ gh, ec2: ec2() });
  assert.deepEqual(byEvent(logs, "deploy_tripwire"), [{ event: "deploy_tripwire", run_id: 900, job_id: 901, reason: "not_allowlisted" }]);
});

test("the hold: one record with the admitted jobs waiting, and every idle minted runner deregistered, then its VM terminated", async () => {
  const runners = {
    runners: [
      { id: 5001, status: "online", busy: false },
      { id: 5002, status: "online", busy: true },
      { id: 5007, status: "online", busy: false }, // no instance: never minted, so reported, never deleted
    ],
  };
  const { gh, calls } = github({
    runs: [{ run: promoteRun, jobs: [queuedMigrate] }, { run: scratchRun, jobs: [scratchJob] }],
    runners,
  });
  const e = ec2({ instances: [deployInstance("i-1", 5001), deployInstance("i-2", 5002)] });
  const { summary, logs } = await drive({ gh, ec2: e });
  assert.deepEqual(byEvent(logs, "deploy_hold"), [{ event: "deploy_hold", refused: 1, admitted_waiting: 1 }]);
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5001"]);
  assert.deepEqual(e.terminated, ["i-1"], "the purge's terminate half (round 2 #4), after the delete");
  assert.deepEqual(byEvent(logs, "deploy_unknown_runner").map((r) => r.runner_id), [5007]);
  assert.equal(summary.deregistered, 1);
  assert.equal(summary.terminated, 1);
  assert.equal(summary.launched, 0);
  assert.equal(minted(calls).length, 0);
  assert.equal(e.runs.length, 0, "no RunInstances");
});

test("the purge: a runner that took a job since the list answers 422 and keeps its VM; the rest are deregistered and terminated", async () => {
  const runners = { runners: [{ id: 5001, busy: false }, { id: 5003, busy: false }] };
  const { gh, calls } = github({
    runs: [{ run: scratchRun, jobs: [scratchJob] }],
    runners,
    deleteStatus: (id) => (id === 5001 ? 422 : 204),
  });
  const instances = [deployInstance("i-1", 5001), deployInstance("i-3", 5003, "pending")];
  const e = ec2({ instances });
  const { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5001", "/orgs/Conductia/actions/runners/5003"]);
  assert.deepEqual(e.terminated, ["i-3"]);
  assert.equal(summary.deregistered, 1);
  assert.equal(summary.error, "GitHubError:422");
});

test("no refusal, no hold: no hold record and no deregistration", async () => {
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners: { runners: [{ id: 5001, busy: false }] } });
  const { logs } = await drive({ gh, ec2: ec2({ instances: [deployInstance("i-1", 5001, "pending")] }) });
  assert.equal(byEvent(logs, "deploy_hold").length, 0);
  assert.equal(byEvent(logs, "deploy_tripwire").length, 0);
  assert.deepEqual(deletes(calls), []);
});

test("post-hoc: an in-progress refused run whose job a deploy runner took raises served_refused", async () => {
  const run = { ...prRun, status: "in_progress" };
  const { gh } = github({ runs: [{ run, jobs: prJobs }] });
  const { summary, logs } = await drive({ gh, ec2: ec2(), now: new Date("2026-10-21T18:13:00Z") });
  assert.deepEqual(byEvent(logs, "deploy_tripwire"), [
    { event: "deploy_tripwire", run_id: prRun.id, job_id: 119397590001, reason: "served_refused", runner_id: 5004 },
  ]);
  assert.equal(summary.served_refused, 1);
  assert.doesNotMatch(JSON.stringify(logs), /feat\/639|cf88365d/, "no branch or commit reaches the log");
});

test("post-hoc, round 2 #3: a refused job that started and ended between ticks is caught from the completed run (attempt 2)", async () => {
  const { gh, calls } = github({ runs: [{ run: prRun, jobs: prJobs }] });
  const { logs } = await drive({ gh, ec2: ec2(), now: new Date("2026-10-21T18:21:00Z") });
  const list = calls.find((c) => c.path.includes("status=completed"));
  assert.match(list.path, /status=completed&created=%3E%3D2026-10-21T16%3A11%3A00Z&per_page=100&page=1$/);
  assert.ok(calls.some((c) => c.path === `/repos/Conductia/Conductia/actions/runs/${prRun.id}/jobs?filter=all&per_page=100&page=1`), "filter=all");
  assert.deepEqual(byEvent(logs, "deploy_tripwire").map((r) => [r.reason, r.job_id, r.runner_id]), [["served_refused", 119397590001, 5004]]);
});

test("post-hoc: a completed run updated outside the 5-minute window is not fetched", async () => {
  const { gh, calls } = github({ runs: [{ run: prRun, jobs: prJobs }] });
  const { logs } = await drive({ gh, ec2: ec2(), now: new Date("2026-10-21T18:25:00Z") });
  assert.ok(!calls.some((c) => c.label === "jobs"), "no jobs call");
  assert.equal(byEvent(logs, "deploy_tripwire").length, 0);
});

test("post-hoc: a job matched only by runner_group_id still counts after its instance aged out; one matched only by a minted id counts too", async () => {
  // No instances at all: the group id alone identifies the deploy runner.
  let { gh } = github({ runs: [{ run: prRun, jobs: prJobs }] });
  let out = await drive({ gh, ec2: ec2({ instances: [] }), now: new Date("2026-10-21T18:21:00Z") });
  assert.equal(out.summary.served_refused, 1);

  // Another group id, but the runner is one the launcher minted (a terminated VM still listed).
  const jobs = prJobs.map((j) => (j.runner_id === 5004 ? { ...j, runner_group_id: 1 } : j));
  ({ gh } = github({ runs: [{ run: prRun, jobs }] }));
  out = await drive({ gh, ec2: ec2({ instances: [deployInstance("i-9", 5004, "terminated")] }), now: new Date("2026-10-21T18:21:00Z") });
  assert.equal(out.summary.served_refused, 1);

  ({ gh } = github({ runs: [{ run: prRun, jobs }] }));
  out = await drive({ gh, ec2: ec2({ instances: [] }), now: new Date("2026-10-21T18:21:00Z") });
  assert.equal(out.summary.served_refused, 0, "neither key: not a deploy runner");
});

test("post-hoc: an admitted run served by a deploy runner raises nothing", async () => {
  const served = { ...queuedMigrate, status: "completed", runner_id: 5003, runner_group_id: 7 };
  const run = { ...promoteRun, status: "in_progress" };
  const { gh } = github({ runs: [{ run, jobs: [served] }] });
  const { summary, logs } = await drive({ gh, ec2: ec2() });
  assert.equal(summary.served_refused, 0);
  assert.equal(byEvent(logs, "deploy_tripwire").length, 0);
});

// Audit V1: a failed read blinds one check; the tick still alerts, holds and purges ---------

const ghError = (name, status) => {
  const e = new Error(`GitHub ${status ?? ""}`);
  e.name = name;
  if (status) e.status = status;
  return e;
};
// Wraps a stubbed GitHub so that any call matching `when` throws `error`.
const failing = (base, when, error) => async (method, path, body, label) => {
  if (when(method, path, label)) throw error;
  return base.gh(method, path, body, label);
};

test("audit V1: a completed-run list that overflows still lets the tick alert, hold, purge and catch served_refused", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  const base = github({
    runs: [
      { run: scratchRun, jobs: [scratchJob] }, // queued and refused
      { run: { ...prRun, status: "in_progress" }, jobs: prJobs }, // refused, served by runner 5004
    ],
    runners,
  });
  const gh = failing(base, (m, p) => p.includes("status=completed"), ghError("TooManyPages"));
  const e = ec2({ instances: [deployInstance("i-1", 5001)] });
  const { summary, logs } = await drive({ gh, ec2: e, now: new Date("2026-10-21T18:13:00Z") });

  assert.deepEqual(byEvent(logs, "deploy_blind"), [{ event: "deploy_blind", scope: "posthoc", error: "TooManyPages" }]);
  assert.deepEqual(
    byEvent(logs, "deploy_tripwire").map((r) => r.reason).sort(),
    ["not_allowlisted", "served_refused"],
    "the refusal and the served_refused from the in-progress run are both logged",
  );
  assert.deepEqual(byEvent(logs, "deploy_hold"), [{ event: "deploy_hold", refused: 1, admitted_waiting: 0 }]);
  assert.deepEqual(deletes(base.calls), ["/orgs/Conductia/actions/runners/5001"], "the idle minted runner is purged");
  assert.deepEqual(e.terminated, ["i-1"]);
  assert.equal(summary.served_refused, 1);
  assert.equal(summary.blind, "posthoc");
  assert.equal(byEvent(logs, "deploy_tick").length, 1, "the tick ends with its summary");
});

test("audit V1: a completed run whose jobs read fails blinds only the post-hoc check; an admitted job still launches", async () => {
  const done = { ...prRun, id: 4242 };
  const base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }, { run: done, jobs: prJobs }] });
  const gh = failing(base, (m, p) => p.includes("/runs/4242/jobs"), ghError("GitHubError", 502));
  const e = ec2();
  const { summary, logs } = await drive({ gh, ec2: e, now: new Date("2026-10-21T18:21:00Z") });
  assert.deepEqual(byEvent(logs, "deploy_blind"), [{ event: "deploy_blind", scope: "posthoc", error: "GitHubError:502" }]);
  assert.equal(byEvent(logs, "deploy_hold").length, 0, "the queued view is whole: no hold");
  assert.equal(summary.launched, 1);
});

test("audit V1: an active-run list that fails holds, purges and mints nothing; admission is never decided on part of the queue", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  const base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners });
  const gh = failing(base, (m, p) => p.includes("status=queued"), ghError("TooManyPages"));
  const e = ec2({ instances: [deployInstance("i-1", 5001)] });
  const { summary, logs } = await drive({ gh, ec2: e });
  assert.deepEqual(byEvent(logs, "deploy_blind").map((r) => r.scope), ["queued", "posthoc"]);
  assert.deepEqual(byEvent(logs, "deploy_hold"), [{ event: "deploy_hold", refused: 0, admitted_waiting: 0 }]);
  assert.equal(minted(base.calls).length, 0);
  assert.deepEqual(deletes(base.calls), ["/orgs/Conductia/actions/runners/5001"]);
  assert.equal(summary.launched, 0);
  assert.equal(summary.blind, "posthoc,queued");
});

test("audit V1: a queued run whose compare read fails is neither admitted nor refused: the tick holds", async () => {
  const base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  const gh = failing(base, (m, p, label) => label === "compare", ghError("TimeoutError"));
  const { summary, logs } = await drive({ gh, ec2: ec2() });
  assert.deepEqual(byEvent(logs, "deploy_blind"), [{ event: "deploy_blind", scope: "queued", error: "TimeoutError" }]);
  assert.equal(byEvent(logs, "deploy_tripwire").length, 0, "not reported as a refusal");
  assert.equal(minted(base.calls).length, 0);
  assert.equal(summary.queued, 0);
  assert.equal(summary.refused, 0);
});

// Audit V8: the tick's time budget ---------------------------------------------------------------

// A clock that moves `step` ms on every GitHub call.
const slow = (base, step) => {
  let t = 0;
  return {
    clock: () => t,
    gh: async (...args) => {
      t += step;
      return base.gh(...args);
    },
  };
};

test("audit V8: reads past the budget fail as OutOfTime; the tick holds, mints nothing and still ends with its record", async () => {
  const base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  const { gh, clock } = slow(base, 9_000); // the third call starts past 25 s
  const e = ec2();
  const { summary, logs } = await drive({ gh, ec2: e, clock });
  assert.deepEqual(byEvent(logs, "deploy_blind").map((r) => [r.scope, r.error]), [["queued", "OutOfTime"], ["posthoc", "OutOfTime"]]);
  assert.equal(minted(base.calls).length, 0);
  assert.equal(e.runs.length, 0);
  assert.equal(summary.github_calls, base.calls.length, "only calls that started are counted");
  assert.equal(byEvent(logs, "deploy_tick").length, 1);
});

test("audit V8: no mint starts past its budget, so no runner is left without a VM", async () => {
  const base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  const { gh, clock } = slow(base, 3_120); // the ninth read starts at 24.96 s, inside the read budget, and ends past the mint budget
  const { summary } = await drive({ gh, ec2: ec2(), clock });
  assert.equal(minted(base.calls).length, 0);
  assert.equal(summary.admitted, 1);
  assert.equal(summary.launched, 0);
  assert.equal(summary.error, "OutOfTime");
});

test("fix check N1: a held tick past the read budget still purges: the idle runner is deleted and its VM terminated", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  const base = github({ runs: [{ run: scratchRun, jobs: [scratchJob] }], runners });
  let t = 0;
  const gh = async (...args) => {
    const out = await base.gh(...args);
    if (args[3] === "jobs" && t === 0) t = 26_000; // every read is done, and the tick is past the read budget
    return out;
  };
  const e = ec2({ instances: [deployInstance("i-1", 5001)] });
  const { summary, logs } = await drive({ gh, ec2: e, clock: () => t });
  assert.deepEqual(byEvent(logs, "deploy_hold"), [{ event: "deploy_hold", refused: 1, admitted_waiting: 0 }]);
  assert.deepEqual(deletes(base.calls), ["/orgs/Conductia/actions/runners/5001"]);
  assert.deepEqual(e.terminated, ["i-1"], "the re-read before the terminate runs on the purge budget too");
  assert.equal(summary.deregistered, 1);
});

test("fix check N1: an unheld tick past the read budget retires nothing; a held one stops purging at 36 s", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  // Unheld: a stale idle VM, an admitted job, reads done past 25 s.
  let base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners });
  let t = 0;
  const after = (at) => async (...args) => {
    const out = await base.gh(...args);
    if (args[3] === "compare") t = at;
    if (args[3] === "jobs" && args[1].includes("/900/")) t = at;
    return out;
  };
  let out = await drive({ gh: after(26_000), ec2: ec2({ instances: [aged("i-1", 5001, 9)] }), clock: () => t });
  assert.deepEqual(deletes(base.calls), [], "only a hold's purge outlives the read budget");
  // Held, past the purge budget: nothing starts.
  base = github({ runs: [{ run: scratchRun, jobs: [scratchJob] }], runners });
  t = 0;
  out = await drive({ gh: after(37_000), ec2: ec2({ instances: [deployInstance("i-1", 5001)] }), clock: () => t });
  assert.deepEqual(deletes(base.calls), []);
  assert.equal(out.summary.error, "OutOfTime");
});

test("audit V8: a failed launch's cleanup DELETE runs even past the read budget", async () => {
  const base = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }] });
  let t = 0;
  const gh = async (...args) => {
    if (args[3] === "generate-jitconfig") t = 30_000; // the mint itself takes the tick past both budgets
    return base.gh(...args);
  };
  const { summary } = await drive({ gh, ec2: ec2({ runError: "InsufficientInstanceCapacity" }), clock: () => t });
  assert.deepEqual(deletes(base.calls), ["/orgs/Conductia/actions/runners/5003"]);
  assert.equal(summary.reaped, 1);
});

// Phase 4: unknown runners, the reaper, delete before terminate (design R23, R26) -------------

const NOW = new Date("2026-10-22T12:00:00Z");
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000);
const aged = (id, runnerId, minutes, state = "running") => deployInstance(id, runnerId, state, minutesAgo(minutes));
const terminations = (e) => e.terminated;
// An in-progress run whose job runs on `runnerId`, as GitHub would list it after the runner took the job.
const takenBy = (runnerId) => ({
  run: { ...promoteRun, id: 777, status: "in_progress" },
  jobs: [{ ...queuedMigrate, id: 778, run_id: 777, status: "in_progress", runner_id: runnerId, runner_group_id: 7 }],
});

test("unknown: a runner tagged on no trusted VM is reported with exactly four keys, and never deleted", async () => {
  const recorded = fixture("runners-recorded-fleet.json");
  const { gh, calls } = github({ runners: recorded });
  const { summary, logs } = await drive({ gh, ec2: ec2() });
  const unknown = byEvent(logs, "deploy_unknown_runner");
  assert.equal(unknown.length, 6);
  for (const r of unknown) assert.deepEqual(Object.keys(r), ["event", "runner_id", "status", "busy"]);
  assert.deepEqual(unknown[0], { event: "deploy_unknown_runner", runner_id: 23, status: "online", busy: true });
  assert.equal(summary.unknown, 6);
  assert.deepEqual(deletes(calls), [], "alert only (O18)");
});

test("reap: a runner whose VM is gone is deleted; nothing is terminated", async () => {
  const runners = { runners: [{ id: 5001, status: "offline", busy: false }, { id: 5002, status: "offline", busy: false }] };
  const { gh, calls } = github({ runners });
  const e = ec2({ instances: [aged("i-1", 5001, 30, "terminated"), aged("i-2", 5002, 30, "shutting-down")] });
  const { summary, logs } = await drive({ gh, ec2: e });
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5001", "/orgs/Conductia/actions/runners/5002"]);
  assert.equal(summary.reaped, 2);
  assert.deepEqual(terminations(e), []);
  assert.equal(byEvent(logs, "deploy_unknown_runner").length, 0);
});

test("stale: an online idle runner on a VM 8 minutes old is deleted, then its VM terminated; at 6 minutes nothing happens", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  let { gh, calls } = github({ runners });
  let e = ec2({ instances: [aged("i-1", 5001, 8)] });
  let { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5001"]);
  const delAt = calls.findIndex((c) => c.method === "DELETE");
  assert.ok(calls.slice(delAt + 1).some((c) => c.label === "jobs" || c.label === "runs"), "the jobs are read again after the delete");
  assert.deepEqual(terminations(e), ["i-1"]);
  assert.equal(summary.deregistered, 1);
  assert.equal(summary.terminated, 1);

  ({ gh, calls } = github({ runners }));
  e = ec2({ instances: [aged("i-1", 5001, 6)] });
  ({ summary } = await drive({ gh, ec2: e }));
  assert.deepEqual([deletes(calls), terminations(e)], [[], []]);
});

test("stale: a busy runner's VM is left alone, however long it has run, until the hard cap", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: true }] };
  const { gh, calls } = github({ runners });
  const e = ec2({ instances: [aged("i-1", 5001, 100)] });
  await drive({ gh, ec2: e });
  assert.deepEqual([deletes(calls), terminations(e)], [[], []]);
});

test("hard cap: a VM older than 130 minutes is terminated without the delete, busy or not", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: true }, { id: 5002, status: "online", busy: false }] };
  const { gh, calls } = github({ runners });
  const e = ec2({ instances: [aged("i-1", 5001, 131), aged("i-2", 5002, 131, "pending")] });
  const { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(deletes(calls), [], "no delete first");
  assert.deepEqual(terminations(e), ["i-1", "i-2"]);
  assert.equal(summary.terminated, 2);
});

test("over cap: the newest idle VMs are retired, delete first, until the cap holds", async () => {
  const runners = {
    runners: [5001, 5002, 5003, 5004].map((id) => ({ id, status: "online", busy: id === 5004 })),
  };
  const instances = [aged("i-1", 5001, 5), aged("i-2", 5002, 4), aged("i-3", 5003, 3), aged("i-4", 5004, 2)];
  const { gh, calls } = github({ runners });
  const e = ec2({ instances });
  const { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5003"], "i-4 is newest but busy; i-3 is the newest idle");
  assert.deepEqual(terminations(e), ["i-3"]);
  assert.equal(summary.live, 4);
  assert.equal(summary.launched, 0);
});

test("the reap race, round 2 #1: idle when listed, busy at the reap. The DELETE answers 422 and nothing is terminated", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  const state = { runs: [] };
  const { gh, calls } = github({
    runs: state.runs,
    runners,
    // Between the list and the reap, GitHub handed the runner a production migration.
    deleteStatus: (id) => (state.runs.push(takenBy(id)), 422),
  });
  const e = ec2({ instances: [aged("i-1", 5001, 9)] });
  const { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5001"]);
  assert.deepEqual(terminations(e), []);
  assert.equal(summary.deregistered, 0);
  assert.equal(summary.terminated, 0);
  assert.equal(summary.error, "GitHubError:422");
});

test("the reap race, round 2 #1: the DELETE succeeds but an in-progress job carries the runner's id; nothing is terminated", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }, { id: 5002, status: "online", busy: false }] };
  const state = { runs: [] };
  const { gh } = github({
    runs: state.runs,
    runners,
    deleteStatus: (id) => {
      if (id === 5001) state.runs.push(takenBy(5001));
      return 204;
    },
  });
  const e = ec2({ instances: [aged("i-1", 5001, 9), aged("i-2", 5002, 9)] });
  const { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(terminations(e), ["i-2"], "only the VM whose runner no unfinished job carries");
  assert.equal(summary.deregistered, 2);
  assert.equal(summary.terminated, 1);
});

test("a failed re-read of the jobs terminates nothing", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  const base = github({ runners });
  let deleted = false;
  const gh = async (method, path, body, label) => {
    if (method === "DELETE") deleted = true;
    if (deleted && label === "runs") {
      const e = new Error("GitHub runs -> 502");
      e.name = "GitHubError";
      e.status = 502;
      throw e;
    }
    return base.gh(method, path, body, label);
  };
  const e = ec2({ instances: [aged("i-1", 5001, 9)] });
  const { summary } = await drive({ gh, ec2: e });
  assert.deepEqual(terminations(e), []);
  assert.equal(summary.deregistered, 1);
  assert.equal(summary.error, "GitHubError:502");
});

test("trust, round 2 #9: a VM with only Component, or another template id, is never classified, counted or terminated", async () => {
  const forged = [
    { InstanceId: "i-7", State: { Name: "running" }, LaunchTime: minutesAgo(200), Tags: [{ Key: "Component", Value: "deploy-runner" }] },
    {
      InstanceId: "i-8",
      State: { Name: "running" },
      LaunchTime: minutesAgo(200),
      Tags: [
        { Key: "Component", Value: "deploy-runner" },
        { Key: "RunnerId", Value: "5001" },
        { Key: "aws:ec2launchtemplate:id", Value: "lt-other" },
      ],
    },
    {
      InstanceId: "i-9",
      State: { Name: "terminated" },
      LaunchTime: minutesAgo(30),
      Tags: [
        { Key: "Component", Value: "deploy-runner" },
        { Key: "RunnerId", Value: "5002" },
      ],
    },
  ];
  const runners = { runners: [{ id: 5001, status: "online", busy: false }, { id: 5002, status: "offline", busy: false }] };
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners });
  const e = ec2({ instances: forged });
  const { summary, logs } = await drive({ gh, ec2: e });
  assert.deepEqual(terminations(e), [], "neither hard-capped nor retired");
  assert.deepEqual(deletes(calls), [], "neither reaped nor retired");
  assert.equal(summary.live, 0, "not counted toward the cap");
  assert.equal(summary.idle, 0);
  assert.equal(summary.launched, 1, "so the admitted job still gets its VM");
  assert.deepEqual(byEvent(logs, "deploy_unknown_runner").map((r) => r.runner_id), [5001, 5002], "their runners are ones the launcher never minted");
});

test("audit V6: a VM whose runner never came online is not capacity: the admitted job gets a new VM, and the stuck one is retired delete first", async () => {
  const runners = { runners: [{ id: 5001, status: "offline", busy: false }] };
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners });
  const e = ec2({ instances: [aged("i-1", 5001, 12)] });
  const { summary } = await drive({ gh, ec2: e });
  assert.equal(summary.idle, 0);
  assert.deepEqual(deletes(calls), ["/orgs/Conductia/actions/runners/5001"]);
  assert.deepEqual(terminations(e), ["i-1"]);
  assert.equal(summary.launched, 1);
});

test("a refused terminate records its error name and the tick goes on", async () => {
  const runners = { runners: [{ id: 5001, status: "online", busy: false }] };
  const { gh, calls } = github({ runs: [{ run: promoteRun, jobs: [queuedMigrate] }], runners });
  const e = ec2({ instances: [aged("i-1", 5001, 9)], terminateError: "UnauthorizedOperation" });
  const { summary } = await drive({ gh, ec2: e });
  assert.equal(summary.terminated, 0);
  assert.equal(summary.error, "UnauthorizedOperation");
  assert.equal(minted(calls).length, 0, "the stale runner still counted as idle capacity this tick");
});
