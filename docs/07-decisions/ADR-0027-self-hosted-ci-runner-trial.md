# ADR-0027: Self-hosted CI runner trial on EC2, after the Actions billing outage

Status: Accepted (owner decisions, 2026-10-20). **Trial tier:** one week of measurement, then a decision at the end of October. Internal engineering infrastructure. No bank data or bank-facing control is involved.
Related: decision-log D104. *Later:* D117 amends "staging and production stay GitHub-hosted": both promotion paths run on just-in-time runners in `conductia-deploy`. PR #630 (opt-in pre-push hook). Parked branch `ci/targeted-heavy-jobs`. #527 (AI review as a merge gate). `.github/workflows/ci.yml`. `infra/discovery-worker/` (the OpenTofu pattern to follow).

## Bottom line

- **The problem.** GitHub Actions spent $198 net in Oct 1–20 (35,953 Linux minutes), against $48 for all of September. The spending limit was reached at about 18:00 UTC on Oct 19, and every CI run has failed since.
- **The trial.** CI moves to a fleet of four one-runner EC2 instances. They are **on-demand**, sit in the **existing AWS account** and are **defined entirely in IaC** (`infra/ci-runner/`, #632), so the fleet can move to a dedicated CI account later without being rebuilt.
- **The switch is two repository variables**, not a code change. Jobs read `runs-on` from `vars.CI_RUNNER_HEAVY` or `vars.CI_RUNNER_LIGHT` (#631), so moving between GitHub-hosted runners and the fleet is a variable flip. Deleting them sends future jobs back to GitHub-hosted runners, which run only once the hosted budget allows.
- **One runner per instance.** The Supabase CLI, Next and the test stubs bind fixed host ports, so two integration or E2E jobs on one host would collide. Separate instances avoid that, and each can be sized and started on its own.
- **Alerting when the box needs a human is parked** until the team picks a channel: Slack, ntfy or email.
- **Measure first, then decide.** The first full-suite performance test runs tonight, while the rest of the team (4 hours ahead) is offline. The trial week is then compared against the Oct 1–20 baseline at month end.

## Context: what the data showed

The data covers Conductia/Conductia, Oct 1–20, from the GitHub billing API and the run and job history.

- **Volume.** There were 1,103 CI runs, 990 of them from pull requests, against 188 PRs opened Oct 5–20. That's about 5 runs per PR and about 26 billed minutes per run.
- **Where a run's minutes go:**

| Job | Share of a run's billed minutes |
|---|---|
| E2E (hermetic) | 33% |
| Integration (local Supabase) | 19% |
| Vitest | 17% |
| Lint/build | 9% |

- **Why CI re-ran on a PR.** Of 33.8k PR CI minutes:

| Cause | Share |
|---|---|
| First run | 23% |
| After a review or comment | 20% |
| After a red run | 10% |
| A push with no new input since the last run | **46%** |

  The 46% is an upper bound, because local review never shows on GitHub.
- **Bursts.** At least one job was running only 17% of the time. When busy, the median was 5 jobs at once, the 90th percentile 18 and the peak 76. Bursts of 10 or more jobs held 65% of job-minutes; 73% of those came from one engineer's agent sessions, and 93% were `pull_request` events. That is the release-and-rebase pattern: when a stack is unlocked, every PR in it re-runs.
- **Demand timed from PR opening is spread out.** If each PR ran one full CI when it was opened, the 20 days would need about 10.3k minutes. On 4 runners the average queue wait would be 6 minutes (90% under 19); on 6 runners, 3 minutes (90% under 9). The same replay of what actually happened gives 83 and 30 minutes. A box of 4–6 runners therefore fits once runs per PR fall.
- **Targeted suites save little here.** Running E2E only for UI changes and integration only for DB changes would skip about 4% of CI minutes. 39 of 101 merged PRs touched `src/app/api`, 38 touched migrations and 26 touched `ci.yml`, and each of those has to run both suites. The branch is parked.

## Decision

1. **Trial a self-hosted fleet on EC2, on-demand.** On-demand keeps the trial's measurements free of spot interruptions. Spot is reconsidered after the trial. The trial stays on x86 (owner, 2026-10-20). The hosted baseline is x86, and AMD instances already cost about 10% less than Intel; Graviton would save only another 6–10% and adds compatibility risk.
2. **Use the existing AWS account (368994863349), with everything in IaC** (OpenTofu, following `infra/discovery-worker/`). Migrating to a dedicated CI account is then a re-apply with new account variables. CI runs PR code, so the box gets its own VPC or subnet, no route to the discovery worker's resources, and an instance role limited to what the runner needs (registration and logs).
3. **One runner per instance, in two sizes** (owner, 2026-10-20). Four heavy-capable m6a.xlarge (4 vCPU / 16 GB, labels `conductia-ci-heavy` and `conductia-ci-light`), split into two `heavy` and two `burst`, and two `light` m6a.large (2 vCPU / 8 GB, `conductia-ci-light`). The base runners (`heavy`, `light`) stop themselves after 15 minutes idle and the `burst` runners after 10 (owner, 2026-10-20; it was 40 for all). A wake Lambda, run every minute, starts stopped instances when jobs queue, `burst` only after the `heavy` runners are up or busy. The idle window is an instance tag, so changing it is a retag, not a replacement. The disks keep the caches across stops. The heavy-capable class started at two and went to four after the calibration burst of 2026-10-20 (6 PRs, 44 jobs): E2E and integration waited a median of 14 minutes, up to 24, behind two heavy runners (owner, 2026-10-20, #634).
4. **Choose runners with repository variables.** Jobs use `runs-on: ${{ vars.CI_RUNNER_HEAVY || 'ubuntu-latest' }}` or `vars.CI_RUNNER_LIGHT`, falling back to `ubuntu-latest` or `ubuntu-slim`. Everything moves except staging and production (owner, 2026-10-20): `e2e-live-smoke`, both promote workflows, and `migrate` unless it targets `db-dev`, stay GitHub-hosted. Rollback is: delete the variables.
5. **Place jobs by cache benefit.** A persistent box keeps the npm cache, the Supabase Docker images and the Playwright browsers warm, so the heavy jobs (integration, E2E) gain the most. While the hosted budget is exhausted, every job in scope (decision 4) runs on the fleet. The out-of-scope staging and production jobs wait for the hosted budget.
6. **Alert a human when the box needs intervention, but the channel is parked.** The triggers are a runner offline, the disk nearly full, queue waits beyond a threshold, or a job failing for infrastructure reasons rather than test reasons. Which channel (Slack, ntfy or email) and who receives it are for a team discussion (owner, 2026-10-20). Until then, the trial is watched by hand.
7. **Measure in three steps.**
   - Tonight, run the full suite on the box to calibrate job duration and how many concurrent jobs one box sustains.
   - Run the trial for one week.
   - At month end, compare per merged PR against the Oct 1–20 baseline.
8. **Day-0 check.** Confirm that a self-hosted job runs while the hosted spending limit is exhausted. GitHub's docs say self-hosted runners aren't metered, but none states this case explicitly.

**Alongside, not part of this ADR's infrastructure:**

- PR #630: an opt-in pre-push hook that catches red runs before the push.
- Draft-until-ready for agent sessions: E2E and integration already skip on drafts, so marking a PR ready once ends the repeated heavy runs.
- AI review (#513 to #527) runs on every non-draft push to a PR into `develop`, on the light fleet (`vars.CI_RUNNER_LIGHT`), so it adds runner time. It may reduce overlap by catching problems before rebase waves. The trial measures this rather than assuming it. It only runs once `ai-review.yml` is on `main`. A `pull_request_target` run uses the default branch's copy of the workflow ([GitHub changelog, 2025-11-07](https://github.blog/changelog/2025-11-07-actions-pull_request_target-and-environment-branch-protections-changes/)). A `workflow_dispatch` run needs the workflow on the default branch, and can then run it from a selected branch such as `develop` ([manual runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)). Until a promotion carries it to `main` (owner item, weekly review of 2026-10-23), it does not run.

## As built (2026-10-20)

- **Access.** A CI-only IAM user, `conductia-ci-operator`, with a policy scoped to `ci-runner` resources, created once with the wave-6 key. State lives in its own bucket, `conductia-ci-runner-tfstate-<account>`.
- **Secrets.** Only the wake Lambda reads the GitHub token (`/conductia/ci-runner/github-pat`). It keeps a one-hour runner registration token in SSM, and instances can read only that. An explicit deny covers every other parameter, because `AmazonSSMManagedInstanceCore` allows `ssm:GetParameter` on `*` and jobs are root-equivalent on the host through Docker.
- **Network.** Its own VPC, `10.60.0.0/16`, with a public subnet, no ingress and no SSH key. Access is through SSM Session Manager.
- **Day 0.** Self-hosted jobs run while the hosted spending limit is exhausted. Two gaps with GitHub's image were fixed: job hooks run under `bash -e`, and Node has to be on the `PATH`. Warm-cache durations against the hosted medians:

| Job | Fleet | Hosted |
|---|---|---|
| E2E | 7.4 min | 13.0 |
| Integration | 5.3 min | 6.6 |
| Lint/build | 2.4 min | 3.2 |
| Vitest | 7.5 min | 8.3 |

- **Memory peaks.** Lint 2.4 GB, Vitest 2.8 GB, E2E 2.4 GB, integration 1.5 GB. A smaller class for lint and the small jobs (t3a.medium, 4 GB) is proposed after calibration.

## What the trial records each day

- **Jobs and minutes**, self-hosted vs hosted, from each job's runner name and labels.
- **Queue wait** (job created → started), self-hosted vs hosted.
- **Duration of the same job** on the box vs hosted, to measure the cache benefit.
- **Failures and timeouts on the box**, and every time a human had to step in.
- **Box cost**, from a tagged instance in Cost Explorer, plus the Actions net dollars per day from the billing API.

## Costs

- **Hosted, current pace:** about 55k minutes and $320 for October. Target: under $180 a month (a win), under $120 (a big win).
- **The fleet, on-demand** (us-east-1 list prices on 2026-10-20: m6a.xlarge $0.1728/h, m6a.large $0.0864/h). These monthly figures come from replaying Oct 1–20 jobs on four instances with a 40-minute idle stop:

| Demand | Instance cost per month |
|---|---|
| Today's habits | about $157 |
| Natural runs only (first run, after feedback, after a red run) | about $120 |
| One run per PR | about $93 |

  Add about $35 a month for disks, public IPs and the Lambda. A shorter idle stop, spot and fewer runs per PR are the levers.
- **GitHub's self-hosted fee:** GitHub announced a $0.002/min platform fee for self-hosted runners from March 2026. Sources disagree on whether it took effect (UNVERIFIED). If it's live, a month at the current volume adds about $100, and about $20–60 at the volume the levers above aim for.

## Risk and regulation

- **No regulation mandates any part of this.** It is internal build infrastructure.
- **The main risk is account co-tenancy.** CI runs code from PR branches in the account that hosts the discovery worker. Network separation and a minimal instance role reduce that risk, and migrating to a dedicated account is the fix (see "When to revisit").
- **`pull_request_target` and token-bearing jobs on persistent hosts (accepted for the trial; owner, 2026-10-20).** The three AI review jobs (review, finalize, override) run on the light fleet. Only `review` receives the Claude token; all three receive the App token once it is set. The check was made: the workflow and its scripts come from the base branch, every reviewer checkout pins `develop`, the PR head is read as plain files in `pr/` with symlinks removed, and nothing from it is installed, built or run (#527). The remaining risk is the host itself. CI jobs from PR branches are root-equivalent through Docker, and the instances persist between jobs, so a malicious change could tamper with a host and read a later job's secrets. This is accepted for the trial because the repository is private and only the team pushes. Revisit after the trial with any of these: AI review on its own runner class, ephemeral re-imaged instances, or AI review back on GitHub-hosted runners.

## Alternatives considered

- **Stay on GitHub-hosted runners and trim usage.** This stays as a parallel track (#630, draft-until-ready). It alone does not end the outage.
- **AWS CodeBuild as the runner.** About $0.005/min against GitHub's $0.006. The saving is too small to justify a migration.
- **Ephemeral spot runners scaling per job** (the philips-labs module). Cheapest per minute, with isolation per job. Reconsidered after the trial: on-demand was chosen for measurement quality.
- **Actions Runner Controller on EKS.** The control-plane cost and Kubernetes operations aren't justified at this scale.
- **Targeted suites.** About 4% saving at today's PR shape. Parked.

## Reversal

Delete `vars.CI_RUNNER_HEAVY` and `vars.CI_RUNNER_LIGHT`: newly queued jobs use GitHub-hosted runners again (a job already queued for the fleet can still start there), which run only once the hosted budget is raised or resets. Then `tofu destroy` the runner stack. No application code or data depends on the fleet.

## When to revisit

- **At month end:** keep, resize, switch to spot or ephemeral, or drop. The comparison is per merged PR against the baseline above.
- **When a dedicated CI AWS account exists:** migrate by re-applying the IaC there.
- **If GitHub's self-hosted fee is confirmed live:** recompute the comparison.
