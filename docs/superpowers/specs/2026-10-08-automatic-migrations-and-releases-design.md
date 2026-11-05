# Automatic migrations and tagged releases

Status: design recorded on 2026-10-08 from the conversation with Charles, revised 2026-10-09. A staging Supabase project of its own and a single production approver are confirmed. The defaults under [Decisions](#decisions) await review. Implementation has not started.

## Goal

1. A migration merged to `develop` reaches the dev database with no hand step. The same holds for `staging` and `main` and their databases.
2. The migration job is its own GitHub Action. It does not depend on the Vercel deployment, and it can be run on its own.
3. A production release is one Action run that migrates, moves `main`, tags `vX.Y.Z` and publishes notes listing every included PR. Nobody assembles a PR list.

Rolling releases are not a goal. Production still moves on a deliberate, approved click.

## Evidence (read on 2026-10-08, `develop` at `d76bcedbf`)

- Hosted databases keep no migration ledger. `scripts/preflight-db.ts` exists because of that. For v0.7.0, 55 files were applied to production by hand on Oct 7, one at a time, over about 90 minutes (#379).
- **Promote develop to staging** and **Promote staging to main** (#235) have 0 runs. The `production-db` environment they need was never created; the repository has only Vercel's `Preview` and `Production`. `staging` and `main` moved on Oct 6 and 7 by direct `cursor[bot]` pushes, carried by PRs #330 and #398.
- v0.7.0 has no tag and no GitHub release, and `package.json` still reads `0.6.0`. `delivery-model.md` asks for a version bump "in the same promotion", which a fast-forward cannot carry.
- The repository is private and the organization is on GitHub Team. On that plan, required reviewers on an environment exist only for public repositories; environment secrets, variables and deployment branches do work. The gate #235 designed (`production-db` with `release-approvers` as required reviewers) cannot be configured, which is the likely reason it never was.
- `staging` is a Vercel preview on the dev Supabase project (ADR-0007, update of 2026-09-25). It runs older code against `develop`'s schema.
- CI applies every migration with Supabase CLI 2.116.0 on each PR (`supabase db reset --local` in `ci.yml`), so the files already work with the CLI's runner.
- Since v0.6.0, 9 migration files merged behind a newer timestamp already on `develop`, and one PR (#184) edited 4 files that were already on `main`.
- CLI 2.116.0 has `db push --include-all --dry-run --skip-vault --db-url`, `migration repair --status applied|reverted` and `migration list`, plus the global `--yes`.

## Decisions

Confirmed by Charles:

- Staging gets its own Supabase project. A persistent branch of the dev project was considered and dropped: Supabase builds a branch from the parent's ledger or a dump of its schema, so it would inherit dev's hand-applied state.
- One person can approve a production migration for now.

Defaults chosen here, to confirm or change in review:

| # | Decision | Default | Alternative |
|---|---|---|---|
| 1 | How the single approver is enforced | An approver list on the environment, checked by the job (section 3). GitHub's required reviewers are not available on this plan | Move to GitHub Enterprise for a real approval pause |
| 2 | Production credential | A DDL-capable connection string in the `db-production` environment secret. Any automation needs this; `production-bootstrap.md` avoided it until now | None that keeps the goal |
| 3 | When dev migrates | On every push to `develop`, at once | After the `develop` CI run is green: safer, but the `develop` deployment runs ahead of its schema until CI finishes |
| 4 | Default version bump | `minor`, with `patch` selectable when the promotion is started | Derive from commit prefixes |
| 5 | Editing old migrations | A file that is on `main` can never change or be removed | Warn only |
| 6 | `develop` to `staging` | Stays a manual Action run | Automatic on a green `develop` run |

## Design

### 1. The ledger

Hosted databases adopt the Supabase CLI ledger, `supabase_migrations.schema_migrations`, which the local and CI stacks already write. From then on a hosted schema changes only through `supabase db push --include-all`. `--include-all` is required because files do merge behind newer timestamps.

Dev and production are baselined once, by an owner, with a laptop and the database's own connection string:

1. Check out the commit whose schema the database already holds, and prove it: `npm run preflight:db` green from that commit.
2. `supabase migration list --db-url …`. A ledger row whose version matches no local file is removed with `supabase migration repair --status reverted <version>`.
3. `supabase migration repair --status applied <every local version>`.
4. `supabase db push --include-all --dry-run --db-url …` must list nothing.

`repair` writes ledger rows and no schema. It is still a write to a hosted database, so it is rehearsed first on a local stack built the way hosted was: a `psql` replay with no ledger. If `preflight:db` is red in step 1, the files it names are left unmarked and the first push applies them.

Read on 2026-10-13: both hosted ledgers hold only rows the Supabase connector wrote under its own version numbers, 9 on dev and 55 on production. Rehearsed the same day: with such rows `db push` refuses the database, and `migration repair --status applied` with no version replaces the whole ledger with the local files, so step 3 also does step 2's cleanup.

### 2. `Migrate database` workflow

One new file, `.github/workflows/migrate.yml`, with one job named `Migrate database`.

| Trigger | Environment | Commit |
|---|---|---|
| `push` to `develop` | `db-dev` | the pushed commit |
| `push` to `main` | `db-production` | the pushed commit |
| `workflow_call` from a Promote workflow | caller's input | the pinned commit |
| `workflow_dispatch` | chosen | chosen ref |

`staging` joins the `push` list when its database exists (section 6).

The job:

1. Fails closed when `MIGRATION_DATABASE_URL` is empty, holds a quote or a line break, or belongs to the wrong environment: only `db-production` may hold the production project's connection string, and it must hold that one.
2. Checks the approver list (section 3). For `db-production` it also refuses a commit that is on neither `staging` nor `main`, so a manual run cannot apply a feature branch's migrations.
3. Installs Supabase CLI 2.116.0, the version `ci.yml` pins. `scripts/ci/migrate.test.mjs` pins the two together.
4. Refuses a database that has tables in `public` and an empty ledger. Such a database was never baselined, and a push would replay every file over it. A ledger that cannot be read stops the run with the database's own error; it is never treated as empty.
5. Runs `supabase db push --include-all --skip-vault --yes --db-url "$MIGRATION_DATABASE_URL"`.
6. Writes the files it applied to the run summary, also when the push failed partway.
7. Runs `npm ci --ignore-scripts` and `npm run preflight:db` when the ledger grew, and always in a promotion or a manual run. A `develop` push with nothing to apply stops before that, so it costs seconds.

Concurrency is one group per environment with `cancel-in-progress: false`. A queued run is replaced by a newer one and never by an older one.

A workflow that calls this one passes `secrets: inherit`. Without it GitHub resolves an environment secret to an empty string inside the called job, and the job stops at step 1.

A push made with a workflow's `GITHUB_TOKEN` does not start other workflows. That is why the Promote workflows call this one directly, and why the `push` triggers only fire for PR merges and direct pushes.

### 3. Environments and credentials

| Environment | Database | Allowed refs | `MIGRATION_APPROVERS` |
|---|---|---|---|
| `db-dev` | dev, `sqyjqdjazefceixkjtdp` | `develop` | unset: anyone |
| `db-staging` | the new staging project | `staging`, `main` | unset: anyone |
| `db-production` | production, `fsaucpwponmzajupvsey` | `main` | one GitHub login for now |

Each holds one secret, `MIGRATION_DATABASE_URL`: the session pooler (IPv4) string for the `postgres` role, password percent-encoded. `db-staging` allows `main` because the Promote workflows are dispatched from `main`.

`MIGRATION_APPROVERS` is an environment variable holding a comma-separated list of GitHub logins. When it is set, the job continues only if `github.triggering_actor`, the person who started or re-ran the run, is on the list. For `db-production` an unset list fails the job. Starting the run is the approval: there is no pause. A run started by anyone else, or by a bot's direct push, stops before it touches the database, and the approver takes it over with **Re-run failed jobs**. Adding a second login later is a settings change, not a code change.

This guards against accidents. It is not a security boundary: the `main` ruleset does not require a pull request, so anyone with write access can push a commit to `main` that changes the workflow. A hard gate needs GitHub Enterprise's required reviewers, or a `main` ruleset that restricts who can push.

GitHub creates a missing environment, unprotected, the first time a workflow names it. `db-production`, with its branch rule, secret and approver list, must therefore exist before `migrate.yml` reaches `main`.

`db-production` replaces the `production-db` environment and the `preflight_reader` role that `production-bootstrap.md` describes and that were never created. The preflight runs in the migration job on the same connection.

### 4. Promotion

**Promote develop to staging:** `plan` → `migrate` (`db-staging`, pinned commit) → `fast-forward`. `plan` also lists the migration files the promotion adds. The `migrate` job is added with the staging database.

**Promote staging to main:** `plan` → `migrate` (`db-production`, pinned commit, approver only) → `fast-forward` → `release`. The separate `preflight` job is removed. `plan` prints the PRs, the migration files and the version about to be tagged. Anyone can start the workflow to read that summary: for a non-approver it stops at `migrate` with nothing moved, and the approver can re-run that job once they have read it.

A failed migration leaves the branch where it is, because `fast-forward` needs `migrate`.

A direct push to `main` still gets migrated by the `push` trigger, but Vercel builds at the same moment and the job stops unless the pusher is the approver. Break-glass therefore becomes: run **Migrate database** by hand against production from the commit, then fast-forward.

### 5. Releases

The chain is fast-forward only and `develop` holds one squash commit per PR, so a release is fully named by one commit. The `release` job runs after `fast-forward`:

1. Previous version: the highest `vX.Y.Z` tag reachable from `main` before it moves, read in `plan`. Tags of any other shape, such as a release candidate, are ignored. Next version: the `bump` input applied to it (`minor` by default, decision 4). `plan` stops when that version already exists, or when `staging` and `main` are the same commit.
2. `gh release create vX.Y.Z --target <sha> --generate-notes --notes-start-tag <previous>` creates the tag at the promoted commit and the release, with the list of migration files in the release placed above the generated notes. GitHub's generated notes list every PR between the two tags with its author.

The `package.json` version is no longer bumped. Nothing in `src/`, `scripts/` or `worker/` reads it; the tag is the version.

Promotion PRs such as #330 and #398 are no longer opened. The `plan` summary replaces their hand-written lists.

### 6. The staging database

Staging is a new Supabase project in the organization that owns dev and production, in their region. It is built from the repository alone, so it does not depend on the state of either existing database.

1. Create the project, named `Conductia staging`, in organization `Conductia` and region `us-east-1`, beside `Conductia prod` and `conductia dev`. This needs the Owner or Administrator role in the Supabase organization; the Developer role cannot create projects. The plan does it through the Supabase connector once Charles confirms the cost, about $10 a month at the Micro size. Then create `db-staging` with its connection string.
2. Build the schema by running **Migrate database** by hand for `db-staging` from `develop`'s tip. On an empty database the push applies every file and writes the ledger, so no baseline is needed. Until the workflow has reached `main` and can be dispatched, the same `supabase db push --include-all` is run once from a laptop.
3. Verify: the dry run lists nothing and `preflight:db` is green.
4. Configure it as `production-bootstrap.md` sections 3 to 6 describe: Site URL and redirect allowlist for the staging origin, OTP expiry, flags, the bootstrap admin and the first organization. Give the work-account sign-in providers staging's own redirect URIs. Sharing dev's auth configuration is the likely cause of #394.
5. In Vercel, scope the Supabase variables for the `staging` git branch to the new project.
6. Add `staging` to the `push` triggers and the `migrate` job to **Promote develop to staging**.

Until step 6, `staging` keeps using the dev database, which `develop` pushes already migrate. The schema is built from `develop`'s tip and so runs ahead of the `staging` git branch until the next promotion; expand, then contract makes that safe.

### 7. Migration file rules

`npm run check:migrations` gains one rule: a migration file present on `origin/main` must be present and byte-identical on the checked commit. A released file is applied to production, so an edit would reach fresh databases and never production. The lint job fetches `main`'s tip to compare. `develop` satisfies the rule today.

A file on `develop` that is not yet on `main` may still be edited. That is the fix for a file that failed on a hosted database and so was never applied there. The reviewer checks that the file is not already applied to dev or staging; if it is, the edit will not reach them.

A revert of a `develop` merge keeps the migration file it added. Deleting it leaves a ledger row with no file, and every later push to that database refuses until someone runs `migration repair --status reverted`.

Expand, then contract (`delivery-model.md`) is unchanged and matters more: dev migrates the moment a PR merges, while the `develop` deployment is still building.

## Day-to-day runbook

This is what `delivery-model.md` will say once the one-time setup is done.

**Develop.** Nothing to run.

1. Open the PR against `develop` with the migration file and the regenerated `supabase/schema-snapshot.txt`. One approval and the four checks, then squash merge.
2. On merge, three things start on their own: Vercel deploys `develop`, **Migrate database** applies the new files to dev, and CI runs on the merge commit.
3. Confirm the **Migrate database** run on that commit is green. Its summary lists the files it applied.

**Staging.** One click, by anyone with write access.

1. **Actions → Promote develop to staging → Run workflow**, from `main`.
2. The workflow pins `develop`'s tip, requires the four checks green on that commit, migrates the staging database, then fast-forwards `staging`. Vercel deploys it.
3. Smoke test on staging.

**Production.** One click, by the approver.

1. **Actions → Promote staging to main → Run workflow**, from `main`. Pick `patch` when the release is fixes only; the default is `minor`.
2. Read the `plan` summary: the PRs, the migration files and the version it will tag.
3. The workflow migrates production and runs `preflight:db`, fast-forwards `main`, then tags the commit and publishes the release. Vercel deploys production when `main` moves.
4. Confirm the production deployment is ready in Vercel and the release page lists the expected PRs.

To undo a release, use Vercel Instant Rollback as today. The schema is not rolled back; expand, then contract keeps the previous build working on it.

## Failure handling

- `db push` stops at the first file that fails. Earlier files stay applied and recorded, and the failing file leaves nothing behind (rehearsed, see Testing).
- On `develop`: the run is red and dev is behind. Fix the file on a new PR (section 7). Treat it like a red `develop`.
- In a promotion: the branch does not move. Fix forward on `develop` and promote again.
- `preflight:db` red after a clean push: the build expects an object no migration creates. Same handling.
- Nothing rolls back automatically. `supabase/rollback/` stays a hand tool.

## One-time setup, by an owner

In this order:

1. Create `db-dev` and `db-production` with their branch rules, and set `MIGRATION_APPROVERS` on `db-production`. Do not add the secrets yet: without its secret the job fails before it touches a database.
2. Baseline dev, then add `db-dev`'s secret. Merge the implementation PR to `develop`; the first push applies whatever dev is missing.
3. Baseline production at `main`'s tip, then add `db-production`'s secret.
4. Tag `v0.7.0` at `22cf73bfc` and publish its release, so the first generated notes start there.
5. Ship the release that carries this change the old way, one last time: the Promote workflows run from `main`, which does not hold the new files yet. With the ledger baselined, its migrations go out with one `supabase db push` from the releaser's machine in place of file-by-file runs.
6. Staging database, section 6.

## Files

| File | Change |
|---|---|
| `.github/workflows/migrate.yml` | New |
| `.github/workflows/promote-staging-to-main.yml` | `bump` input; `migrate` replaces `preflight`; new `release` job; `plan` prints PRs and the next version |
| `.github/workflows/promote-develop-to-staging.yml` | `plan` lists migrations; `migrate` job once staging has a project |
| `scripts/check-migration-prefixes.ts`, `tests/check-migration-prefixes.test.ts` | The released-file rule |
| `.github/workflows/ci.yml` | The lint job fetches `main` for that rule |
| `scripts/ci/migrate.test.mjs` | New. Runs the workflow's own shell: the guard, the push report, the version arithmetic. Pins the CLI version shared with `ci.yml`, the job order and the branch to environment map |
| `scripts/ci/gates.test.mjs` | Its promotion test names the new migrate job in place of `production-db` |
| `docs/03-engineering/delivery-model.md` | Merge policy, Migrations in a PR, Break-glass, Releases and tags |
| `docs/04-operations/production-bootstrap.md` | The promotion gate becomes environments, baseline and the staging build |
| `docs/07-decisions/decision-log.md` | One new row at the end |
| `docs/07-decisions/ADR-0007-supabase-backend-feature-flags.md` | A dated update when the staging database exists |

`scripts/migrate.sh` and `npm run db:migrate` replay every file with no ledger. They are deleted in a follow-up, once the workflow has migrated dev and production at least once.

## Testing

- Unit: the released-file rule (unchanged, edited, deleted, new file).
- `node --test scripts/ci/*.test.mjs`: the pins above.
- Rehearsed on 2026-10-09 with CLI 2.116.0 on a throwaway local database, all as designed:
  1. An empty database built by `db push` alone: 131 files, and the schema matches `supabase/schema-snapshot.txt` exactly.
  2. A schema with an emptied ledger, baselined with `migration repair --status applied`: 131 rows, and the dry run then lists nothing.
  3. A new file with an older timestamp is refused without `--include-all` and applied with it.
  4. Of two pending files where the second fails partway, the first is applied and recorded, the second leaves no object and no ledger row, and the exit code is 1.
  5. Deleting an applied file makes the next push refuse until `migration repair --status reverted` removes its row.
- Nothing in the implementation PR touches a hosted database. The baselines and first runs are the owner's.

## Out of scope

- Rolling releases and automatic promotion to `staging` (decision 6).
- Per-PR preview databases. PR previews keep using dev, and a PR's migration is not on dev until it merges, as today.
- Automatic rollback, and rehearsing migrations against a copy of production data.
- #309, the ordering re-check when `develop` moves. `--include-all` covers out-of-order files until it lands.
- Vercel Deployment Checks on `Migrate database`, which would hold a production build off the domain until the schema is in. It needs a Vercel admin, and the Promote path would first have to report a status on the promoted commit, or every promotion would wait forever.
- A `released: vX.Y.Z` label on each included PR. The generated notes and the tag on each squash commit already answer which release a PR shipped in.
- Staging environments for Ignatious and `conductia-agents-backend`.

## Acceptance

- [ ] A PR that adds a migration merges to `develop`, and **Migrate database** applies it to dev with no human step and independently of the Vercel deployment.
- [ ] **Promote staging to main** applies pending migrations to production only when started or re-run by a listed approver, moves `main` only if they applied, then creates the tag and a release whose notes list every PR since the previous tag.
- [ ] A failing migration in a promotion leaves `main` and the production deployment unchanged.
- [ ] A PR that edits or deletes a migration already on `main` fails `Lint, typecheck, test, build`.
- [ ] After the staging database exists, **Promote develop to staging** migrates the staging database before `staging` moves.
- [ ] `delivery-model.md` and `production-bootstrap.md` describe this flow and no longer describe applying files by hand.
