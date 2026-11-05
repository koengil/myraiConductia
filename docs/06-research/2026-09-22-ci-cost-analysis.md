# Conductia GitHub Actions cost analysis

Analyzed September 22, 2026. Start with lockfile-only audits, selective CI for documentation changes, and a smaller Supabase stack. Benchmark shared database setup and ARM runners next. Preserve the existing merge and release checks while doing this.

## Evidence and limits

This analysis covers `Conductia/Conductia`, not the separate agents backend repository. The checkout is ten commits behind `develop`, so recommendations use **`origin/develop` at `9a8ec08ecaba7f408072ca5ffa1a2513ece485f1`**, verified against the live remote with `git ls-remote`. No branch was updated and no workflows were changed.

GitHub's repository and Actions APIs returned HTTP 404 for the available CLI identity, `cwillian-lp`; no authenticated browser was available. Consequently, run durations, retry counts, cache hit rates, billing, repository visibility, and live rulesets could not be verified. Expected impact below describes eliminated work, not measured dollar savings. The delivery documentation says the organization uses GitHub Team; its current subscription and shared allowance remain unverified.

Primary repository evidence:

- [CI workflow](https://github.com/Conductia/Conductia/blob/9a8ec08ecaba7f408072ca5ffa1a2513ece485f1/.github/workflows/ci.yml): four parallel Linux jobs, each installing the same dependencies; two Supabase startups and resets; one explicit Next.js build.
- [Playwright configuration](https://github.com/Conductia/Conductia/blob/9a8ec08ecaba7f408072ca5ffa1a2513ece485f1/playwright.config.ts): another Next.js production build inside hermetic E2E, with different environment variables; one worker and one CI retry.
- [Live E2E workflow](https://github.com/Conductia/Conductia/blob/9a8ec08ecaba7f408072ca5ffa1a2513ece485f1/.github/workflows/e2e-live.yml): runs on `develop` pushes, manual dispatch, and a nightly schedule where active on the default branch. A missing target skips expensive steps after runner startup.
- [Delivery model](https://github.com/Conductia/Conductia/blob/9a8ec08ecaba7f408072ca5ffa1a2513ece485f1/docs/03-engineering/delivery-model.md): all four CI checks required on up-to-date PRs; squash into `develop`, then fast-forward release to `main`.

A full successful CI execution performs **four installs, two Supabase startups/resets, and two Next builds**. The workflow runs on PRs and pushes to both `develop` and `main`. A completed PR execution followed by a completed post-merge execution repeats that workload; cancellations and early failures can reduce it. This is a work-count observation, not a runtime measurement.

## Recommendations, in implementation order

### 1. Remove the install from the dependency-audit job

Keep checkout, Node setup, the existing required check name, and both audit policies. Replace the commands with:

```sh
npm audit --package-lock-only --omit=dev --audit-level=moderate
npm audit --package-lock-only --audit-level=moderate
```

Keep the second audit nonblocking. Remove `npm ci` and unnecessary npm cache restore/save from this job. Use `npm ci --no-audit` in the other CI jobs once the explicit security gate remains authoritative; that removes redundant install-time advisory requests without changing dependency installation.

**Verified locally:** copied the remote revision's package manifest and lockfile into an empty temporary directory. The production lockfile audit completed in 0.98 seconds, exit 0, no vulnerabilities reported, and no `node_modules` created. This verifies the command works without installation; it is not a GitHub runner benchmark or a full-tree audit result. [npm audit reference](https://docs.npmjs.com/cli/v11/commands/npm-audit/).

Expected saving: one complete dependency installation per full CI execution, plus associated caching overhead. Low effort. Pilot this job on `ubuntu-slim` after checking setup-action compatibility.

### 2. Skip expensive work for proven documentation-only changes

The workflow has no change detection, so README and planning edits currently trigger database and browser work. Add a small change-classification job. Start with a narrow allowlist of documentation paths; unknown paths should run full CI. Do not classify every `*.md` as documentation: this repo has Markdown test fixtures and skill content.

Keep the workflow itself triggered and preserve all required check names. Conditional jobs or explicit gate jobs must distinguish intentional skips from failed change detection, failures, and cancellations. Use the PR's complete merge-base diff; for pushes use the full before/after range, including multi-commit pushes. Fall back to full execution when that range is unavailable. Top-level `paths-ignore` can leave required checks pending. [GitHub required-check behavior](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).

Expected saving: almost all heavy-job time for eligible documentation runs, minus classification/check overhead. Keep the cheap security audit running to detect newly published advisories even without a lockfile change. Medium effort; validate both a docs-only PR and a source-changing PR against the actual ruleset.

### 3. Reduce Supabase startup work

Both database-backed jobs start the full configured stack. The [configuration](https://github.com/Conductia/Conductia/blob/9a8ec08ecaba7f408072ca5ffa1a2513ece485f1/supabase/config.toml) enables Studio, analytics, and the edge runtime alongside the services needed by tests. Trial excluding Studio, analytics/logging, and edge-runtime services using the pinned CLI's `--exclude` support. Confirm each candidate is unused before keeping the exclusion. Preserve Auth, PostgREST, gateway, database, and any storage services required by migrations or tests. [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-start).

Also benchmark whether `supabase db reset --local` is redundant immediately after a fresh startup: first startup already applies migrations and seed data. Retain it unless the pinned CLI produces identical schema-snapshot and test results without it. Keep reset coverage where explicitly needed. [Supabase seeding lifecycle](https://supabase.com/docs/guides/local-development/seeding-your-database).

Expected saving: fewer image downloads and service startups, potentially one migration replay per database job. Preserve schema-snapshot verification and both SQL regression checks added in the latest revision. Medium effort.

### 4. Share database setup if it dominates run time

Prototype integration and hermetic E2E as sequential stages on one runner. This removes one Node setup/install and one Supabase startup. Reset/reseed between suites if needed to maintain isolation; preserve integration cleanup and E2E failure reporting. The combined job may need a revised timeout.

Tradeoff: total runner minutes can fall while PR completion time rises because two previously parallel suites become sequential. Measure both. Changing job structure must preserve required checks or coordinate the corresponding ruleset change; do not simply delete the integration gate.

Expected saving: duplicated setup minus isolation-reset and reporting overhead. Medium effort, conditional on actual timings.

### 5. Address the two Next builds carefully

The verify job builds under its ordinary CI environment; Playwright builds with hermetic auth, storage, mail, and service-stub settings. `NEXT_PUBLIC_*` values are compiled into the browser bundle, so copying the ordinary build into E2E is not equivalent.

First benchmark build caching separately for each environment. The project uses Next 16/Turbopack; official documentation currently describes production filesystem caching as experimental and opt-in. Confirm behavior with the pinned version before assuming that restoring `.next/cache` helps. Cache keys should separate architecture, Node/lockfile versions, build configuration, and environment; restore prior compatible source revisions and save updated caches. Measure transfer overhead and warm-build benefit. [Next CI caching](https://nextjs.org/docs/app/guides/ci-build-caching), [Turbopack filesystem caching](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache).

Removing the verify build would eliminate one build per execution, but also remove its different-environment coverage. Treat that as a test-policy decision, not an automatic deduplication. Medium effort.

### 6. Benchmark runner changes after removing redundant work

At the current standard Linux rates, ARM64 is $0.005/min versus x64 at $0.006/min: **16.7% cheaper for equal rounded runtime**, with break-even at 20% longer runtime. Start with verify; validate native Node dependencies before database and browser jobs. Standard ARM supports private repositories. [GitHub pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), [private ARM availability](https://github.blog/changelog/2026-01-29-arm64-standard-runners-are-now-available-in-private-repositories/).

`ubuntu-slim` costs $0.002/min and suits short audit/change-classification jobs. It has one CPU, a 15-minute cap, and no privileged Docker support; do not move local Supabase jobs onto it. Do not assume it improves build or browser costs. [Runner constraints](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Preserve these existing optimizations and guarantees

- PR concurrency cancellation and npm download caching are already configured. Recommending them as new savings would double-count existing behavior.
- Hermetic artifacts upload only on failure and expire after seven days. Live artifacts expire after fourteen days. Storage is a secondary candidate until measured.
- Keep post-merge `develop` verification initially: it was added September 22, and the delivery model uses checks on the actual integration SHA for release policy. PR merge checks and squash-commit checks are not automatically interchangeable.
- Live E2E deliberately serializes shared mutable state and preserves the active run. Changing it to nightly-only reduces attribution to individual merges. If considered, first verify that the nightly runs on the intended deployed target and measures meaningful coverage.
- Do not shard the browser suite solely to lower cost: sharding repeats installation, browser, database, and build overhead. Playwright also cautions that caching browser downloads can cost as much time as downloading them. [Playwright CI guidance](https://playwright.dev/docs/ci#caching-browsers).
- Avoid self-hosted infrastructure until measured volume justifies machine, maintenance, and isolation costs.

## How to quantify the result

Collect 30 days of jobs, including every rerun attempt, classified by workflow, job, event, conclusion, runner, and changed-file category. Sum each job's rounded billable minutes rather than workflow wall time. Record step durations, cache hits, browser retries, and artifact byte-days. Compare representative before/after samples and check that failure rates and required-check behavior remain stable.

For a hypothetical 500 full executions/month, saving two billed x64 minutes per execution removes 1,000 minutes, worth **$6 at the overage rate**. This is an illustration, not a forecast. Public standard compute is free; private usage first consumes the owner's shared plan allowance. Actual invoice savings can therefore be zero even when runner usage falls. See the [pricing research](2026-09-22-github-actions-pricing-research.md) for rates, rounding, included usage, and storage details.

Recommended first batch: lockfile-only audits, `--no-audit` installs elsewhere, and narrowly scoped documentation skips. Then use measured Supabase/build timings to choose the next change.
