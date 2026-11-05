// Launcher for the deploy runner group (infra/deploy-runner, ADR-0028, #639).
//
// Every minute: authenticate as the launcher GitHub App with a token narrowed to
// this repository and to what group mode needs; check the configured runner
// group is exactly what it must be; find the queued jobs whose labels a deploy
// runner would satisfy; admit each run against the allowlist and check its commit
// is on its branch. If any such job is refused, log a tripwire for it and a hold
// record, mint nothing (fail closed) and deregister every idle minted runner.
// Otherwise mint one JIT runner in the group per admitted job not already
// covered, and launch a fresh VM for it from the pinned launch template. Every
// tick also checks which jobs deploy runners took, and logs a served_refused
// tripwire for any whose run it would refuse (design R17, R25). A run or job
// read that fails makes its check blind (deploy_blind) instead of ending the
// tick, and a blind queued check holds like a refusal (audit V1).
//
// Bookkeeping without a database (design R23, R26): each deploy VM carries its
// runner's id as a tag. Before deciding anything the tick lists the group's
// runners. It reports any runner it never minted (deploy_unknown_runner),
// deletes runners whose VM is gone, and retires idle and over-cap VMs by
// deleting the runner first and terminating only once the delete succeeded and
// no in-progress job carries the runner (round 2 #1). A VM past its hard cap is
// terminated outright. A runner minted for a launch that failed is deleted at
// once.
//
// I/O only: every decision is in deploy-plan.mjs. Logs are objects passed as one
// argument (JSON log format keeps them objects, so alarms.tf's metric filters
// match $.message.event) and hold ids, counts, codes and error names only: never
// the token, the key, a JIT config, a branch or a runner name.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  appJwt,
  BLIND_SCOPES,
  blindRecord,
  classifyRunners,
  completedSince,
  config,
  decide,
  groupOk,
  holdRecord,
  jitRequest,
  launchParams,
  admit,
  MINT_BUDGET_MS,
  outOfTime,
  PURGE_BUDGET_MS,
  READ_BUDGET_MS,
  mintedRunnerIds,
  postHocRuns,
  provenance,
  retireList,
  selfcheck,
  servedByDeploy,
  servedRefused,
  staleInstances,
  targetsDeploy,
  tokenRequest,
  trusted,
  tripwire,
  UNREADABLE,
  unknownRunner,
  userData,
} from "./deploy-plan.mjs";

const PER_PAGE = 100;
const MAX_PAGES = 10;
const SHA = /^[0-9a-f]{40}$/;

// Reads every page of a list endpoint. Hitting the page limit throws rather than
// deciding on a partial list: a refused job on an unread page must not be missed.
async function all(gh, path, key, label) {
  const out = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await gh(
      "GET",
      `${path}${sep}per_page=${PER_PAGE}&page=${page}`,
      undefined,
      label,
    );
    const items = body?.[key] ?? [];
    out.push(...items);
    if (items.length < PER_PAGE) return out;
  }
  const e = new Error(`more than ${MAX_PAGES} pages of ${label}`);
  e.name = "TooManyPages";
  throw e;
}

async function groupFacts(gh, cfg) {
  const groups = await all(
    gh,
    `/orgs/${cfg.org}/actions/runner-groups`,
    "runner_groups",
    "runner-groups",
  );
  const named = groups.filter((g) => g?.name === cfg.groupName);
  // Only a single selected group has a repository list worth reading; groupOk
  // refuses every other shape anyway.
  const repositories =
    cfg.groupName && named.length === 1 && named[0].visibility === "selected"
      ? await all(
          gh,
          `/orgs/${cfg.org}/actions/runner-groups/${named[0].id}/repositories`,
          "repositories",
          "runner-group repositories",
        )
      : null;
  return { groups, repositories };
}

// Every { run, job } this tick decides on, from one list call per status (round
// 2 #3). Queued jobs sit in queued runs and in in_progress runs (a promotion
// whose plan job is done and whose migrate job waits for a runner). The
// post-hoc check reads the jobs of those runs too, and of completed runs
// created in the last 130 minutes and updated in the last 5, so a refused job
// that started and ended between two ticks is still seen. filter=all includes
// every attempt of a re-run.
const listRuns = (gh, cfg, query) =>
  all(
    gh,
    `/repos/${cfg.repository}/actions/runs?status=${query}`,
    "workflow_runs",
    "runs",
  );
const jobsOf = (gh, cfg, run) =>
  all(
    gh,
    `/repos/${cfg.repository}/actions/runs/${run.id}/jobs?filter=all`,
    "jobs",
    "jobs",
  );

// Every queued and in-progress run, once each.
async function activeRuns(gh, cfg) {
  const active = new Map();
  for (const status of ["queued", "in_progress"])
    for (const run of await listRuns(gh, cfg, status)) active.set(run.id, run);
  return active;
}

// Audit V1: no read here throws. A failed read marks its scope blind (`blind`
// is called with the scope and the error) and the tick goes on with what it
// read. An active run feeds both checks, so its failure blinds both; a
// completed run feeds only the post-hoc check. A busy hour can hold more than
// ten pages of completed runs (every issue comment starts a run), which must
// not stop the queued check, the hold or the purge.
async function runsAndJobs(gh, cfg, now, blind) {
  let active = new Map();
  try {
    active = await activeRuns(gh, cfg);
  } catch (e) {
    blind("queued", e);
    blind("posthoc", e);
  }
  let completed = [];
  try {
    completed = (
      await listRuns(
        gh,
        cfg,
        `completed&created=${encodeURIComponent(completedSince(now))}`,
      )
    ).filter((r) => !active.has(r.id));
  } catch (e) {
    blind("posthoc", e);
  }

  const out = [];
  const read = async (run, scopes) => {
    try {
      for (const job of await jobsOf(gh, cfg, run)) out.push({ run, job });
    } catch (e) {
      for (const scope of scopes) blind(scope, e);
    }
  };
  for (const run of active.values()) await read(run, ["queued", "posthoc"]);
  for (const run of postHocRuns(completed, now)) await read(run, ["posthoc"]);
  return out;
}

// Round 2 #1, step 2: read again, after the deletes, which runners carry a job
// that has not completed. A runner GitHub let go of while it ran a job keeps
// its VM.
async function runnersOnJobs(gh, cfg) {
  const carried = new Set();
  for (const run of (await activeRuns(gh, cfg)).values())
    for (const job of await jobsOf(gh, cfg, run))
      if (job.status !== "completed" && job.runner_id != null)
        carried.add(String(job.runner_id));
  return carried;
}

// R8 then R16 for one run: the allowlist, then the run's commit against the tip
// of refs/heads/<branch>, so a same-named tag cannot stand in for the branch.
async function verdict(gh, cfg, run, now) {
  const reason = admit(run, cfg.allowlist, now, cfg.repository);
  if (reason !== "ok") return reason;
  if (!SHA.test(run.head_sha ?? "")) return "provenance";
  const branch = run.head_branch.split("/").map(encodeURIComponent).join("/");
  const ref = await gh(
    "GET",
    `/repos/${cfg.repository}/git/ref/heads/${branch}`,
    undefined,
    "git/ref",
  );
  const tip = ref?.object?.sha;
  if (!SHA.test(tip ?? "")) return "provenance";
  const cmp = await gh(
    "GET",
    `/repos/${cfg.repository}/compare/${run.head_sha}...${tip}`,
    undefined,
    "compare",
  );
  return provenance(cmp);
}

async function runSelfcheck(ec2, cfg) {
  try {
    await ec2.run(
      launchParams({
        templateId: cfg.templateId,
        version: cfg.templateVersion,
        runnerId: "0",
        dryRun: true,
      }),
    );
    return selfcheck("NoError"); // a DryRun never succeeds; treat as an error
  } catch (e) {
    return selfcheck(e?.name);
  }
}

const errorName = (e) =>
  e?.status ? `${e.name}:${e.status}` : (e?.name ?? "Error");

// One tick. Everything it touches comes in through `deps`, so the tests drive it
// with a stubbed GitHub and EC2:
//   cfg        config(process.env)
//   connect()  resolves to gh(method, path, body, label), authenticated
//   ec2        { describe(): instances, run(params), terminate(instanceId) }
//   now, rand  the time, and a 12-hex-digit runner-name suffix
//   script     the rendered boot script (user-data.sh)
//   log        one record per call
//   doSelfcheck  true on the first tick after a cold start
//   clock      milliseconds, for the tick's own time budget (Date.now)
export async function tick({
  cfg,
  connect,
  ec2,
  now,
  rand,
  script,
  log,
  doSelfcheck,
  clock = Date.now,
}) {
  const started = clock();
  const elapsed = () => clock() - started;
  const summary = {
    event: "deploy_tick",
    group: "misconfigured",
    queued: 0,
    admitted: 0,
    refused: 0,
    served_refused: 0,
    unknown: 0,
    reaped: 0,
    deregistered: 0,
    terminated: 0,
    launched: 0,
    idle: 0,
    live: 0,
    github_calls: 0,
  };
  if (doSelfcheck) log(await runSelfcheck(ec2, cfg));

  // Audit V8: every GitHub call is counted (deploy_tick's github_calls, O8),
  // and none starts once its budget has gone: READ_BUDGET_MS for reads and
  // deletes, PURGE_BUDGET_MS for a held tick's purge, none for a launch and its
  // cleanup (gated by MINT_BUDGET_MS instead). A read past it fails as
  // OutOfTime, which blinds its check (and holds) like any failed read, so the
  // tick ends well inside the function's 50 s timeout instead of being killed
  // in the middle of a mint.
  const raw = await connect();
  const gh = (method, path, body, label, budget = READ_BUDGET_MS) => {
    if (elapsed() > budget) return Promise.reject(outOfTime());
    summary.github_calls += 1;
    return raw(method, path, body, label);
  };
  const group = groupOk(await groupFacts(gh, cfg), {
    name: cfg.groupName,
    repository: cfg.repository,
  });
  if (!group.ok) {
    // R0: no silent fallback, and loud: the tripwire alarm fires.
    log(tripwire(null, null, "group_misconfigured"));
    log(summary);
    return summary;
  }
  summary.group = "ok";

  // R23, round 2 #9: only trusted instances take part, in any state.
  const instances = (await ec2.describe()).filter((i) =>
    trusted(i, cfg.templateId),
  );
  // Listed before anything is decided: R26 needs each runner's busy flag.
  const runners = await all(
    gh,
    `/orgs/${cfg.org}/actions/runner-groups/${group.id}/runners`,
    "runners",
    "group runners",
  );
  const classes = classifyRunners(runners, instances, cfg.templateId, now);
  const idle = classes.idle.length;
  const live = classes.live;
  const minted = mintedRunnerIds(instances, cfg.templateId);
  // R23: a runner the launcher never minted. Reported, never deleted (O18).
  for (const r of classes.unknown) log(unknownRunner(r));
  summary.unknown = classes.unknown.length;

  // Audit V1: the first failed read of each scope, by error name. Each blind
  // scope logs one record the tripwire alarm fires on.
  const blinded = new Map();
  const blind = (scope, e) => {
    if (!blinded.has(scope)) blinded.set(scope, errorName(e));
  };

  // One verdict per run, shared by the queued check and the post-hoc check. A
  // refused run's branch is never resolved: admit refuses before provenance. A
  // run whose ref or compare read fails is UNREADABLE, never admitted.
  const byRun = new Map();
  const verdictOf = async (run, scope) => {
    if (!byRun.has(run.id)) {
      try {
        byRun.set(run.id, { reason: await verdict(gh, cfg, run, now) });
      } catch (e) {
        byRun.set(run.id, { reason: UNREADABLE, error: e });
      }
    }
    const v = byRun.get(run.id);
    if (v.reason === UNREADABLE) blind(scope, v.error);
    return v.reason;
  };

  const entries = await runsAndJobs(gh, cfg, now, blind);
  const verdicts = [];
  for (const { run, job } of entries) {
    if (job.status !== "queued" || !targetsDeploy(job, cfg.runnerLabels))
      continue;
    const reason = await verdictOf(run, "queued");
    if (reason === UNREADABLE) continue; // held through the blind scope
    verdicts.push(reason);
    if (reason !== "ok") log(tripwire(run, job, reason)); // R17, once per tick
  }

  // R25 post-hoc: a deploy runner that took a job of a refused run. A run whose
  // verdict could not be read is reported as a blind post-hoc check, not as
  // served_refused.
  const served = [];
  for (const entry of entries)
    if (
      servedByDeploy(entry.job, group.id, minted) &&
      (await verdictOf(entry.run, "posthoc")) !== UNREADABLE
    )
      served.push(entry);
  const late = servedRefused(
    served,
    group.id,
    minted,
    (run) => byRun.get(run.id)?.reason,
  );
  for (const record of late) log(record);

  for (const scope of BLIND_SCOPES)
    if (blinded.has(scope)) log(blindRecord(scope, blinded.get(scope)));

  const d = decide(
    verdicts,
    idle,
    live,
    cfg.cap,
    classes.idle.map((r) => r.id),
    blinded.has("queued"),
  );
  Object.assign(summary, {
    queued: verdicts.length,
    admitted: d.admitted,
    refused: d.refused,
    served_refused: late.length,
    idle,
    live,
  });
  if (blinded.size > 0) summary.blind = [...blinded.keys()].sort().join(",");

  // Each GitHub or EC2 write records its error name and lets the tick go on.
  const attempt = async (fn) => {
    try {
      await fn();
      return true;
    } catch (e) {
      summary.error = errorName(e);
      return false;
    }
  };
  const deleteRunner = (id, budget = READ_BUDGET_MS) =>
    attempt(() =>
      gh(
        "DELETE",
        `/orgs/${cfg.org}/actions/runners/${id}`,
        undefined,
        "delete runner",
        budget,
      ),
    );
  const terminate = (instanceId) => {
    // The launcher's own check, whatever IAM allows (R26): trusted VMs only.
    const vm = instances.find((i) => i.InstanceId === instanceId);
    if (!trusted(vm, cfg.templateId)) return false;
    return attempt(() => ec2.terminate(instanceId));
  };

  // R25: held, by a refusal or a blind queued check. Say so; the purge below
  // deregisters every idle minted runner so none is left for a refused job
  // (round 2 #4).
  if (d.held) log(holdRecord(d.refused, d.admitted));

  // R23: a runner whose VM is gone.
  for (const r of classes.reap)
    if (await deleteRunner(r.id)) summary.reaped += 1;

  // R26, round 2 #1: delete first, then terminate. The busy flag is from the
  // list, and GitHub can hand that runner a job (a production migration) in
  // between. A runner that took one answers non-2xx and keeps its VM; a deleted
  // runner takes no new job. Then read the jobs again, and terminate only VMs
  // whose runner no unfinished job carries.
  const stale = staleInstances(
    instances,
    runners,
    now,
    cfg.cap,
    cfg.templateId,
  );
  // While held, the purge outlives the read budget (fix check N1): at most
  // `cap` deletes and one jobs re-read, and nothing is minted this tick.
  const retireBudget = d.held ? PURGE_BUDGET_MS : READ_BUDGET_MS;
  const deleted = [];
  for (const c of retireList(stale, d.deregister, instances, cfg.templateId))
    if (await deleteRunner(c.runnerId, retireBudget)) {
      summary.deregistered += 1;
      deleted.push(c);
    }
  if (deleted.length > 0) {
    let carried = null;
    await attempt(async () => {
      carried = await runnersOnJobs(
        (method, path, body, label) =>
          gh(method, path, body, label, retireBudget),
        cfg,
      );
    });
    // A failed re-read terminates nothing: the VMs end on their own shutdown.
    if (carried)
      for (const c of deleted)
        if (!carried.has(String(c.runnerId)) && (await terminate(c.instanceId)))
          summary.terminated += 1;
  }

  // R26: past every job timeout and the VM's own shutdown. No delete first.
  for (const c of stale.hardCap)
    if (await terminate(c.instanceId)) summary.terminated += 1;

  for (let i = 0; i < d.launch; i += 1) {
    // A mint starts only with time left for it, its launch and, if the launch
    // fails, its cleanup: a tick killed between generate-jitconfig and
    // RunInstances would leave a runner with no VM (audit V8).
    if (elapsed() > MINT_BUDGET_MS) {
      summary.error = "OutOfTime";
      break;
    }
    const jit = await gh(
      "POST",
      `/orgs/${cfg.org}/actions/runners/generate-jitconfig`,
      jitRequest(group.id, rand()),
      "generate-jitconfig",
      Infinity,
    );
    const launched = await attempt(() =>
      ec2.run(
        launchParams({
          templateId: cfg.templateId,
          version: cfg.templateVersion,
          userData: userData(script, jit.encoded_jit_config),
          runnerId: jit.runner.id,
        }),
      ),
    );
    if (launched) {
      summary.launched += 1;
      continue;
    }
    // R23: the runner just minted has no VM. Delete it now, keeping the launch
    // error's name, and stop launching this tick. If the delete fails too, the
    // next tick reports it as unknown.
    const launchError = summary.error;
    if (await deleteRunner(jit.runner.id, Infinity)) summary.reaped += 1;
    else summary.error = `${launchError},${summary.error}`;
    break;
  }
  log(summary);
  return summary;
}

// Lambda wiring: real clients, created lazily so the tests import tick() without
// the AWS SDK. The App key is read on every tick and the token is never cached.
let coldStart = true;
let script;

async function request(bearer, method, path, body, label) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    // The label is a fixed route name: the message never carries a path.
    const e = new Error(`GitHub ${label} -> ${res.status}`);
    e.name = "GitHubError";
    e.status = res.status;
    throw e;
  }
  // DELETE answers 204 with no body.
  return res.status === 204 ? null : res.json();
}

export async function handler() {
  const doSelfcheck = coldStart;
  coldStart = false;
  try {
    const cfg = config(process.env);
    const { SSMClient, GetParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const {
      EC2Client,
      DescribeInstancesCommand,
      RunInstancesCommand,
      TerminateInstancesCommand,
    } = await import("@aws-sdk/client-ec2");
    const ssm = new SSMClient({});
    // Bounded like the GitHub calls (fix check N3): a launch that starts near
    // MINT_BUDGET_MS must not outlast the 50 s timeout and leave its runner
    // with no VM. One attempt: a failed EC2 call is retried by the next tick.
    // requestTimeout is the socket's idle limit, so a call that keeps
    // receiving data could still run longer; EC2 answers in well under that.
    const client = new EC2Client({
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 },
    });
    script ??= readFileSync(new URL("./user-data.sh", import.meta.url), "utf8");

    const ec2 = {
      async describe() {
        const out = [];
        let NextToken;
        do {
          const page = await client.send(
            new DescribeInstancesCommand({
              Filters: [
                { Name: "tag:Component", Values: ["deploy-runner"] },
                { Name: "tag-key", Values: ["RunnerId"] },
                {
                  Name: "tag:aws:ec2launchtemplate:id",
                  Values: [cfg.templateId],
                },
              ],
              NextToken,
            }),
          );
          out.push(...(page.Reservations ?? []).flatMap((r) => r.Instances));
          NextToken = page.NextToken;
        } while (NextToken);
        return out;
      },
      run: (params) => client.send(new RunInstancesCommand(params)),
      // One VM per call, so one refusal never blocks another VM's terminate.
      terminate: (id) =>
        client.send(new TerminateInstancesCommand({ InstanceIds: [id] })),
    };

    const connect = async () => {
      const key = (
        await ssm.send(
          new GetParameterCommand({
            Name: cfg.appKeyParam,
            WithDecryption: true,
          }),
        )
      ).Parameter.Value;
      const { token } = await request(
        appJwt(cfg.appId, key, Date.now()),
        "POST",
        `/app/installations/${cfg.installationId}/access_tokens`,
        tokenRequest(cfg.repository),
        "access_tokens",
      );
      return (method, path, body, label) =>
        request(token, method, path, body, label);
    };

    return await tick({
      cfg,
      connect,
      ec2,
      now: new Date(),
      rand: () => randomBytes(6).toString("hex"),
      script,
      log: (record) => console.log(record),
      doSelfcheck,
    });
  } catch (e) {
    // Fail the invocation (the Errors alarm counts it) without the message,
    // which could echo a request.
    console.log({ event: "deploy_tick", error: errorName(e) });
    throw new Error(`deploy tick failed: ${errorName(e)}`);
  }
}
