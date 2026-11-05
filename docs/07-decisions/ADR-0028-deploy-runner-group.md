# ADR-0028: Deploy runner group: one JIT runner on a fresh VM per deploy job, minted by a gatekeeping launcher

Status: Accepted (owner decisions, 2026-10-21: isolation option B, refinements 1 to 5, launcher protections). Built dormant: no PR applies anything to AWS, changes a GitHub setting or dispatches a workflow. Every live step is an owner step in the runbook below.
Related: decision-log D117 (amends D104). Issue #639. ADR-0027 (the shared CI fleet). Follow-ups in #680. `infra/deploy-runner/`. `.github/workflows/{promote-develop-to-staging,promote-staging-to-main,e2e-live-smoke,migrate}.yml`.

## Bottom line

- **The problem.** A release cannot run. Every staging and production deploy job is GitHub-hosted, and the org Actions budget is spent. These jobs hold the production database and Vercel secrets, so they cannot simply move to the shared CI fleet, which runs pull-request code on persistent hosts.
- **The decision.** The deploy jobs run on just-in-time (JIT) runners in a dedicated org runner group, `conductia-deploy`. Each runner lives on a fresh VM with no AWS role, serves one job and terminates.
- **The gate is outside the repository.** A launcher Lambda mints each runner. It serves only allowlisted workflow, branch and event combinations, and only runs whose commit is already on their branch. While any refused job could take a runner, it mints nothing.
- **The switch is one repository variable**, `CI_RUNNER_DEPLOY`, as ADR-0027 does for CI. Unset, every deploy job runs GitHub-hosted, as today.
- **Refusals are loud.** Every refused job, every deploy runner that took a refused job, and a misconfigured group raise the tripwire alarm. A hold that blocks admitted jobs for 10 minutes raises a second alarm. A launcher that fails 3 of 5 ticks raises a third.
- **The launcher is protected too.** Its GitHub App key sits under a KMS key only the launcher can use. Any runner in the group that the launcher did not mint raises its own alarm. A guard policy, an explicit Deny, stops the CI fleet's roles and every other principal it is attached to from changing the launcher, its key, logs, alarms, template or security group, or reading a deploy VM's user data. The audit rules come in PR C.

## Context

- Everyday CI runs on six persistent, repository-level runners (ADR-0027). They share one role, one security group and one reusable registration token. Several of their workflows run PR code.
- Any process on a fleet host can read that registration token and register a new runner for this repository, with any label. A deploy job that only asked for a new label could therefore be served by an impostor registered from a PR job.
- On GitHub Team, a runner group can restrict which repositories use it, but not which workflows or branches ("selected workflows" is Enterprise only).
- A JIT config names a group and labels, not a job. GitHub gives a minted runner any queued job in its group whose labels it satisfies.
- Promotions run the workflow files on `main`. Anyone with write access can push to `main` and `staging` directly until F7 lands (design R18, R19).

## Decision

1. **Option B (owner, 2026-10-21).** Deploy jobs target `{"group": "conductia-deploy", "labels": ["conductia-deploy"]}`. Only the launcher holds a credential that registers into the group, so an impostor registered from the fleet is never eligible: `runs-on` requires the group and the label.
2. **Which jobs move.** Every job of both promotions and the live smoke, and *Migrate database* for `db-staging` and `db-production`. `db-dev` stays on `CI_RUNNER_LIGHT`.
3. **The allowlist (refinement 2).** The launcher serves a run only if its workflow path, branch and event match an entry whose expiry has not passed. Steady state is `main` for every deploy workflow, plus `staging` for *Migrate database* only. Three bootstrap entries expire on their own (Oct 25, 27 and 30). A called workflow runs inside its caller's run, so a promotion's `migrate` and `live_smoke` jobs are admitted by the promotion's entry. A test pins the steady-state rows against the workflows that name `CI_RUNNER_DEPLOY`.
4. **Commit provenance (refinement 1).** The launcher reads the tip of `refs/heads/<branch>` and serves the run only if `compare/<head_sha>...<tip>` has `behind_by == 0`. Reading `heads/` means a same-named tag cannot stand in for the branch. The run's head repository must be this repository.
5. **Fail closed (design R25).** A queued job counts as targeting the deploy runner when its labels are a subset of the runner's labels, compared case-insensitively. If any such job is refused, nothing is minted that tick. Admitted jobs wait until the refused job is cancelled.
6. **A bad group mints nothing (design R0, review 1).** The configured group must resolve to exactly one group with visibility `selected`, public repositories off and `Conductia/Conductia` as its only repository. An empty group name is refused the same way: the repository-level fallback is not built (F9).
7. **A GitHub App, not a PAT (refinement 3).** Each tick signs a JWT and asks for an installation token narrowed to this repository and to Actions: read, Contents: read, Metadata: read and Self-hosted runners: write. The token is never cached. The App never holds Administration.
8. **A fresh VM per job.** An `m6a.large` from a pinned launch template: pinned AMI, no instance profile, no ingress, IMDSv2 with hop limit 1, terminate on shutdown, and a 120-minute hard cap. At most 3 deploy VMs live at once.
9. **Boot order (design R4).** The JIT config is a live credential until a runner session claims it, so the boot script starts the runner before anything slow. It fetches the pinned runner release and checks its SHA-256, with every step before the runner starts bounded in time, so a stalled download powers the VM off rather than holding a cap slot (audit V6). It writes the job-started hook and a default `PATH` into the runner's `.env`, because `sudo` drops the shell's environment. Then it starts `run.sh`, handing it the JIT config through a runner-only file on tmpfs rather than sudo's command line (audit V15), and only after that installs the toolchain, into directories already on that `PATH`. The toolchain is pinned too (audit V11): Node is `node_version`, checked against `node_sha256`, and Playwright's `install-deps` is `playwright_version`, which a test holds equal to `package-lock.json`'s. The hook holds the job's first step until the toolchain is ready.
10. **The App-key KMS key (design R20).** No account-root statement, so no IAM policy can grant use of the key. Only the launcher decrypts, only through SSM and only for the App-key parameter. Admins manage the key and put a rotated App key, but cannot read one without first rewriting the key policy (`kms:PutKeyPolicy`), which the audit rules report (PR C). Grants are denied to all. The parameter is never declared in tofu.
11. **Its own module, applied by an admin only (design R11).** `infra/deploy-runner/` has its own state key, and only `launcher_admin_arns` apply it. The CI operator keeps applying the fleet and must not be able to change the launcher.
12. **Bookkeeping without a database (design R23, R26).** Each deploy VM carries its runner's id as a tag, so the group's runner list and the trusted VMs say which runners the launcher minted. A runner it never minted is reported, not deleted (O18). A runner whose VM is gone is deleted. An idle or over-cap VM is retired by deleting its runner first and terminating it only if the delete succeeded and no unfinished job carries the runner. A VM past 130 minutes is terminated outright.

## Threat model

What a PR-controlled process on the shared fleet can do afterwards:

| Action | Possible? |
|---|---|
| Read the repository registration token | yes (unchanged, F1) |
| Register a repository-level runner labelled `conductia-deploy` | yes, but it is not in the org group, so no deploy job ever goes to it |
| Register into the `conductia-deploy` group | no: that needs the App key, which only the launcher role can decrypt |
| Reach a deploy VM over the network | no: neither security group admits ingress |
| Leave state for the next deploy job | no: each VM serves one job and terminates |
| Get a deploy runner for its own group-targeted job | not while it is queued: the launcher holds all minting. In the short race before the hold sees it, it gets an empty VM with no AWS role and none of the deploy environments' secrets |

Who can do what to the launcher, once this work is complete:

| | launcher role | admin principals | CI fleet, wake and scheduler roles | anyone else in the account |
|---|---|---|---|---|
| decrypt the App key | yes, through SSM | no, but they can rewrite the key policy to allow it (`kms:PutKeyPolicy`); alarmed (PR C) | no (key policy) | no (key policy) |
| put a rotated App key | no | yes | no | no |
| change the launcher, its role, template or SG | no (its guard variant) | yes | no (guard) | no once guarded (O16); else only if IAM allows; alarmed (audit rules, PR C) |
| write the launcher's log group | its own streams | yes | no (guard) | no once guarded (O16); else only if IAM allows |
| change or silence the alarms, the alert topic or the audit rules | no (its guard variant) | yes | no (guard) | no once guarded (O16); else only if IAM allows; alarmed (PR C) |
| read a deploy VM's user data | no (its guard variant) | alarmed (PR C) | no (guard) | no once guarded (O16); else alarmed (PR C) |
| tag or launch an instance as a deploy VM | its own VMs only | yes | no (guard) | no once guarded (O16) |

## As built (2026-10-22)

- **Module.** `infra/deploy-runner/`: the CI fleet's VPC and public subnet found by tag, the security group `conductia-deploy-runner` (no ingress, all egress), the KMS key `alias/conductia-deploy-runner`, the launch template `conductia-deploy-runner`, the Lambda and role `conductia-deploy-runner-launch`, its log group, and a one-minute schedule that ships **disabled**. Two ticks never overlap (audit V2): the function has a reserved concurrency of 1, and its event invoke configuration allows no retries and drops an event older than 60 s. Scheduler invokes asynchronously, and Lambda's default of two retries would otherwise run a failed tick again beside the next one, and both could mint for the same job.
- **A tick** (`lambda/deploy.mjs`; every decision is pure in `lambda/deploy-plan.mjs`):
  1. On the first tick after a cold start, a `RunInstances` DryRun of the real launch, logged as `{"event":"deploy_selfcheck","run_instances":"authorized|denied|error"}`.
  2. The installation token, then the group check.
  3. The trusted deploy instances: `Component = deploy-runner`, a `RunnerId` tag, and `aws:ec2launchtemplate:id` equal to the deploy template. AWS sets the last one on every launch from the template, and nobody can set an `aws:` tag by hand. No other instance is ever classified, counted toward the cap or terminated.
  4. The group's runners, before anything is decided. Each is **known** (its id is tagged on a pending or running VM; **idle** if not busy, which includes a booting VM whose runner has not connected; but a runner still offline on a VM launched more than 10 minutes ago is **stuck**, not idle: its boot hung, and it is retired in step 10, audit V6), **reap** (tagged only on a VM that is no longer live) or **unknown** (tagged on no trusted VM). Each unknown runner is logged as `{"event":"deploy_unknown_runner","runner_id","status","busy"}`: ids and state, never its name, which whoever registered it chose.
  5. The runs: one list call per status, `queued`, `in_progress`, and `completed` with `created >= now - 130 min`. The jobs (`filter=all`, so every attempt) of every queued and in-progress run, and of every completed run updated in the last 5 minutes. No read here stops the tick (audit V1). A failed read, a `TooManyPages` included, makes its check **blind** and is logged once per tick as `{"event":"deploy_blind","scope","error"}`. `scope` is `queued` when an active run list, an active run's jobs or a queued run's ref or compare could not be read, and `posthoc` when the completed list or any run's jobs or verdict could not be read. The tick goes on with what it read. A busy two hours can hold more than ten pages of completed runs, because every issue comment starts a run.
  6. Admission and provenance for each queued job that targets the deploy runner. Each refused one is logged as `{"event":"deploy_tripwire","run_id","job_id","reason"}`, with `reason` one of `not_allowlisted`, `expired`, `provenance` or `foreign_repo`.
  7. The post-hoc check: every job whose `runner_group_id` is the deploy group, or whose `runner_id` is a runner the launcher minted, has its run admitted again. A refused one is logged as a tripwire with `reason: "served_refused"` and its `runner_id`. The group id needs no EC2 tag, so the check still works after a terminated VM drops out of `DescribeInstances`.
  8. If anything was refused, or the queued check is blind (a refused job may sit in what was not read, so admission is never decided on part of the queue): no launch, and one `{"event":"deploy_hold","refused","admitted_waiting"}` record. Every idle minted runner joins the retire list of step 10, so no leftover runner stays eligible for the refused job.
  9. The reaper. A `DELETE` of every **reap** runner: its VM is gone.
  10. Delete first, then terminate. The retire list is every live VM whose runner is online and idle and that was launched more than 7 minutes ago (about 5 minutes after its runner came online), every live VM whose runner is stuck, plus, while more than 3 VMs are live, the newest VMs with an idle runner, and, while held, every idle minted runner's VM. The busy flag is from step 4, and GitHub can hand that runner a job in between, so: `DELETE` the runner; GitHub answers non-2xx while the runner runs a job, and a deleted runner takes no new job. After the deletes, the jobs of every queued and in-progress run are read again. Only a VM whose runner was deleted and that no unfinished job carries is terminated. A failed re-read terminates nothing.
  11. The hard cap: a VM launched more than 130 minutes ago is terminated without the delete, busy or not. It is past every job timeout and its own `shutdown -h +120`.
  12. Otherwise `launch = max(0, min(admitted - idle, 3 - live))`. For each launch: `generate-jitconfig` with `{name: "deploy-<12 hex>", runner_group_id, labels: ["conductia-deploy"], work_folder: "_work"}`, then `RunInstances` with the template id and the version tofu pinned (`LAUNCH_TEMPLATE_VERSION`), never `$Default` or `$Latest`. If `RunInstances` fails, the runner just minted is deleted at once and launching stops for the tick.
  13. One record, `{"event":"deploy_tick","group","queued","admitted","refused","served_refused","unknown","reaped","deregistered","terminated","launched","idle","live","github_calls"[,"blind"][,"error"]}`, where `blind` lists the blind scopes and `github_calls` counts the tick's GitHub requests after the installation token. Ids, counts and codes only: never a token, a key, a JIT config, a branch, a commit or a runner name. A group that fails the check logs `{"event":"deploy_tripwire","reason":"group_misconfigured"}` (no ids) and mints nothing.
- **The tick's time budget (audit V8).** The function times out at 50 s. No GitHub read or delete starts after 25 s; one that would fails as `OutOfTime`, which blinds its check like any failed read, so the tick holds and still writes its record. No mint starts after 28 s, so `generate-jitconfig`, the launch and, if the launch fails, the cleanup `DELETE` finish before the timeout; a launch cut short this way records `error: "OutOfTime"` and the job waits a minute. A held tick mints nothing, so its purge runs on a longer budget, 36 s: the deletes of idle minted runners and the jobs re-read before their terminate (fix check N1). A hold that could not purge would leave an idle runner open to the refused job. If the re-read misses 36 s, the runner is still deleted and its VM ends on its own when the runner exits. EC2 calls make one attempt with a 3 s connection and 8 s idle timeout (fix check N3), so a launch started near 28 s does not outlast the function either. Every queued and in-progress run still has its jobs read on every tick: any workflow file, a pull request's included, can target the group, so reading fewer runs would let a refused job go unseen. The call count is measured instead (O8).
- **Logs** use Lambda's JSON format, and each record is one object argument, so a metric filter can match `$.message.event`.
- **Alarms** (`alarms.tf`). The three alarms fed by metric filters read `Maximum`, not `Sum` (audit V13): a negative datapoint put into their metric from elsewhere could cancel a sum, never a maximum. The SNS topic `conductia-deploy-runner-alerts`, unencrypted on purpose, with the account statement and an `events.amazonaws.com` plus `cloudwatch.amazonaws.com` publish statement conditioned on `aws:SourceAccount`. Every alarm and audit rule of this module notifies it.
  - `conductia-deploy-runner-tripwire` (metric `DeployTripwire`): filter `{ ($.message.event = "deploy_tripwire") || ($.message.event = "deploy_blind") || (($.message.event = "deploy_selfcheck") && ($.message.run_instances = "denied")) }`, Maximum >= 1 over 60 s, missing data not breaching. It emails once per OK to ALARM transition.
  - `conductia-deploy-runner-held-with-admitted-waiting` (metric `DeployHeldWithAdmittedWaiting`): filter `{ ($.message.event = "deploy_hold") && ($.message.admitted_waiting > 0) }`, 10 of 10 one-minute periods (Maximum >= 1 in each). It is the release-day signal: the tripwire stays in ALARM through a long freeze and would not email again.
  - `conductia-deploy-runner-unknown-runner` (metric `DeployUnknownRunner`): filter `{ $.message.event = "deploy_unknown_runner" }`, Maximum >= 1 over 60 s, missing data not breaching. Its own alarm, so the email says which kind of trip it is.
  - `conductia-deploy-runner-launcher-errors` (`AWS/Lambda` `Errors`, dimension `FunctionName = conductia-deploy-runner-launch`): Sum >= 1 in 3 of 5 one-minute periods, missing data not breaching, and it emails on recovery too. A tick fails when the configuration, the App key, the token, the group, the group's runner list, the EC2 describe or a `generate-jitconfig` call fails, or when it times out. A failed run or job read does not fail the tick: it is a `deploy_blind` record, and the tripwire alarm fires on it. One failed tick is never retried; the next scheduled tick a minute later reads everything again, and one failure pages nobody; three in five minutes is a broken launcher, reported inside the post-hoc check's 5-minute window. A dormant launcher has no invocations, so it never alarms. A failed `DELETE`, `RunInstances` or terminate does not fail the tick: it shows only in `deploy_tick`'s `error`.
- **Role.** `RunInstances` only from the deploy template, only as its instance type (`ec2:InstanceType`, audit V20), only for resources tagged `Component = deploy-runner`; the AMI, subnet and SG only as the template supplies them (`ec2:IsLaunchTemplateResource`); the template ARN in its own statement without a condition. `TerminateInstances` only on instances with `ec2:ResourceTag/Component = deploy-runner` **and** `ec2:ResourceTag/aws:ec2launchtemplate:id` equal to the deploy template's id, so a `Component` tag alone never makes an instance terminable; the launcher checks the same three tags itself before every terminate. `CreateTags` only on create, `DescribeInstances`, `GetParameter` on the App-key parameter, and its own log streams. No `iam:PassRole`, no `StopInstances`, no key pair.
- **The guard** (`guard.tf`, design R21). The managed policy `conductia-deploy-launcher-guard` is one explicit Deny, so it holds whatever Allow a principal is given later. It denies:
  - on the function `conductia-deploy-runner-launch` and its qualifiers: code, configuration, concurrency, permission, version, alias, function URL and event-invoke changes, and deletion;
  - `iam:*` on the launcher role, on the schedule's role `conductia-deploy-runner-scheduler` (without its invoke permission or its trust the schedule stops invoking the launcher, and a launcher that is never invoked raises no alarm; audit V9) and on the guard itself (its versions, its deletion), and `iam:DetachRolePolicy`, `DetachUserPolicy` and `DetachGroupPolicy` on any principal when `iam:PolicyARN` is the guard. A detach call's resource is the principal, not the policy, so without this a guarded principal could remove its own guard;
  - `kms:*` on the App-key KMS key and its alias, and every read, write, delete and label of the App-key parameter and its path;
  - updating or deleting the launcher schedule; writing to the launcher's log group, changing its retention or metric filters, deleting it or its streams, and changing its KMS association;
  - `cloudwatch:PutMetricData` into the alarms' namespace `Conductia/DeployRunner` (the fleet's `CloudWatchAgentServerPolicy` may put metric data anywhere, and a negative datapoint would cancel a metric filter's 1); deleting, disabling, setting the state of or replacing any alarm named `conductia-deploy-*`;
  - putting, deleting, disabling or retargeting any EventBridge rule named `conductia-deploy-*`. These are PR C's audit rules, named by prefix so the guard does not depend on PR C; everything but `sns:Publish` on the alert topic and its subscriptions;
  - reading a deploy VM's user data or console (`ec2:DescribeInstanceAttribute`, `GetLaunchTemplateData`, `GetConsoleOutput`, `GetConsoleScreenshot`), and modifying, stopping, rebooting or terminating a deploy VM or its network interface, each keyed on `ec2:ResourceTag/Component = deploy-runner`. Audit V7 adds, on the same key: associating, replacing or removing an instance profile (a role with SSM access would give a session as root during a job that holds production secrets), loosening the metadata options, imaging or snapshotting a deploy VM or its volume, and attaching or detaching a volume. No fleet role holds any of these today; the deny is defence in depth for the principals O16 guards;
  - a new version, a modification or the deletion of the deploy launch template, and any rule change or deletion of the deploy security group;
  - tagging or launching anything with `Component = deploy-runner` or with a `RunnerId` tag, and tagging or untagging anything that already carries `Component = deploy-runner`. No guarded principal can dress an instance up as a deploy VM. `aws:ec2launchtemplate:id` needs no deny: AWS reserves the `aws:` prefix.
- **Where the guard sits.** This module attaches it, by role name, to the CI fleet's `conductia-ci-runner-instance`, `conductia-ci-runner-wake` and `conductia-ci-runner-scheduler`, and to nothing else. Neither module declares an exclusive policy list, so neither apply undoes the other's attachments; both test suites pin that. The owner attaches the same policy to every other principal that is not a launcher admin (O16). The admins never carry it.
- **The launcher's own variant.** The launcher role carries the guard inline as `conductia-deploy-runner-launch-guard`, minus what the launcher calls: its own log streams, `ssm:GetParameter` on the App key, `kms:Decrypt` on the App key, and `ec2:TerminateInstances`. The KMS statement is `NotAction: kms:Decrypt`, because an explicit Deny would beat the key policy's Allow. The key policy still limits that Decrypt to calls through SSM for the App-key parameter. The variant also leaves out the three tag denies, because the launcher tags its own VMs. A compromised launcher still cannot rewrite itself, its role, its template or its key. The shared guard is never attached to the launcher: its tag denies would stop every launch.
- **Resource-level support, checked against the AWS Service Authorization Reference on 2026-10-22.** `ec2:DescribeInstanceAttribute`, `ec2:GetLaunchTemplateData`, `ec2:GetConsoleOutput` and `ec2:GetConsoleScreenshot` each authorize on the `instance` resource (required) and accept `ec2:ResourceTag/${TagKey}`. So the user-data deny is keyed on the deploy tag rather than `Resource: "*"`. That matters once the CI operator carries the guard (O16): the AWS provider reads instance attributes on every refresh of `infra/ci-runner/`, and a deny on `*` would break its plans. The same reference confirms `iam:PolicyARN` on the three detach actions and `cloudwatch:namespace` on `PutMetricData`.
- **Tests.** `tests/deploy-runner.tftest.hcl` (mock provider) pins the VM, the boot order, every role statement (`ReapOwn` included, as the only statement that can terminate), the template pin, the JSON logs, the key policy, the absence of any `aws_ssm_parameter`, the three metric filters and their alarms, the launcher `Errors` alarm (metric, namespace, function dimension, thresholds, topic, and the guard's alarm deny covering its name), the allowlist validation and the disabled schedule. `lambda/deploy-plan.test.mjs` and `lambda/deploy.test.mjs` pin the decisions and one tick against a stubbed GitHub and EC2, on payloads recorded with read-only GETs in `lambda/fixtures/`. They include the reap race: a runner idle when listed and busy at the reap, whose `DELETE` answers 422, keeps its VM, and so does one whose `DELETE` succeeds while an in-progress job carries its id. They also include blind reads (audit V1): a completed-run list that overflows still lets the tick log the refusal, the hold, the purge and a `served_refused` from an in-progress run, and a failed queued-side read holds. `scripts/infra/validate.sh` now runs `node --test infra/*/lambda/*.test.mjs`, so CI runs the fleet's `plan.test.mjs` too.
- **Guard tests.** Three runs in `tests/deploy-runner.tftest.hcl` pin every guard statement exactly, the three attachments by role name, and the launcher's variant. The variant check takes each call the launcher makes, on each resource it touches, and asserts no Deny in the variant covers it (by exact action, a `prefix*` wildcard, or a `NotAction` that does not exclude it). It also asserts that the shared guard denies each of those calls. A new run in `infra/ci-runner/tests/ci-runner.tftest.hcl` pins the other side: the fleet, wake and scheduler inline policies allow no `iam:` action, no wildcard action, no `NotAction` or `NotResource`, no SSM resource but the registration token and the PAT, `lambda:` only to invoke the wake function, and `kms:` only `Decrypt`, `Encrypt` and `GenerateDataKey` through SSM. The fleet's managed attachments are exactly `AmazonSSMManagedInstanceCore` and `CloudWatchAgentServerPolicy`. The mock provider cannot read a managed policy, so their content rests on the research (neither grants a `lambda:` or `iam:` action), and the guard's Deny holds even if AWS widens them.
- **Not yet in this module:** the audit rules (PR C).

## Residual risks

- **Direct pushes to `main` and `staging`** stay possible for anyone with write access until F7 and the ruleset (O11, O12). That code would then run with production secrets. This is the same as today.
- **The race windows (design R25).** A refused job queued in the seconds between a mint and the runner connecting can win that runner. It gets an empty VM with no role and no deploy secrets; the post-hoc check reports it. The structural fix is F10.
- **A deliberate freeze.** Anyone with write access can hold all minting by queuing a refused job that targets the group. It is loud and reversible (`gh run cancel`); a named canceller covers the release windows (O21).
- **An idle leftover.** A refused job queued while a minted runner sits connected and idle can win it before the next tick's purge: at most one tick, about 60 s. Same outcome as the race above, and the post-hoc check reports it.
- **The post-hoc check's blind spot.** GitHub keeps a run's `created_at` on a re-run, so a re-run of a run created more than 130 minutes earlier is not in the `completed` list. If its job both starts and ends between two ticks on a deploy runner, it is not reported. A job that spans a tick is still seen through the `in_progress` list. The job gets the same empty VM either way.
- **A blind read purges runners still booting for admitted jobs (fix check N2).** A blind queued check holds, and a hold deregisters every idle minted runner, including one still booting for an admitted deploy (it is offline and not busy, so it counts as idle). One tick reads the jobs of every active run in the repository, so one transient 5xx or timeout among them is enough. Its VM is retired, and the next clean tick mints again. On a flaky GitHub day an admitted deploy can loop through mint and purge for several minutes, at the cost of a VM each cycle. This is deliberate: a blind tick cannot tell an admitted job's runner from one a refused job could take, so it fails closed. It heals by itself once reads succeed.
- **A run past its bootstrap expiry.** The post-hoc check admits a run again at the time of the tick. A run admitted just before its bootstrap entry expired and still running after it reports `served_refused`. Check the run against the expiry dates before treating it as an attack.
- **The JIT config is readable through the EC2 API** until the VM terminates. The guard and the audit rule cover that path; a baked AMI (F2) shortens the window.
- **`runs-on` with a `fromJSON` object** is unproven until the positive canary (design R2). If GitHub rejects it, a one-line follow-up switches to a static `{group, labels}`.
- **The runner's labels.** `runner_labels` defaults to `conductia-deploy` plus GitHub's default labels, so a bare `self-hosted` job also counts as targeting. The canary records the real labels.
- **A VM whose runner is gone holds a cap slot until its hard cap.** A live deploy VM whose runner GitHub no longer lists (its runner never connected, or was deleted while it ran a job) is not idle, so only its own `shutdown -h +120` or the launcher's 130-minute hard cap ends it. Until then it counts toward the 3-VM cap. A boot that fails before the runner starts powers off at once.
- **The guard binds only the principals that carry it.** It is enforced on the principal side, because a Lambda function policy holds only Allows and an SCP needs an AWS Organization (O17). A principal without it, an admin included, is held only by its own IAM and seen only by the audit rules (PR C). A guarded principal that may create IAM users or roles can create one without the guard. So O16 is repeated after every IAM change in the account, and O17's SCP is the form that closes the gap.
- **A launch from the deploy template by someone else.** A guarded principal that holds `ec2:RunInstances` from another policy can still launch from the deploy template. AWS does not document whether a template's own tags reach `aws:RequestTag`, so the guard's tag deny may not stop it. Such a VM carries no `RunnerId`, so the launcher never counts, classifies or terminates it, and the guard stops anyone giving it one later. The CI fleet's roles have no `RunInstances` at all.
- **The terminate condition is unproven until the canary.** Whether IAM matches `ec2:ResourceTag/aws:ec2launchtemplate:id` (an `aws:`-prefixed tag key) is checked only by the positive canary's terminate. If IAM refuses it, `deploy_tick` records `error: "UnauthorizedOperation"` on each retire and the VMs still end on their own shutdown; nothing else is allowed to terminate.
- **What the launcher-errors alarm does not see.** A launcher that is never invoked has no `Errors` datapoint, and missing data is not breaching, so a stopped schedule is silent there. The guard denies changing the schedule, and the audit rule `launcher-changed` (PR C) reports a change. A launch that keeps failing (for example `InsufficientInstanceCapacity`) does not fail the tick either: admitted jobs stay queued, and only `deploy_tick`'s `error` shows why. On a release day, check `deploy_tick` when a deploy job stays queued for more than a few minutes.

## Owner runbook

Every command runs as the named owner. Unset any AWS keys and hosted database URLs your shell profile exports first. Never run these from an agent session.

Run every step in one shell, from the repository root, with the admin profile exported once (audit V5). `tofu output`, the `-chdir` reads of the state bucket and every `aws` command below need it, not only plan and apply:

```sh
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
export AWS_PROFILE=<admin profile>   # an O15 admin principal
aws sts get-caller-identity --query Arn --output text   # one of launcher_admin_arns
```

O4 then `cd`s into `infra/deploy-runner/`, and the steps after it run from there.

### O15: name the launcher admin principals (by Oct 23)

Choose two IAM principals: your MFA-protected admin role, and a second admin principal so the KMS key cannot be orphaned. They are the only principals that apply `infra/deploy-runner/`, change the launcher or manage the App key. Recommended: `conductia-ci-operator` is **not** one of them, so the guard can be attached to it (O16). Write them into a tfvars file that never enters git (`infra/**/*.tfvars` is ignored):

```hcl
# infra/deploy-runner/deploy.tfvars
launcher_admin_arns = [
  "arn:aws:iam::368994863349:role/<your admin role>",
  "arn:aws:iam::368994863349:user/<second admin principal>",
]
ami_id = "<from the command below>"
```

The AMI: `aws ssm get-parameter --region us-east-1 --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text`. It is pinned from then on; a new AMI is a reviewed tfvars change.

Before O4, check the runner pin against GitHub (audit V19). A wrong pin powers every deploy VM off at boot. The digest must equal `runner_sha256` in `variables.tf`, without the `sha256:` prefix:

```sh
v=$(sed -n '/variable "runner_version"/,/^}/s/.*default *= *"\(.*\)"/\1/p' infra/deploy-runner/variables.tf)
gh api repos/actions/runner/releases/tags/v$v --jq ".assets[] | select(.name == \"actions-runner-linux-x64-$v.tar.gz\") | .digest"
sed -n '/variable "runner_sha256"/,/^}/s/.*default *= *"\(.*\)"/\1/p' infra/deploy-runner/variables.tf
```

Every principal you do not name here gets the guard (O16), and only the principals named here may change the launcher. The applying principal must be one of them: KMS refuses a key policy that locks out its caller.

### O2: create the org runner group (org owner, hard cutoff Oct 24 end of day)

```sh
repo_id=$(gh api repos/Conductia/Conductia --jq .id)
gh api -X POST orgs/Conductia/actions/runner-groups \
  -f name=conductia-deploy -f visibility=selected \
  -F allows_public_repositories=false -F "selected_repository_ids[]=$repo_id"
```

Check: `gh api orgs/Conductia/actions/runner-groups --jq '.runner_groups[] | select(.name == "conductia-deploy") | {id, visibility, allows_public_repositories}'` shows `selected` and `false`, and `gh api orgs/Conductia/actions/runner-groups/<id>/repositories --jq '[.repositories[].full_name]'` is exactly `["Conductia/Conductia"]`. Anything else and the launcher mints nothing. If O2 misses the cutoff, decide that day between deferring the canaries and the dry run, and building the fallback (F9, O3b).

### O4, first pass: apply as an admin principal (Oct 24)

```sh
cd infra/deploy-runner
tofu init -backend-config=bucket=$(tofu -chdir=../ci-runner/bootstrap output -raw state_bucket) \
  -backend-config=region=us-east-1 \
  -backend-config=kms_key_id=$(tofu -chdir=../ci-runner/bootstrap output -raw state_kms_key_arn)
tofu plan -var-file=deploy.tfvars -out deploy.tfplan
tofu apply deploy.tfplan
```

It creates the KMS key, the security group, the launch template, the launcher role and function, the alert topic with the tripwire, hold, unknown-runner and launcher-errors alarms, the guard policy, and the schedule, **disabled**. It also attaches the guard to the CI fleet's three roles, so `infra/ci-runner/` must already be applied (it is, per ADR-0027). Subscribe to the topic next (O10). Checks:

```sh
aws scheduler get-schedule --region us-east-1 --name conductia-deploy-runner-launch --query State   # DISABLED
guard=$(tofu output -raw launcher_guard_policy_arn)   # arn:aws:iam::368994863349:policy/conductia-deploy-launcher-guard
aws iam list-entities-for-policy --policy-arn "$guard" --query 'PolicyRoles[].RoleName'
# exactly conductia-ci-runner-instance, conductia-ci-runner-wake and conductia-ci-runner-scheduler
aws iam list-role-policies --role-name conductia-deploy-runner-launch
# conductia-deploy-runner-launch and conductia-deploy-runner-launch-guard
aws lambda get-function-concurrency --region us-east-1 --function-name conductia-deploy-runner-launch   # 1
aws lambda get-function-event-invoke-config --region us-east-1 --function-name conductia-deploy-runner-launch \
  --query '[MaximumRetryAttempts,MaximumEventAgeInSeconds]'   # [0, 60]
```

If the apply fails with `InvalidParameterValueException` on the reserved concurrency, the account's Lambda concurrency limit is below the 100 unreserved executions AWS insists on (new accounts start at 10). Raise it through Service Quotas (`aws service-quotas request-service-quota-increase --service-code lambda --quota-code L-B99A9384 --desired-value 1000`) and apply again; do not drop the reservation.

Never apply this module as `conductia-ci-operator`.

### O10: subscribe to the alert topic (owner, right after O4's first pass)

```sh
topic=$(tofu output -raw deploy_alerts_topic_arn)   # still in infra/deploy-runner/ from O4
aws sns subscribe --region us-east-1 --topic-arn "$topic" --protocol email --notification-endpoint <owner address>
```

Confirm the email AWS sends. Until it is confirmed, every deploy runner alert goes nowhere. Check: `aws sns list-subscriptions-by-topic --topic-arn "$topic" --query 'Subscriptions[].SubscriptionArn'` shows an ARN, not `PendingConfirmation`.

Then prove both filters match the launcher's real record shape. Each command must report one match:

```sh
aws logs test-metric-filter --region us-east-1 \
  --filter-pattern '{ ($.message.event = "deploy_tripwire") || (($.message.event = "deploy_selfcheck") && ($.message.run_instances = "denied")) }' \
  --log-event-messages '{"timestamp":"2026-10-25T10:00:00.000Z","level":"INFO","requestId":"00000000-0000-4000-8000-000000000000","message":{"event":"deploy_tripwire","run_id":38585288354,"job_id":115925600001,"reason":"not_allowlisted"}}'
aws logs test-metric-filter --region us-east-1 \
  --filter-pattern '{ ($.message.event = "deploy_hold") && ($.message.admitted_waiting > 0) }' \
  --log-event-messages '{"timestamp":"2026-10-25T10:00:00.000Z","level":"INFO","requestId":"00000000-0000-4000-8000-000000000000","message":{"event":"deploy_hold","refused":1,"admitted_waiting":1}}'
aws logs test-metric-filter --region us-east-1 \
  --filter-pattern '{ $.message.event = "deploy_unknown_runner" }' \
  --log-event-messages '{"timestamp":"2026-10-25T10:00:00.000Z","level":"INFO","requestId":"00000000-0000-4000-8000-000000000000","message":{"event":"deploy_unknown_runner","runner_id":23,"status":"online","busy":true}}'
```

The second command with `"admitted_waiting":0` must report no match. After the second pass of O4, compare against a real line: `aws logs tail /aws/lambda/conductia-deploy-runner-launch --since 10m --format short` prints records in the same shape.

### O16: attach the guard to every other principal (owner, after O4's first pass, before the Oct 26 dry run)

The module attached the guard to the CI fleet's three roles. Attach the same policy to every other IAM user, role and group in the account that is not an O15 admin. Never attach it to an O15 admin, to the launcher role `conductia-deploy-runner-launch` (it carries its own variant inline, and the shared guard's tag denies would stop every launch), or to a service-linked role (it takes no policy). The schedule's role `conductia-deploy-runner-scheduler` needs no attachment: it can only invoke the launcher, and the guard already denies everyone else changing it.

```sh
guard=arn:aws:iam::368994863349:policy/conductia-deploy-launcher-guard
aws iam list-users --query 'Users[].[UserName, Arn]' --output text
aws iam list-groups --query 'Groups[].[GroupName, Arn]' --output text
aws iam list-roles --query 'Roles[?!starts_with(Path, `/aws-service-role/`) && !starts_with(Path, `/aws-reserved/`)].[RoleName, Arn]' --output text
# Which principal the CI operator's profile really is (a user or a role): guard that one (audit V18).
aws sts get-caller-identity --profile conductia-ci --query Arn --output text

# At least these two. Skip conductia-ci-operator only if O15 named it an admin.
aws iam attach-user-policy --user-name conductia-wave6-agent --policy-arn "$guard"
aws iam attach-user-policy --user-name conductia-ci-operator --policy-arn "$guard"   # attach-role-policy if the line above printed a role
# Then every other user, group and role from the three lists, one line each:
aws iam attach-user-policy --user-name <user> --policy-arn "$guard"
aws iam attach-group-policy --group-name <group> --policy-arn "$guard"
aws iam attach-role-policy --role-name <role> --policy-arn "$guard"
```

The discovery worker's roles get it once that module is applied.

Roles under `/aws-reserved/` belong to IAM Identity Center, and IAM refuses to attach a policy to them (`UnmodifiableEntity`), so the list above leaves them out (audit V12). If `aws sso-admin list-instances --query 'Instances[].InstanceArn'` returns an instance, guard those users through their permission sets instead. In the account that holds the Identity Center instance, for every permission set assigned to `368994863349` except an O15 admin's:

```sh
aws sso-admin attach-customer-managed-policy-reference-to-permission-set --instance-arn <instance> \
  --permission-set-arn <set> --customer-managed-policy-reference Name=conductia-deploy-launcher-guard
aws sso-admin provision-permission-set --instance-arn <instance> --permission-set-arn <set> \
  --target-type AWS_ACCOUNT --target-id 368994863349
```

Then each `AWSReservedSSO_*` role but the admins' lists the guard: `aws iam list-attached-role-policies --role-name <AWSReservedSSO_role> --query 'AttachedPolicies[].PolicyName'`. If an O15 admin is itself an Identity Center role, its permission set never gets the guard.

Check:

```sh
aws iam list-entities-for-policy --policy-arn "$guard" \
  --query '{users: PolicyUsers[].UserName, groups: PolicyGroups[].GroupName, roles: PolicyRoles[].RoleName}'
```

Every user, group and role from the lists appears except the O15 admins, the launcher role, the schedule's role and the service-linked roles. Then, with `conductia-wave6-agent`'s key, `aws ssm get-parameter --region us-east-1 --name /conductia/deploy-runner/github-app-key` must fail with an explicit deny in an identity-based policy. During the O8 positive canary, with the same key, `aws ec2 get-launch-template-data --region us-east-1 --instance-id <the live deploy VM>` must fail the same way: it is the first live proof that `GetLaunchTemplateData` honours the deploy-tag condition (audit V21). That read is harmless, and once PR C is applied it raises an audit alert, as expected. Repeat O16 after any IAM change in the account: a new user or role starts without the guard.

### O17: is the account in an AWS Organization? (owner, before Oct 29)

```sh
aws organizations describe-organization --query 'Organization.{id: Id, management: MasterAccountId}'
```

`AWSOrganizationsNotInUseException` means it is not. Then the guard, O16 and the audit rule `launcher-changed` (PR C) are the boundary: record that answer in thread O17 and stop here. The same holds if the management account is `368994863349` itself, because a service control policy (SCP) never applies to the management account.

Otherwise, an admin of the management account adds an SCP. It denies the guard's change actions on the launcher's resources to every principal in the account except the O15 admins, guarded or not. It also covers the trail, which closes the residual that a principal able to disable the audit rules can silence their tamper alert. The launcher's own calls (its log streams, the App-key read and `kms:Decrypt`, launch, tag and terminate) are not in it, which is why the deploy-VM statement leaves out `TerminateInstances`. Run from `infra/deploy-runner/` after O4's first pass, with the two ARNs from O15:

```sh
key=$(tofu output -raw app_key_kms_key_arn)
lt=$(tofu output -raw launch_template_id)
sg=$(tofu output -raw deploy_security_group_id)
admins='"<O15 admin ARN 1>", "<O15 admin ARN 2>"'
p=us-east-1:368994863349
cat > launcher-lock.scp.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OnlyAdminsChangeTheLauncher",
      "Effect": "Deny",
      "Action": [
        "lambda:Update*", "lambda:Put*", "lambda:Delete*", "lambda:AddPermission", "lambda:RemovePermission",
        "lambda:PublishVersion", "lambda:CreateAlias", "lambda:CreateFunctionUrlConfig", "iam:*",
        "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters", "ssm:LabelParameterVersion",
        "scheduler:UpdateSchedule", "scheduler:DeleteSchedule",
        "logs:PutRetentionPolicy", "logs:DeleteLogGroup", "logs:DeleteLogStream", "logs:PutMetricFilter",
        "logs:DeleteMetricFilter", "logs:AssociateKmsKey", "logs:DisassociateKmsKey",
        "cloudwatch:DeleteAlarms", "cloudwatch:DisableAlarmActions", "cloudwatch:SetAlarmState", "cloudwatch:PutMetricAlarm",
        "events:PutRule", "events:DeleteRule", "events:DisableRule", "events:PutTargets", "events:RemoveTargets",
        "sns:DeleteTopic", "sns:SetTopicAttributes", "sns:AddPermission", "sns:RemovePermission", "sns:Unsubscribe",
        "ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate",
        "ec2:DeleteLaunchTemplateVersions", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:ModifySecurityGroupRules",
        "ec2:DeleteSecurityGroup"
      ],
      "Resource": [
        "arn:aws:lambda:$p:function:conductia-deploy-runner-launch",
        "arn:aws:lambda:$p:function:conductia-deploy-runner-launch:*",
        "arn:aws:iam::368994863349:role/conductia-deploy-runner-launch",
        "arn:aws:iam::368994863349:role/conductia-deploy-runner-scheduler",
        "arn:aws:iam::368994863349:policy/conductia-deploy-launcher-guard",
        "arn:aws:ssm:$p:parameter/conductia/deploy-runner/github-app-key",
        "arn:aws:scheduler:$p:schedule/default/conductia-deploy-runner-launch",
        "arn:aws:logs:$p:log-group:/aws/lambda/conductia-deploy-runner-launch",
        "arn:aws:logs:$p:log-group:/aws/lambda/conductia-deploy-runner-launch:*",
        "arn:aws:cloudwatch:$p:alarm:conductia-deploy-*",
        "arn:aws:events:$p:rule/conductia-deploy-*",
        "arn:aws:sns:$p:conductia-deploy-runner-alerts",
        "arn:aws:sns:$p:conductia-deploy-runner-alerts:*",
        "arn:aws:ec2:$p:launch-template/$lt",
        "arn:aws:ec2:$p:security-group/$sg"
      ],
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": [$admins] } }
    },
    {
      "Sid": "OnlyAdminsManageTheAppKey",
      "Effect": "Deny",
      "NotAction": "kms:Decrypt",
      "Resource": "$key",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": [$admins] } }
    },
    {
      "Sid": "OnlyAdminsDetachTheGuard",
      "Effect": "Deny",
      "Action": ["iam:DetachRolePolicy", "iam:DetachUserPolicy", "iam:DetachGroupPolicy"],
      "Resource": "*",
      "Condition": {
        "ArnEquals": { "iam:PolicyARN": "arn:aws:iam::368994863349:policy/conductia-deploy-launcher-guard" },
        "ArnNotLike": { "aws:PrincipalArn": [$admins] }
      }
    },
    {
      "Sid": "OnlyAdminsChangeDeployVms",
      "Effect": "Deny",
      "Action": [
        "ec2:ModifyInstanceAttribute", "ec2:ModifyNetworkInterfaceAttribute", "ec2:StopInstances", "ec2:RebootInstances",
        "ec2:ModifyInstanceMetadataOptions", "ec2:AssociateIamInstanceProfile", "ec2:ReplaceIamInstanceProfileAssociation",
        "ec2:DisassociateIamInstanceProfile", "ec2:CreateImage", "ec2:CreateSnapshot", "ec2:CreateSnapshots",
        "ec2:AttachVolume", "ec2:DetachVolume"
      ],
      "Resource": ["arn:aws:ec2:$p:instance/*", "arn:aws:ec2:$p:network-interface/*", "arn:aws:ec2:$p:volume/*"],
      "Condition": {
        "StringEquals": { "ec2:ResourceTag/Component": "deploy-runner" },
        "ArnNotLike": { "aws:PrincipalArn": [$admins] }
      }
    },
    {
      "Sid": "OnlyAdminsChangeTheTrail",
      "Effect": "Deny",
      "Action": ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail", "cloudtrail:PutEventSelectors"],
      "Resource": "arn:aws:cloudtrail:$p:trail/conductia-account-trail",
      "Condition": { "ArnNotLike": { "aws:PrincipalArn": [$admins] } }
    }
  ]
}
EOF
jq -c . launcher-lock.scp.json | wc -c   # at most 5120
aws organizations list-roots --query 'Roots[0].PolicyTypes'   # SERVICE_CONTROL_POLICY must be ENABLED
policy=$(aws organizations create-policy --type SERVICE_CONTROL_POLICY --name conductia-deploy-launcher-lock \
  --description "Only the launcher admins change the deploy runner launcher (ADR-0028, O17)" \
  --content "$(jq -c . launcher-lock.scp.json)" --query Policy.PolicySummary.Id --output text)
aws organizations attach-policy --policy-id "$policy" --target-id 368994863349
rm launcher-lock.scp.json
```

Check: `aws organizations list-policies-for-target --target-id 368994863349 --filter SERVICE_CONTROL_POLICY --query 'Policies[].Name'` lists `conductia-deploy-launcher-lock`. An admin role ARN with an IAM path must be written with its path, exactly as `launcher_admin_arns` holds it. When O15's admins change, update the SCP in the same sitting, or the new admin cannot apply the module.

### O3: create the launcher GitHub App and store its key (org owner, Oct 24)

1. Organization settings, Developer settings, GitHub Apps, New GitHub App. Name `conductia-deploy-launcher`. Homepage `https://github.com/Conductia/Conductia`. Webhook: off. Where can it be installed: only on this account.
2. Permissions, and no others (specifically no Administration): Organization **Self-hosted runners: Read and write**; Repository **Actions: Read**, **Contents: Read**, **Metadata: Read**.
3. Install it on `Conductia`, "Only select repositories", `Conductia/Conductia`. Note the App id (App settings page) and the installation id (the number at the end of the installation's settings URL).
4. Generate a private key, then, as an admin principal, after O4's first pass:

```sh
aws ssm put-parameter --region us-east-1 --name /conductia/deploy-runner/github-app-key \
  --type SecureString --key-id alias/conductia-deploy-runner --value file:///path/to/key.pem --overwrite
shred -u /path/to/key.pem
```

You can write the key but not read it back: that is the key policy working. Check the parameter's key with `aws ssm describe-parameters --parameter-filters Key=Name,Values=/conductia/deploy-runner/github-app-key --query 'Parameters[0].KeyId'`. Once PR C is applied, this put raises an audit alert, as expected. Rotation is the same `put-parameter --overwrite` with a new key from the App settings, then delete the old key there.

### O4, second pass: enable the schedule (after O3)

Add to `deploy.tfvars`:

```hcl
github_app_id              = "<App id>"
github_app_installation_id = "<installation id>"
launcher_enabled           = true
```

Then plan and apply as in the first pass. Check within two minutes: `aws logs tail /aws/lambda/conductia-deploy-runner-launch --since 5m` shows `deploy_selfcheck` with `run_instances: "authorized"`, and `deploy_tick` records with `group: "ok"`. `group: "misconfigured"` means O2 does not match exactly.

### O5: route the deploy jobs (repo admin, after O4)

```sh
gh variable set CI_RUNNER_DEPLOY --repo Conductia/Conductia --body '{"group":"conductia-deploy","labels":["conductia-deploy"]}'
```

Rollback: `gh variable delete CI_RUNNER_DEPLOY --repo Conductia/Conductia`. The jobs return to `ubuntu-latest`, which runs only with hosted budget headroom (O9).

### O6: bootstrap branch-policy entries (Rob or a repo admin, Oct 25 to 26 and Oct 29)

The launcher's bootstrap entries expire on their own; these environment entries do not, so remove them by hand once their run is done.

```sh
# Oct 25, before the O8 positive canary (a db-staging migrate from develop); it also serves the
# Oct 26 "Promote develop to staging" dry run. Remove it after the dry run, not before.
gh api -X POST repos/Conductia/Conductia/environments/db-staging/deployment-branch-policies -f name=develop -f type=branch
# Oct 29, before dispatching "Promote staging to main" from staging. Only db-production:
# e2e-staging's staging entry is O7's and permanent, so never add or remove it here.
gh api -X POST repos/Conductia/Conductia/environments/db-production/deployment-branch-policies -f name=staging -f type=branch
# Removal: db-staging's develop entry after the Oct 26 dry run, db-production's staging entry after
# the Oct 29 run. Find the entry's id, then delete it
gh api repos/Conductia/Conductia/environments/<env>/deployment-branch-policies --jq '.branch_policies[] | select(.name == "<branch>") | .id'
gh api -X DELETE repos/Conductia/Conductia/environments/<env>/deployment-branch-policies/<id>
```

If a run slips past its launcher expiry (`2026-10-25T23:59:59Z` for the canary, `2026-10-27T23:59:59Z` for the dry run, `2026-10-30T23:59:59Z` for the production run), extending it is a reviewed change to `deploy_allowlist` plus an apply.

### O7: create the `e2e-staging` environment (repo admin, by Oct 28)

```sh
gh api -X PUT repos/Conductia/Conductia/environments/e2e-staging \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
for b in staging main; do
  gh api -X POST repos/Conductia/Conductia/environments/e2e-staging/deployment-branch-policies -f name=$b -f type=branch
done
for s in E2E_BASE_URL E2E_SUPABASE_URL E2E_SUPABASE_PUBLISHABLE_KEY E2E_SEED_PASSWORD VERCEL_AUTOMATION_BYPASS_SECRET; do
  gh secret set $s --repo Conductia/Conductia --env e2e-staging
done
```

It blocks the Oct 29 smoke, not the Oct 26 run.

### O13: one CloudTrail trail (owner, Oct 24)

The account has no trail, so the audit rules see nothing until one exists. Coordinate with the discovery worker's module (thread X2) so the account keeps exactly one.

```sh
b=conductia-account-trail-368994863349
aws s3api create-bucket --region us-east-1 --bucket $b
aws s3api put-public-access-block --bucket $b --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-policy --bucket $b --policy '{"Version":"2012-10-17","Statement":[
  {"Sid":"AWSCloudTrailAclCheck","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:GetBucketAcl","Resource":"arn:aws:s3:::conductia-account-trail-368994863349","Condition":{"StringEquals":{"aws:SourceArn":"arn:aws:cloudtrail:us-east-1:368994863349:trail/conductia-account-trail"}}},
  {"Sid":"AWSCloudTrailWrite","Effect":"Allow","Principal":{"Service":"cloudtrail.amazonaws.com"},"Action":"s3:PutObject","Resource":"arn:aws:s3:::conductia-account-trail-368994863349/AWSLogs/368994863349/*","Condition":{"StringEquals":{"s3:x-amz-acl":"bucket-owner-full-control","aws:SourceArn":"arn:aws:cloudtrail:us-east-1:368994863349:trail/conductia-account-trail"}}}]}'
aws cloudtrail create-trail --region us-east-1 --name conductia-account-trail --s3-bucket-name $b \
  --is-multi-region-trail --include-global-service-events --enable-log-file-validation
aws cloudtrail put-event-selectors --region us-east-1 --trail-name conductia-account-trail \
  --advanced-event-selectors '[{"Name":"All management events","FieldSelectors":[{"Field":"eventCategory","Equals":["Management"]}]}]'
aws cloudtrail start-logging --region us-east-1 --name conductia-account-trail
```

The selector keeps read and write management events and does **not** exclude KMS events: without them, the App-key and key-change rules never fire. No data events. Check: `aws cloudtrail get-trail-status --name conductia-account-trail --query IsLogging` is `true`.

### O8: two canaries (Rob, Oct 25, after O2 to O5, O13 and O6's `develop` entry on `db-staging`)

1. **Negative.** A *Promote develop to staging* dispatch from a scratch branch:

   ```sh
   git push origin origin/develop:refs/heads/canary/deploy-refused
   gh workflow run promote-develop-to-staging.yml --repo Conductia/Conductia --ref canary/deploy-refused
   ```

   Expect no runner. On every tick while it is queued, expect a `deploy_tripwire` record with `reason: "not_allowlisted"` and the run's ids, a `deploy_hold` record with `admitted_waiting: 0`, and a `deploy_tick` record with `refused: 1` and `launched: 0`. Expect exactly one `conductia-deploy-runner-tripwire` email. No hold email: no admitted job waits. Then `gh run cancel <run id>`, `git push origin --delete canary/deploy-refused`, and check that the next tick shows `refused: 0` and no `deploy_hold`, and that the tripwire alarm returns to OK within a few minutes.
2. **Positive.** A no-op staging migration of a commit already on `staging`, served by the canary's bootstrap entry:

   ```sh
   gh workflow run migrate.yml --repo Conductia/Conductia --ref develop -f environment=db-staging -f ref=39c7d05a6d25e8661d72fa0405e2b0029fa2689c
   ```

   Expect a `deploy_tick` with `launched: 1`, the job on a `deploy-<12 hex>` runner, the #651 check green, nothing applied, preflight green, and the instance terminated afterwards. The job log shows `deploy-runner: toolchain ready` before the first workflow step, which proves the `.env` hook was armed. Time it (audit V3): the hook's wait counts against the job's `timeout-minutes`, so note the minutes from the job's start to `toolchain ready`. Every job that can run on a deploy VM allows 15 minutes (the promotions' plan, fast-forward and release jobs were 5), which covers the hook's 10-minute ceiling; if the wait is above 8 minutes, raise it before Oct 26. While it runs, record the runner's labels: `gh api orgs/Conductia/actions/runner-groups/<id>/runners --jq '.runners[] | {id, labels: [.labels[].name]}'`. If they differ from `runner_labels`, a reviewed change sets them. After the job, if a runner was left listed and idle, a later `deploy_tick` shows it deregistered (`deregistered: 1`) before its VM is terminated (`terminated: 1`), with no `error`. That terminate is the first proof that the role's `ReapOwn` condition matches. Nothing else carrying the deploy tag is touched.

Across both, expect no unknown-runner and no `served_refused` alert, and no hold email.

3. **GitHub call volume (audit V8).** Every tick reads the jobs of every queued and in-progress run in the repository, so its GitHub calls grow with CI load. The App's installation allows 5,000 requests an hour, about 83 a minute. During the canaries and again at a busy hour, read the counts: `aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/conductia-deploy-runner-launch --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern '{ $.message.event = "deploy_tick" }' --query 'events[].message' --output text | grep -o '"github_calls":[0-9]*' | sort -t: -k2 -n | tail -3`. Above 50 a tick at a busy hour, or any `deploy_blind` with `OutOfTime` or `GitHubError:403`, reaches for a rate or time limit: report it to the owner before Oct 29. The tick still fails closed: it holds rather than admits.

### O21: a named canceller for the release windows (Rob, by Oct 25)

For Oct 26 and Oct 29, name one person who watches the alert topic, holds `gh run cancel` rights on `Conductia/Conductia`, and knows the responses below. A deliberate, renewed freeze can only be made loud, not prevented, so this person is the control until F10. Escalation: Rob.

### Alert responses

Every alert names its alarm. The records behind it hold ids only; read them in the launcher's log:

```sh
aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/conductia-deploy-runner-launch \
  --start-time $(( ($(date +%s) - 3600) * 1000 )) \
  --filter-pattern '{ ($.message.event = "deploy_tripwire") || ($.message.event = "deploy_blind") || ($.message.event = "deploy_hold") || ($.message.event = "deploy_selfcheck") || ($.message.event = "deploy_unknown_runner") }' \
  --query 'events[].message' --output text
```

- **`conductia-deploy-runner-tripwire`, `reason` `not_allowlisted`, `expired`, `provenance` or `foreign_repo`.** A queued job that could take a deploy runner was refused, and the launcher holds all minting while it is queued. Read the run: `gh run view <run_id> --repo Conductia/Conductia`. If it is not a deploy run that should be served, cancel it: `gh run cancel <run_id> --repo Conductia/Conductia`. The hold lifts on the next tick. If it is a deploy run that should be served, the reason says why not: `expired` means a bootstrap entry passed its date (a reviewed allowlist change and an apply), `provenance` means its commit is not on its branch.
- **`conductia-deploy-runner-held-with-admitted-waiting`.** Minting has been held for 10 minutes while admitted deploy jobs wait: a release is blocked. Find the refused run in the tripwire records and cancel it as above. If it is queued again, the freeze is deliberate: cancel each new one, and escalate to Rob.
- **`conductia-deploy-runner-tripwire`, `reason` `served_refused`.** A deploy runner took a job of a run the launcher refuses (the race windows above). The job got an empty VM with no AWS role and none of the deploy environments' secrets. Cancel the run if it still runs, read who triggered it (`gh api repos/Conductia/Conductia/actions/runs/<run_id> --jq '{event, head_branch, actor: .actor.login, triggering_actor: .triggering_actor.login}'`), and keep the record. First check it is not a run that outlived its bootstrap expiry. Report a real one to the owner as an attempt.
- **`conductia-deploy-runner-tripwire`, `reason` `group_misconfigured`.** The runner group is missing, renamed, opened to other repositories or to public ones. Nothing is minted. Compare it with O2's check and restore it exactly.
- **`conductia-deploy-runner-tripwire` with a `deploy_blind` record.** The launcher could not read everything a check needs, and went on with what it read.
  - `scope: "queued"`: it could not see the whole queue, so it held: nothing is minted and idle minted runners are deregistered, exactly as for a refusal. Admitted deploy jobs wait until a tick reads the queue whole. A runner still booting for an admitted deploy is purged too, so on a flaky GitHub day an admitted job can see its runner minted, purged and minted again for a few minutes: `deploy_tick` alternates `launched: 1` with `deregistered: 1` and `blind`. It heals by itself once reads succeed; only `TooManyPages`, or `deploy_blind` on every tick for more than about 10 minutes, needs action (a release then also raises the hold alarm).
  - `scope: "posthoc"`: a deploy runner may have taken a refused job unseen. Read the deploy group's recent jobs by hand: `gh run list --repo Conductia/Conductia --limit 100 --json databaseId,event,headBranch,workflowName,createdAt`, then the jobs of any run that is not a deploy run (`gh api repos/Conductia/Conductia/actions/runs/<run_id>/jobs --jq '.jobs[] | select(.runner_group_name == "conductia-deploy") | {id, runner_id, runner_name}'`).
  - `error` says why: `TooManyPages` (more than 1,000 runs in one list, from a flood of runs or more than 1,000 completed runs created in 130 minutes; one comment on any issue or PR starts an AI-review run), `GitHubError:<status>` or `TimeoutError` (GitHub degraded), `OutOfTime` (the tick spent its 25-second read budget before reading everything; see O8 step 3). One isolated record with a 5xx or timeout is noise; a `TooManyPages`, or a record every tick, is not. While it repeats, look at who is starting runs (`gh run list --repo Conductia/Conductia --limit 200 --json event,workflowName,createdAt`) and cancel a flood.
- **`conductia-deploy-runner-tripwire` with a `deploy_selfcheck` of `run_instances: "denied"`.** The launcher role may not launch from the pinned template. Every launch would fail. Compare the role with the last reviewed apply; a change made outside an apply is the signal.
- **`conductia-deploy-runner-unknown-runner`.** A runner sits in the deploy group with no deploy VM the launcher launched. Only a holder of the App key or an org owner can register into the group, so treat it as a leaked key until shown otherwise. The launcher reports it and never deletes it (O18), so the record keeps its evidence.
  1. Read the records: `aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/conductia-deploy-runner-launch --start-time $(( ($(date +%s) - 3600) * 1000 )) --filter-pattern '{ ($.message.event = "deploy_unknown_runner") || ($.message.event = "deploy_tick") }' --query 'events[].message' --output text`. Two benign causes leave a runner the launcher minted with no VM. It is offline and not busy, and its id is the one the next ticks report. One: a `deploy_tick` a tick or two earlier whose `error` names both a failed launch and a failed delete (for example `InsufficientInstanceCapacity,GitHubError:503`). Two: a minute with **no** `deploy_tick` record at all, which is a tick killed at its 50-second timeout, possibly between minting and launching (audit V8). The tick's time budget makes that rare; Lambda's own `REPORT` line for that request shows `Status: timeout`. With either cause, delete the runner (step 2) and skip step 3.
  2. Save what GitHub holds on it, then delete it: `gh api orgs/Conductia/actions/runners/<runner_id> > unknown-runner-<runner_id>.json` and `gh api -X DELETE orgs/Conductia/actions/runners/<runner_id>`. If it is busy, cancel the run it serves first (`gh run list --repo Conductia/Conductia --status in_progress`, then `gh run cancel`).
  3. Unless step 1 showed the benign cause: revoke and rotate the App key. In the App settings, generate a new private key, store it as in O3 (`put-parameter --overwrite`), then delete every older key there. Until the old key is deleted, its holder can register again.
  4. Review the audit events (PR C) for reads of the App key and changes to the launcher in the hours before, and record what you find.
- **`conductia-deploy-runner-launcher-errors`.** The launcher failed 3 of its last 5 ticks. While it fails, nothing is minted, reaped or checked, and admitted deploy jobs sit queued with no tripwire. Read the error names: `aws logs filter-log-events --region us-east-1 --log-group-name /aws/lambda/conductia-deploy-runner-launch --start-time $(( ($(date +%s) - 900) * 1000 )) --filter-pattern '{ $.message.event = "deploy_tick" }' --query 'events[].message' --output text`, and look at `error`.
  - `ParameterNotFound`: the App key is not in SSM (O3).
  - `GitHubError:401`: the App key or the App ids are wrong, or the key was deleted in the App settings. Check `github_app_id`, `github_app_installation_id` and the App's keys (O3).
  - `GitHubError:403` or `GitHubError:404`: the App lost a permission, its installation, or the group. Compare with O3 and O2.
  - `GitHubError:5xx` or `TimeoutError`: GitHub is degraded. The alarm clears by itself when it recovers, and the recovery emails too.
  - `OutOfTime`: the group or runner reads alone took the tick past its 25-second budget. GitHub is slow; as for a 5xx.
  - `TooManyPages`: more than 1,000 runner groups, group repositories or group runners. None of these should be anywhere near that; compare the group with O2. (Too many runs is not here: it is a `deploy_blind` record on the tripwire alarm.)
  - Any other name, `AccessDeniedException` included: compare the role, the key policy and the function's configuration with the last reviewed apply. A change made outside an apply is the signal.
  - A failed minute with no `error` record: the invocation hit its 50-second timeout. Lambda's own report record for that request shows it.

  If it cannot be fixed before a release window, the way out is the Reversal below, which needs hosted budget (O9).

### Bumping the runner release (at least monthly)

Node and Playwright are pinned the same way. To move Node, read the new release's line from `https://nodejs.org/dist/v<version>/SHASUMS256.txt` (`node-v<version>-linux-x64.tar.xz`) and set `node_version` and `node_sha256`. `playwright_version` follows the repository's `@playwright/test` version: the module's tests fail until they match.

GitHub stops sending jobs to a runner too far behind the current release. Read the new asset's digest with `gh api repos/actions/runner/releases/tags/v<version> --jq '.assets[] | select(.name == "actions-runner-linux-x64-<version>.tar.gz") | .digest'`, open a PR setting `runner_version` and `runner_sha256` (without the `sha256:` prefix), and an admin applies it.

## Reversal

Delete `CI_RUNNER_DEPLOY`: newly queued deploy jobs go back to `ubuntu-latest`, which runs only with hosted budget headroom. To stop launching but keep the rest, apply with `launcher_enabled = false`. To remove the AWS side, an admin runs `tofu destroy` on `infra/deploy-runner/`; the App-key KMS key then waits out its 30-day deletion window. Remove the runner group and uninstall the App by hand.

## Follow-ups

Tracked in #680: secret rotation and short-lived database credentials, the Vercel token's scope, JIT runners for the shared fleet (F1), pre-launching a whole promotion's runners (F4), the promote App push and the `migrate.yml` actor guard (F7, a draft PR merged only after the first green production promotion), and structural job binding (F10). To file: a baked deploy AMI (F2), an egress allowlist (F3), a separate state bucket (F8), and an audit monitor in another account (F11).

## When to revisit

- **After the Oct 29 production run:** F7 and the ruleset on `main` and `staging` (O11, O12).
- **If GitHub rejects the `fromJSON` object in `runs-on`:** switch to a static `{group, labels}`.
- **If the organization moves to Enterprise:** "selected workflows" on the group closes the race windows structurally.
