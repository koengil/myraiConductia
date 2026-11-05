# GitHub Actions cost facts and optimization constraints

Verified against official GitHub sources on **2026-09-22**. The tool clock returned `2026-09-22 19:17:43 UTC`, matching the environment's date; no date discrepancy was observed. This is platform research, not an invoice or a measurement of Conductia's usage.

## Compute pricing

GitHub rounds **each job** up to a whole minute. Estimate gross compute as `sum(ceil(job_seconds / 60) × runner_rate)`, including repeated attempts. Workflow wall-clock duration is not a cost proxy when jobs run concurrently. Current standard hosted rates: [GitHub runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).

| Standard runner | USD/minute |
|---|---:|
| Linux x64, 2 cores | $0.006 |
| Linux ARM64, 2 cores | $0.005 |
| Linux x64, 1 core (`ubuntu-slim`) | $0.002 |
| Windows x64 or ARM64, 2 cores | $0.010 |
| macOS standard | $0.062 |

Public repositories receive free standard hosted compute. Private repositories draw from owner-level monthly allowances: Free 2,000 minutes, Pro/Team 3,000, Enterprise Cloud 50,000. Larger runners always incur charges and cannot consume included minutes. Savings estimates should distinguish gross usage reduction from cash savings after allowances. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Derived comparison, assuming equal rounded runtime: ARM64 saves 16.7% against Linux x64; slim saves 66.7%. ARM remains cheaper only below 1.2× the x64 billed duration; slim below 3×. Benchmark before switching, and account for extra setup time and failures. Larger 4-core Linux x64 costs $0.012/min, so it must more than halve billed runtime to beat standard x64 outside the allowance. [Runner rate card](https://docs.github.com/en/billing/reference/actions-runner-pricing).

## Runner eligibility and limitations

- **`ubuntu-slim`:** available in public and private repositories; 1 CPU, 5 GB memory, 14 GB disk; container-based, minimal tooling, and a hard 15-minute job timeout. It cannot run Docker-in-Docker or operations needing privileged kernel access. Consider short metadata, audit, and automation jobs; Docker-based local Supabase integration is unsuitable. [Hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- **ARM64:** standard Linux ARM runners have supported private repositories since January 29, 2026, with two CPUs and included-minute eligibility. `ubuntu-24.04-arm` and `ubuntu-22.04-arm` are supported labels. Older advice claiming these are public-only is obsolete. Before migrating, verify native npm packages, downloaded binaries, browser tooling, and Docker image architectures against the actual job; these compatibility checks are recommendations, not claims that Conductia currently fails on ARM. [Private ARM launch](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/).

## Storage and retention

Artifact/Packages storage shares an owner-level allowance; cache has a separate 10 GB allowance per repository. Overage is $0.25/GB-month for artifact/Packages storage and $0.07/GB-month for cache. Artifact storage accrues hourly; deleting artifacts stops future accrual without reversing prior usage. Cache overage requires a configured limit above 10 GB. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Caches unused for over seven days are evicted. Avoid continually unique keys for large caches: eviction can erase the expected runtime benefit. Increasing cache capacity may help, but measure hit rates and minutes saved against additional storage. [Dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

Default artifact/log retention is 90 days; configurable limits are 1–90 days for public repositories and 1–400 for private repositories. Settings changes apply to new objects. Prefer a short `retention-days` on disposable test artifacts to lowering all historical evidence retention. **Upcoming change:** from October 1, 2026, the shared retention policy also applies to checks, workflow runs, and commit statuses, so a blanket reduction has broader effects. [Retention settings](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization).

## Avoid wasted work without weakening required checks

Use workflow-level concurrency scoped by workflow and PR/ref, with `cancel-in-progress: true`, to stop obsolete CI runs. Concurrency alone replaces pending work but does not cancel running work without that flag. Keep deployment concurrency separate because canceling an active deployment has different consequences. [Concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

Do not add top-level path filters to a workflow that must report required checks: skipped workflows leave those checks pending and can block merging. Job-level conditional skips report success. A robust selective-CI design keeps an always-triggered workflow, detects affected paths, and preserves required-check names. If a required aggregate job depends on other jobs, use `always()` and explicitly fail for relevant failed/canceled dependencies; otherwise a skipped downstream job can accidentally permit merging. [Required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Prioritize eliminating redundant runs and avoidable setup before changing runner hardware. Measure total rounded job minutes, job failure/retry rates, queue time, cache hit rates, and artifact GB-days. Compare representative before/after samples; do not claim invoice savings without the owner's plan and metered usage.
