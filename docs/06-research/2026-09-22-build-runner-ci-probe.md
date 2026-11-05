# Next build cache and runner feasibility probe

Measured on 2026-09-22 against `c05d1306d4e8a9c3d442703ec064730d00ee0126` (the workspace's latest `origin/develop` base when this probe started). No tracked Next configuration or runner labels were changed.

## Decision

Keep the existing runners and separate verification/hermetic builds. Local cache reuse works, but Actions transfer time, hit rate, rounded job minutes, Linux compatibility, and variability still need hosted measurements before rollout. These results are local feasibility samples, not historical Actions runtimes or invoice savings.

The repository pins Next **16.3.5**, whose installed `next/dist/server/config-shared.js` sets `experimental.turbopackFileSystemCacheForBuild: true`. The [Next 16.3 release announcement](https://nextjs.org/blog/next-16-3#faster-builds) confirms build disk caching is enabled by default. Earlier [general caching documentation](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopackFileSystemCache) describes it as an experimental opt-in; that advice does not establish the default for this pinned release. An explicit opt-in was tested only in the temporary checkout; it is redundant here.

## Method and limits

- Machine: Darwin 25.6.0 / macOS arm64, Apple M4 Max, 14 logical CPUs, 36 GiB RAM. Node 22.15.0, npm 10.9.2, Next 16.3.5.
- Created a temporary `git archive HEAD` checkout and copied installed `node_modules` using APFS clone copies. No symlinked dependency root, `.env.local`, or original-checkout files were used. Dependency install time is excluded.
- Timed `npm run build` with Python's monotonic clock, `CI=1`, `NEXT_TELEMETRY_DISABLED=1`, and inherited application configuration removed. Ordinary verification builds therefore have the workflow's unconfigured Supabase behavior.
- Each cold sample removed all `.next`; its warm follow-up retained **only** `.next/cache`, removing every other `.next` entry before building. Every sample recompiles/builds the application; no deployable artifact is reused.
- The explicit-opt-in pair adds only `experimental: { turbopackFileSystemCacheForBuild: true }` to the temporary Next configuration. The hermetic pair restores the repository configuration and clears all `.next` before its cold run.
- Hermetic compile samples import the actual third Playwright `webServer.env` block and add the isolated local Supabase stack's public URL, publishable key, and service key, plus the CI invitation pepper. They do not start Playwright or either stub server. This is build/cache validation; browser journeys and database correctness are validated separately.
- One observation per condition; no attempt to isolate OS file cache, thermal conditions, or concurrent agent work. Other local unit/database/E2E tasks overlapped, so comparing explicit opt-in with the identical default is especially meaningless. This Mac's CPU and RAM differ substantially from GitHub's Linux runners.

## Measurements

| Build configuration | Cache state | Total seconds | Compiler seconds | TypeScript seconds | Cache MiB | Exit |
|---|---|---:|---:|---:|---:|---:|
| Verification, current default | cold | 48.521 | 14.5 | 19.7 | 149.6 | 0 |
| Verification, current default | warm | 11.070 | 1.945 | 3.9 | 150.9 | 0 |
| Verification, explicit opt-in | cold | 31.277 | 11.5 | 14.8 | 148.5 | 0 |
| Verification, explicit opt-in | warm | 23.521 | 5.2 | 12.1 | 149.5 | 0 |
| Hermetic, current default | cold | 70.684 | 20.8 | 46 | 148.5 | 0 |
| Hermetic, current default | warm | 5.054 | 1.208 | 2.0 | 149.6 | 0 |

Cache sizes are allocated disk usage from `du -sk`, converted to MiB. The cold/warm separation is about `.next/cache`, not a clean machine or cold npm/network caches. Ordinary verification samples emitted the existing fail-closed unconfigured-Supabase flag warnings and still completed successfully.

The final hermetic cache compressed locally with `tar` plus `zstd -T0` to **114,317,699 bytes (109.0 MiB)** in **0.286s**. This is archive creation only, not an Actions upload/download measurement or its exact compression configuration.

## Hosted cache experiment before rollout

1. Run matched baseline/cached pairs on the same commit and Linux runner image, with at least five repetitions plus a representative source edit and lockfile change. Include install, cache restore/save, build, tests, retries, and job-level billed rounding.
2. Persist only `.next/cache`, with separate verification and hermetic namespaces. Include OS/architecture, Node/Next and lockfile/config identity, plus the compile-time environment identity. Do not put secret values in keys. Restore fallback must never cross a build mode/environment namespace.
3. Keep `npm run build` in verification and Playwright's `npm run build && npm run start` in hermetic E2E. Their compile-time public variables and server flags differ; never substitute either build's artifacts for the other.
4. Exercise changed `NEXT_PUBLIC_*` values, changed Next configuration, dependency updates, cold misses, and failed/partial cache saves. Run all existing verification, integration, and hermetic assertions; compare emitted public configuration and behavior.
5. Record compressed cache sizes, restore/save seconds, hit rates, and eviction/storage use. Adopt only if total measured job cost improves without correctness or reliability regressions. Local warm speed alone excludes remote cache overhead.

## ARM and slim runners

No runner switch was applied. The installed Playwright 1.56.0 registry contains Chromium and Chromium headless-shell downloads for `ubuntu24.04-arm64`; Next/SWC runs successfully on this Mac's arm64. These are compatibility clues, not proof of Linux ARM compatibility for the complete workflow. Audit every native npm dependency, pinned Supabase CLI binary and container image, browser/system package, SQL client, and action on actual `ubuntu-24.04-arm`.

GitHub documents `ubuntu-slim` as a one-core, 5 GB container runner with a 15-minute limit and no Docker-in-Docker/privileged operations. It is unsuitable for the Supabase integration and hermetic jobs. The install-free audit and change detection are possible later candidates; a full Next/typecheck/test job also needs demonstrated memory/time headroom. [Hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

For an authorized hosted benchmark, use matched x64/ARM jobs with the identical commit, complete coverage, pinned tooling, independent databases and cold/warm cache conditions; run audit/change detection on slim separately. Capture architecture, image, setup duration, total runtime, peak memory, all failures/retries, and full validation results. Do not use emulated Docker on this Mac as an ARM runner timing proxy.

Current standard Linux rates are $0.006/minute x64, $0.005 ARM64, and $0.002 slim, with each job rounded up to a minute. Therefore the derived ARM break-even is `ceil(ARM seconds / 60) < 1.2 × ceil(x64 seconds / 60)`; slim's is below 3× x64 billed duration. These formulas are decision thresholds, not measured savings; allowances and public-repository eligibility determine actual charges. [Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).

Historical Actions/billing access remains unavailable with the supplied account. No hosted experiment, external setting change, workflow dispatch, deployment, or PR was performed by this probe.
