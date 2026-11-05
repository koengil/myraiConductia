// Wake function for the CI runner fleet (infra/ci-runner, ADR-0027).
//
// Every minute: keep a fresh runner registration token in SSM (the hosts read
// it; they never see the PAT), then count GitHub Actions jobs that are queued for a conductia-ci-*
// label, compare with runner capacity that is up and idle, and start stopped
// instances to cover the difference. Heavy jobs need a heavy-capable instance;
// light jobs take a light instance first, then a heavy-capable one. Burst
// classes (BURST_CLASSES) are heavy-capable but start only after the base heavy
// instances (plan.mjs).
//
// Capacity is an approximation: an instance counts as available when EC2 says
// pending/running and its runner is not reported busy by GitHub (a booting
// instance whose runner is not online yet counts as available). Two jobs may
// race for one runner; the next tick starts another instance. Logs carry counts
// only, never the PAT.
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
} from "@aws-sdk/client-ec2";
import { classify, plan, toStart } from "./plan.mjs";

const {
  REPO,
  SSM_PARAM,
  TOKEN_PARAM,
  TAG_KEY = "Component",
  TAG_VALUE = "ci-runner",
} = process.env;
const LABEL_PREFIX = process.env.LABEL_PREFIX ?? "conductia-ci-";
const HEAVY_LABEL = process.env.HEAVY_LABEL ?? "conductia-ci-heavy";
const HEAVY_CLASSES = new Set(
  (process.env.HEAVY_CLASSES ?? "heavy").split(",").filter(Boolean),
);
const BURST_CLASSES = new Set(
  (process.env.BURST_CLASSES ?? "").split(",").filter(Boolean),
);
const MAX_RUNS = 50;
const TOKEN_MAX_AGE_MS = 45 * 60 * 1000; // GitHub registration tokens live 1 h

const ssm = new SSMClient({});
const ec2 = new EC2Client({});
let pat; // cached across warm invocations

async function getPat() {
  if (!pat) {
    const out = await ssm.send(
      new GetParameterCommand({ Name: SSM_PARAM, WithDecryption: true }),
    );
    pat = out.Parameter.Value.trim();
  }
  return pat;
}

async function github(path, method = "GET") {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getPat()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401) pat = undefined; // rotated PAT: re-read next call
  if (!res.ok) throw new Error(`GitHub ${path.split("?")[0]} -> ${res.status}`);
  return res.json();
}

// Writes a new registration token when the parameter is missing or older than
// 45 minutes. The first write creates it with tags; later writes overwrite
// (SSM refuses Tags together with Overwrite).
async function refreshRegistrationToken() {
  let exists = false;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: TOKEN_PARAM }));
    exists = true;
    if (
      Date.now() - out.Parameter.LastModifiedDate.getTime() <
      TOKEN_MAX_AGE_MS
    )
      return "fresh";
  } catch (e) {
    if (e.name !== "ParameterNotFound") throw e;
  }
  const { token } = await github("/actions/runners/registration-token", "POST");
  const put = { Name: TOKEN_PARAM, Type: "SecureString", Value: token };
  await ssm.send(
    new PutParameterCommand(
      exists
        ? { ...put, Overwrite: true }
        : {
            ...put,
            Tags: [
              { Key: TAG_KEY, Value: TAG_VALUE },
              { Key: "Project", Value: "conductia" },
              { Key: "ManagedBy", Value: "wake-lambda" },
            ],
          },
    ),
  );
  return exists ? "rotated" : "created";
}

async function queuedJobs() {
  const runs = [];
  for (const status of ["queued", "in_progress"]) {
    const page = await github(`/actions/runs?status=${status}&per_page=100`);
    runs.push(...page.workflow_runs);
  }
  let heavy = 0;
  let light = 0;
  for (const run of runs.slice(0, MAX_RUNS)) {
    const { jobs } = await github(
      `/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    for (const job of jobs) {
      if (job.status !== "queued") continue;
      const ours = job.labels.filter((l) => l.startsWith(LABEL_PREFIX));
      if (ours.length === 0) continue;
      if (ours.includes(HEAVY_LABEL)) heavy += 1;
      else light += 1;
    }
  }
  return { heavy, light, runs: runs.length };
}

async function busyRunnerNames() {
  const busy = new Set();
  for (let page = 1; page <= 5; page += 1) {
    const out = await github(`/actions/runners?per_page=100&page=${page}`);
    for (const r of out.runners) if (r.busy) busy.add(r.name);
    if (out.runners.length < 100) break;
  }
  return busy;
}

async function fleet(busy) {
  const out = await ec2.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: `tag:${TAG_KEY}`, Values: [TAG_VALUE] },
        {
          Name: "instance-state-name",
          Values: ["pending", "running", "stopping", "stopped"],
        },
      ],
    }),
  );
  return classify(
    out.Reservations.flatMap((r) => r.Instances),
    busy,
    HEAVY_CLASSES,
    BURST_CLASSES,
  );
}

export async function handler() {
  let token;
  try {
    token = await refreshRegistrationToken();
  } catch (e) {
    token = `error:${e.name}`; // never the message: it could echo a request
  }
  const q = await queuedJobs();
  const f = await fleet(await busyRunnerNames());
  const n = plan(q, f);
  const ids = toStart(f, n);
  let error;
  if (ids.length > 0) {
    try {
      await ec2.send(new StartInstancesCommand({ InstanceIds: ids }));
    } catch (e) {
      error = e.name;
    }
  }
  console.log(
    JSON.stringify({
      runs: q.runs,
      queuedHeavy: q.heavy,
      queuedLight: q.light,
      idleHeavy: f.heavy.idle,
      idleLight: f.light.idle,
      stoppedHeavy: f.heavy.stopped.length,
      stoppedLight: f.light.stopped.length,
      startHeavy: n.heavy,
      startLight: n.light,
      started: ids,
      token,
      error,
    }),
  );
  return { started: ids.length };
}
