# Supabase CI cost probe, 2026-09-22

Validated the six-service exclusion below against migrations, snapshot, SQL checks, integration and hermetic E2E. The full candidate browser run passed with one retried flaky attempt, documented below; its focused scenario subsequently passed three times with retries disabled. Shared setup remains an investigated opportunity, not an implemented change.

## Scope and isolation

Baseline commit: `c05d1306d4e8a9c3d442703ec064730d00ee0126`. Pinned Supabase CLI `2.116.0`, Node `22.15.0`, local macOS arm64 with Docker Engine `29.3.1`. All database work uses an archived checkout under `/tmp/conductia-ci-supabase.Ol7gJr`, project `conductia-ci-cost-probe-ol7gjr`, API/database ports `56321`/`56322`, and separate Docker volumes. The pre-existing `conductia` stack is untouched. These are local experiments, not GitHub-hosted runtime or billing measurements.

## Service dependency findings

- Keep Postgres, Auth, PostgREST and Kong: integration handlers and fixtures exercise real database and Auth APIs; migrations reference `auth.users`, `auth.uid()` and `auth.role()`.
- Keep Storage for hermetic E2E. `STORAGE_PROVIDER=local` means `src/lib/storage/local.ts`, which uploads/downloads/removes objects through Supabase Storage. Both the MD spine and data-room-wall journeys upload documents. Migration `20260731121000_dataroom_bucket.sql` creates the `dataroom` bucket only when `storage.buckets` exists. A migration-only or public-schema snapshot test can therefore pass without Storage while the real journey fails.
- Exclusions tested in the full-suite probe: `studio,postgres-meta,edge-runtime,realtime,logflare,vector`. Source inspection found no Realtime channels or edge-function invocations in the application/test paths; runtime validation is recorded below.
- The tracked config already disables the connection pooler and storage analytics. Preserve the tracked auth redirect origins and TOTP configuration; regenerating the config would invalidate the hermetic onboarding path.

## Shared setup investigation

A reusable/composite setup action can reduce repeated YAML but still starts a separate Docker stack on each job's runner. It does not share a running database or remove runner minutes by itself.

Combining integration and E2E on one runner might avoid one image pull/start, but serializes jobs currently able to run in parallel and couples failures. A database reset between suites remains necessary: `tests/integration/phase1.e2e.test.ts` explicitly documents retained WORM audit rows and foreign-key-pinned identities/deals after cleanup. E2E seeds overwrite feature flags and its cleanup intentionally leaves ordinary journey data. Sharing the same live database concurrently would weaken isolation.

A safe future comparison must retain the four required check names, start E2E from freshly reset state even after integration fails, and compare total billable runner time as well as wall-clock latency. Snapshot/artifact transfer of a running Docker stack is not a drop-in replacement for isolated runners. No shared-setup workflow change is made here.

## Baseline measured validation

All commands ran against the disposable stack with the original service set. The two optional cross-service integration suites kept their existing environment gates; no new skips were introduced.

| Stage | Elapsed seconds | Outcome |
|---|---:|---|
| First start, including missing-image pulls | 95.72 | Passed |
| Fresh `supabase db reset --local --yes` | 37.34 | Passed, 74 migrations |
| `npm run schema:snapshot` | 1.71 | Exact byte match with tracked public-schema snapshot |
| `outbound_recipient_boundary.sql` | 0.14 | Passed with `ON_ERROR_STOP=1` |
| `deal_recipient_affiliations.sql` | 0.19 | Passed with `ON_ERROR_STOP=1` |
| Integration suite, command elapsed | 15.02 | 50 passed, 12 existing opt-in skips |
| Fresh reset before E2E | 73.79 | Passed |
| Seed flags / enable flags / seed users | 1.50 / 1.13 / 6.01 | Passed |
| Hermetic E2E, including its own Next build/server | 179.76 | 42 passed, 4 existing skips |

The complete baseline validation sequence, including integration → fresh reset → seeded E2E, completed in 316.59 seconds excluding initial startup. This proves a sequential, reset-separated execution is feasible on this local machine. It does not establish that consolidating hosted jobs saves money: no separately hosted comparison, queue-time measurement, or Actions billing data is available. Reset variability (37.34 versus 73.79 seconds) also prevents treating a single sample as a stable estimate. During the slower reset the local analytics container temporarily reported unhealthy before the reset completed successfully.

## Startup comparison

Each measured start below followed `supabase stop --project-id conductia-ci-cost-probe-ol7gjr --no-backup`, so the database/storage volumes were empty while Docker images were already cached. CLI health checks stayed enabled.

| Service set | Start seconds | Running containers |
|---|---:|---:|
| Baseline, all configured services | 30.53 | 12 |
| Candidate plus redundant `imgproxy` exclusion | 29.02 | 6 |
| Exact candidate: `studio,postgres-meta,edge-runtime,realtime,logflare,vector` | 27.71 | 6 |

`imgproxy` was supported by the pinned CLI but absent in the baseline, so it is omitted from the final candidate. The exact candidate was 2.82 seconds faster in this one local warm-image start comparison. These are single samples on macOS arm64 Docker with other workloads present; the 95.72-second first start included image pulls and must not be used as the baseline for a claimed startup saving. No hosted-runner or dollar saving is established.

## Candidate full validation

Exact startup command:

```sh
supabase start --exclude studio,postgres-meta,edge-runtime,realtime,logflare,vector
```

| Stage | Elapsed seconds | Outcome |
|---|---:|---|
| Fresh reset | 27.75 | Passed, all 74 migrations |
| Public-schema snapshot | 0.34 | Exact byte match |
| Outbound boundary SQL / recipient affiliations SQL | 0.04 / 0.07 | Both passed with `ON_ERROR_STOP=1` |
| Integration suite | 5.85 | 50 passed, 12 existing opt-in skips |
| Fresh reset before E2E | 27.57 | Passed |
| Seed flags / enable flags / seed users | 0.24 / 0.18 / 1.30 | Passed |
| Full hermetic E2E, including own Next build/server | 150.57 | Exit 0: 41 passed, 1 flaky passed on existing retry, 4 existing skips |

The baseline `.next` directory was removed before candidate E2E; it rebuilt under its own hermetic environment. Source/test coverage and retry settings were unchanged. Both after reset and after full E2E, Docker inventory contained exactly Postgres, Auth, PostgREST, Kong, Storage and mail; excluded services stayed absent. The four browser skips are two existing `fixme` cases and two live-Ignatious-only cases.

### Retry investigation

The member “no Add step affordance, in Full Array or Focus” test first timed out waiting for the Focus heading (`rail-model-verification.spec.ts:340`), then passed on its normal CI retry. Its trace shows Auth `/auth/v1/user` returned HTTP 500, followed by application HTTP 401 responses. At the matching timestamp (`2026-09-22T20:21:07Z`), the retained Auth container logged a connection failure to the retained Postgres container: `dial tcp 172.20.0.2:5432: connect: cannot assign requested address`. This is evidence of the observed Auth/database connection failure, not proof of its underlying cause or of exclusion independence. No application or test fix was made.

The same member scenario subsequently passed **3/3 repeats with retries disabled** on the reduced stack (`--grep "the member has no Add step affordance" --repeat-each=3 --retries=0 --no-deps`), in 13.59 seconds including its own build/server. Existing auth state was reused for this focused follow-up only; the full candidate suite above ran its normal setup and teardown. The measured complete candidate validation sequence was 213.91 seconds excluding initial startup and follow-up; differing host load and caches prevent attributing its entire difference from baseline to exclusions.

## Evidence and cleanup

Raw logs, per-command JSON timings, the flaky trace/video and browser reports are retained under `/tmp/conductia-ci-supabase.Ol7gJr` (ephemeral local evidence, not committed). The probe project was stopped with `supabase stop --project-id conductia-ci-cost-probe-ol7gjr --no-backup`; its containers and volumes were removed. The 12 pre-existing shared `conductia` containers remained running. No original-checkout files, tracked runtime configuration, external settings, or shared stacks were modified.
