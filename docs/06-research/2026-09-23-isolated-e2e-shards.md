# Isolated E2E shards — reverted experiment

**Decision:** revert sharding and restore the single E2E job with one worker. Keep the registry fallback fix, retry-only hermetic recordings and earlier cost reductions. The sections below retain the experiment's design and validation history.

[Hosted run 35916405934](https://github.com/Conductia/Conductia/actions/runs/35916405934) on `9bfa4533` passed every required check after restoring registry fallback. Shard 1 passed 25 tests with three existing skips in 7m50s; shard 2 passed 22 with one existing skip in 6m45s. Neither retried a test. Including aggregate scheduling/execution, E2E completed in 7m57s versus the preceding 10m42s, approximately 26% faster. Per-job rounded E2E runner minutes increased from 11 to 16; these are estimates from job durations, not billing data.

The unchanged verification job remained the bottleneck at 11m03s versus the preceding 10m52s. One run does not attribute that variation to sharding or establish a whole-pipeline speedup. The extra setup/build cost did not serve the original CI cost goal, so the user requested the revert. No tests, assertions or isolation guarantees are removed: the complete hermetic suite runs sequentially against its own local database again.

## Measurement and decision

The preceding change (`c36a3da`) already moved hermetic CI trace/video recording to the first retry and kept one worker. [Hosted run 35801618621](https://github.com/Conductia/Conductia/actions/runs/35801618621/job/106993195516) passed all 42 active tests, with four existing skips and no retries, in **10m42s**. Its browser/setup/cleanup phase took **6m34s**; Next build/server startup took about one minute and the remaining runner/database/dependency setup about three minutes. Verification completed in 10m52s, so E2E acceleration alone does not guarantee faster overall CI.

The earlier two-worker experiment shared mutable database, stub and filesystem state and failed (see [the prior follow-up](2026-09-22-e2e-runtime-followup.md)). It is not reused. There are no substantial fixed sleeps to remove from the active hermetic tests: the visible multi-second sleeps belong to live-only skill enhancement; the TOTP boundary guard and inbox polling are correctness waits.

This follow-up starts with **two shards**, with separate GitHub-hosted VMs and one worker each. Each VM installs its own dependencies/browser, boots and resets its own Supabase stack, seeds its own database, builds its own Next application under the hermetic environment, and owns its auth files, mail/publication stubs and cleanup manifest. No running database, auth state or build artifact is shared. The verify and live jobs retain their existing behavior.

## Correctness and reporting

- Playwright file-level sharding remains in use (`fullyParallel: false`), with explicit `--workers=1` on both workflow commands. All tests and assertions remain unchanged.
- Discovery partitions all 41 hermetic journey identities into 23 and 18 without duplication or omission. Each shard additionally executes all four auth setup tests and cleanup. Four existing journey skips remain; duplicated setup/cleanup is overhead, not additional journey coverage.
- Existing required name `E2E (hermetic)` becomes an aggregate gate. It accepts only successful detection plus both successful shards, or successful docs-only detection plus intentionally skipped shards. Failed/cancelled/missing/invalid detection and failed/cancelled/unexpectedly skipped shards fail it. The ruleset remains unchanged.
- `fail-fast: false` preserves both shard outcomes; workflow cancellation can still stop obsolete shards. Failure comments and artifacts use distinct shard markers/names so concurrent failures cannot overwrite one another. Failure-only uploads, retention, retry settings and recording policy remain unchanged.
- `node --test scripts/ci/*.test.mjs` executes the actual aggregate shell for success/docs/failure/cancellation/missing-result cases and invokes the workflow's real shard commands in discovery mode to verify coverage, dependencies and one worker per database.

## Cost and latency hypothesis

Summing individual test durations from the preceding hosted run gives about **221.1s** for the files assigned to shard 1 and **167.7s** for shard 2. This is a partition estimate, not a measured parallel run. Each shard still pays roughly four minutes of setup/build, and the aggregate starts another short runner. A balanced two-shard run could shorten E2E by a few minutes while increasing total runner minutes. Extra shards would repeat still more setup.

The experiment must be evaluated using full shard/aggregate elapsed time, retries and per-job rounded runner minutes. It must not be described as a cost reduction. Next-build caches, larger/ARM runners and replacing journey prerequisites with API fixtures remain separate experiments; no coverage is removed to produce faster numbers. [Playwright sharding semantics](https://playwright.dev/docs/test-sharding) explain file-level grouping and duplicated dependency execution.

## Local validation

The workflow passes actionlint and 26 CI regression tests; independent review found no substantive issue. Separate archived `c36a3da` checkouts used fresh, independent Supabase projects/databases on ports 58321 and 59321. They ran sequentially locally to avoid the fixed app/stub ports; the hosted matrix is the concurrent validation. The 12 pre-existing shared containers were untouched, and both probe stacks/volumes were removed afterward.

- Shard 2: 22 passed, one existing skip, no failures/retries; 71.24s including its production build.
- Shard 1 initially: 24 passed, three existing skips, cleanup failed while updating an MFA-enrolled invitee (`Error updating user`, then `Database error loading user`); 80.70s. Every journey assertion passed. The initial containers were removed before Auth/DB logs were captured, so the cause remains unproven.
- Fresh unchanged shard 1 reproduction: 25 passed, three existing skips, no failures/retries; 65.61s including build, with a warm build cache. All five invitee identities recycled successfully. Auth/DB logs were captured before cleanup, and all 74 migrations and expected DB roles were present.

These are local correctness observations, not a controlled timing comparison or a claim that the initial cleanup flake is fixed. Ephemeral reports/traces/logs: `/var/folders/nn/8jc473wx34l2lzrmdhx5sh8m0000gn/T/conductia-shards-cq4u_mf7`.

## Hosted registry failure and fix

[Run 35898782836](https://github.com/Conductia/Conductia/actions/runs/35898782836), including one failed-job retry, failed before tests in integration and both shards: GHCR returned `toomanyrequests` while downloading Supabase images. The CLI exhausted three attempts per image. All non-Docker checks passed; these failed attempts provide no E2E performance measurement.

The setup action [exports `SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io`](https://github.com/supabase/setup-cli/blob/v1/src/main.ts). An explicit override [disables registry fallback in pinned CLI 2.116.0](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/legacy-docker-registry.ts). Both startup steps now unset that inherited override before `start` and `db reset`, restoring the CLI's public ECR default, GHCR and source-image fallbacks. Image versions, migrations, tests and independent databases stay unchanged; no registry credentials are needed.

Two regression cases execute the real workflow startup shell with the action's GHCR environment inherited and verify that both CLI commands receive no override. Both failed before the fix and pass afterward; all 28 CI regression tests, actionlint and targeted ESLint pass. The hosted run above subsequently confirmed ECR downloads, migrations, schema/SQL checks, all 50 integration tests and both shards. The registry fallback fix and its two startup regression tests remain after reverting sharding.
