# E2E runtime follow-up

## Hosted baseline

[PR #228, run 35795757040](https://github.com/Conductia/Conductia/actions/runs/35795757040/job/106974581069) ran on the existing Ubuntu 24.04 x64 runner, commit `efc05d6a`, with the reduced Supabase service set. The job passed 42 tests with four existing skips and no retries.

| Work | Observed elapsed |
|---|---:|
| Whole E2E job | 14m37s |
| Browser/setup/cleanup test phase, from “Running 46 tests” to summary | 10m30s |
| Next build and server startup | About 57s |
| Supabase start plus reset | 1m59s |
| Remaining setup, seeding and cleanup | About 1m11s |

The browser phase is the dominant opportunity. Build caching alone cannot remove ten minutes of browser work. These are job log observations, not billing estimates or a controlled before/after experiment. Unlike the earlier analysis account, the currently authenticated `charleswvs` account can read these Actions runs.

## Rejected parallelism trial

[Run 35798429954](https://github.com/Conductia/Conductia/actions/runs/35798429954/job/106983057549), commit `2559d0bc`, tested two workers on the same runner, keeping the four shared-state access/invite journeys sequential through one importing spec. It completed in **20m59s**, with 36 passed, three flaky, three failed and four existing skips. The test phase lasted 16m33s; Playwright's 17.7m summary also includes server startup.

Audit scoping, invite onboarding and step completion failed after their retries. Logs show test timeouts and closed/disposed request contexts; other retries include a socket hang-up and a truncated trace archive. These observations do not prove one underlying cause, but they reject this configuration as a reliable speed improvement. All file grouping changes are reverted and all journey sources restored byte-for-byte. Workers remain one, including live E2E. No assertions, timeouts, retries or skips were changed.

The isolation audit also found that access denial and approval mutate the same employee and select from the same director notifications; invitation journeys update one non-atomic cleanup manifest. Future concurrency needs to address these dependencies as well as measure resource contention.

## Video-only trial

[Run 35800192770](https://github.com/Conductia/Conductia/actions/runs/35800192770/job/106988595074), commit `cda9b59e`, kept one worker and first-failure traces, but recorded video only on the CI retry. All 42 active tests passed with four existing skips and no retries. The job took **15m16s** and its test phase took **11m02s**, versus 14m37s and 10m30s at baseline. This single sample establishes no video-only speedup. Supabase start/reset took 2m03s and build/startup about one minute.

Per-test output now identifies the longest journeys: step ownership about 92s, invite onboarding 64s, step completion 59s and data-room wall 46s. The ten publication tests total about 112s. These are observations from this run, not fixed costs.

## Trace and video candidate

Hermetic CI now records both traces and standalone video on the first retry, retaining first-failure screenshots. Local and live recording behavior is unchanged. Playwright's [CI debugging guidance](https://playwright.dev/docs/best-practices#debugging-on-ci) recommends retry tracing because recording all tests is expensive. Changing trace capture is the additional variable compared with the video-only trial; hosted validation must establish whether it helps this suite.

The built-in list reporter prints individual test durations. Existing HTML/JSON and GitHub reporting remain enabled. Assertions, retries, timeouts, workers, database isolation and all test sources are unchanged.

## Validation and limits

Discovery reports exactly the same 46 test title/project identities with one worker. Targeted lint, TypeScript and diff checks pass. A database-free synthetic retry verifies first-attempt failure retains its screenshot, and the first retry retains trace and video. The tradeoff is losing the initial failure's full recording: if the retry behaves differently, the original failure only has its screenshot/error. Under the existing failure-only upload policy, ultimately successful flaky runs do not upload artifacts; that policy is unchanged.

A local full-suite recording experiment was inconclusive: its unchanged baseline encountered recurring Supabase Auth errors before a valid comparison could be collected (40 passed, one flaky, one failed, four skipped). No local speedup is claimed. The hosted trace/video comparison and final outcome are recorded in [PR #228](https://github.com/Conductia/Conductia/pull/228).
