# Delivery model — branches, completion, and GitHub

How the Conductia team tracks and ships work. The Labor Day MVP shipped on Sep 7, 2026 (`v0.5.6`); the current target is MVP 2 on Friday, Oct 30, 2026. Its proposed scope (PR #146) closed unmerged, so no scope document is on `develop` yet; it is to be recorded as a decision.

## Branch strategy

| Branch | Role |
|--------|------|
| **`develop`** | **Integration branch and completion bar.** Work is considered done when it merges here and the post-merge CI run on `develop` is green. Approved, green PRs auto-merge any time. Run locally from `develop` for an accurate picture of product state. Vercel deploys it, like every branch other than `staging` and `main`, as Preview, which reads Conductia-dev. |
| **`staging`** | Tested snapshot. Promoted from `develop` daily or at the weekly build sync, and only to a commit whose required checks all passed on that exact commit. Has its own Supabase project, which the promotion migrates before `staging` moves. Vercel deploys it in an environment of its own, `staging`, which reads that project, at `conductia-env-staging-conductia.vercel.app` (`../04-operations/production-bootstrap.md`, The staging database). |
| **`main`** | Release snapshot. Promoted from `staging` every one to two weeks or at agreed milestones. Production deploys from it. |
| **Feature branches** | Short-lived; PR target is **`develop`** unless explicitly noted. Rebase on `origin/develop` before every push. |

```sh
git checkout develop
git pull origin develop
npm install && npm test && npm run dev
```

CI runs on pull requests and on pushes to `develop` and `main` (see `.github/workflows/ci.yml`): `Lint, typecheck, test, build`, `Phase 1 integration test (local Supabase)`, `E2E (hermetic)`, `Dependency vulnerability audit`. All four are required to merge into `develop`, and the promotion to `staging` requires every check in `scripts/ci/required-checks.mjs` green on the exact `develop` commit: those four plus `Secret scan` (#473). `Secret scan` becomes required to merge as well once the owner adds it to the `develop` ruleset ([GitHub security runbook](../04-operations/github-security-runbook.md), step 5). `staging` gets no CI run of its own: it only ever holds commits that already passed on `develop`.

`Lint, typecheck, test, build` is an aggregate: it does no work itself and is green only when its workers all succeeded in the same run. The workers are `Lint, types, build and small suites` (CI gate tests, ESLint, migration prefixes, TypeScript, the eval harness, the Next.js production build) and `Vitest (shard n/N)` (the unit suite, one shard today, run with two workers to match the runner's two vCPUs). They run in parallel and are not required checks themselves. On a source change, a failed, cancelled or skipped worker turns the aggregate red; the aggregate itself is never left skipped, which a ruleset would treat as passing. `E2E (hermetic)` follows the same rule: its gate runs under `always()`, and its last step fails a run cancelled on a source change before the suite passed, so a cancelled suite never reads as a pass and a suite that already passed is never turned red. On a draft pull request `Phase 1 integration test (local Supabase)` and `E2E (hermetic)` report green without running their suites; marking the PR ready for review re-runs CI (`ready_for_review` is one of the workflow's pull request triggers), and that run decides both checks, so a PR is never merged on a draft's skip. Lint, Vitest and the build still run on a draft. `E2E discovery demo (Gmail replay)` (the deal-discovery journey on the Gmail replay, on its own local stack, `.github/workflows/e2e-gmail.yml`) is advisory and opt-in, not a worker (owner decision 2026-10-08): on a pull request it runs only when the PR carries the `e2e-gmail` label and is not a draft, and it also runs on every push to `develop` and nightly. Rob or Storm may promote it to a required check. Vitest splits files by count, not duration: when any shard passes about 8 minutes on a slow runner, add one by extending the matrix list and the `/N` in `ci.yml` together (`scripts/ci/gates.test.mjs` pins them). A `.test.ts` file runs in Node without a DOM unless `vitest.config.ts` lists it; a `.test.tsx` file always gets jsdom and the Testing Library setup. Both Next.js builds (the lint job's, and the hermetic one Playwright starts) restore `.next/cache` from the newest cache a push to `develop` saved; pull request runs never write one. The Supabase jobs run `supabase start` alone: a first start on a fresh runner applies every migration, so the `db reset` that used to follow it rebuilt the same database twice. `Classify changed files`, the aggregate, the dependency audit and the develop alert run on the single-CPU `ubuntu-slim` runner, and `Infra validate (OpenTofu, offline)` starts only when change detection says the module, its runbook or `ci.yml` changed.

### Post-merge CI on `develop`

`develop` does not require a PR branch to be up to date before merging. Merging one PR no longer forces every other open PR to re-run CI, which had made merging N PRs cost N + (N−1) + … + 1 runs. The push run on `develop` is therefore the first test of the combined result. A burst of merges collapses into one run, because a newer push cancels the older run on the same branch.

When that run fails, the `Alert when develop is red` job opens (or comments on) the **develop is red** issue with the commit and the run link. The rule is **revert first, investigate after**: revert the breaking merge within the hour, then fix it on a new PR. **While the issue is open, stop merging:** nothing lands on `develop` except the revert or the fix, and pending auto-merges wait. Close the issue once `develop` is green. A cancelled run never alerts: `verify` can report a cancelled run as red (its workers were cancelled), so the alert also requires `!cancelled()`.

For proven documentation-only changes, the first three checks report success without installing dependencies or running their expensive steps; the `Lint, typecheck, test, build` workers are skipped without starting a runner. The allowlist in `scripts/ci/docs-only.mjs` covers root/docs README files and direct Markdown children of the named documentation folders; fixtures, skill packages, nested research data, design assets and unknown paths still run full CI. PRs use their complete merge-base diff; pushes use the complete before/after range. An unavailable or uncertain range runs full CI, while failed or cancelled detection fails the required gates. The production lockfile vulnerability audit always runs, including on documentation changes. Run `node --test scripts/ci/*.test.mjs` to verify classification and gate behavior locally.

### Migrations on `develop`

Every push to `develop` also runs **Migrate database** (`.github/workflows/migrate.yml`) against the dev database. It is a workflow of its own: it does not wait for CI and it is not part of the Vercel deployment. It applies the files the database's ledger (`supabase_migrations.schema_migrations`) does not hold yet, with the Supabase CLI version CI uses, and lists them in its run summary. A push with nothing to apply finishes in seconds.

A red run means dev is behind `develop`. Read the failing file in the log and fix it on a new PR. A file that fails leaves nothing behind, and the files before it stay applied.

Hosted schemas change only through this workflow. SQL applied to a hosted database by hand, in the SQL editor or through a connector, is not in the ledger, and the next run either refuses or applies it a second time.

## Merge policy

| PR | How it lands |
|----|----------------|
| Feature → **`develop`** | **Squash merge** only, usually by auto-merge once approved and green. One commit per PR on `develop`. |
| **`develop` → `staging`** | **Fast-forward only**, with the **Promote develop to staging** Action. It pins `develop`, refuses unless all five checks in `scripts/ci/required-checks.mjs` passed on that exact commit, and migrates the staging database before `staging` moves. |
| **`staging` → `main`** | **Fast-forward only**, with the **Promote staging to main** Action, which migrates production first and tags the release after; see [Releases and tags](#releases-and-tags). |

Do not use GitHub's Merge / Squash / Rebase buttons for `staging` or `main`: they all create a new commit and break the fast-forward chain. Both Actions are `workflow_dispatch`, run from `main`. The same fast-forward by hand skips their checks, so it is break-glass only:

```sh
git fetch origin
git checkout main
git merge --ff-only origin/staging
git push origin main
```

`--ff-only` refuses to merge if `main` has commits that are not on `staging`. Land those on `develop` and promote them first. Before a manual fast-forward, run **Actions → Migrate database → Run workflow** from `main`, with `db-production` and the commit about to be promoted, and wait for it to go green: it applies that commit's pending migrations and runs `preflight:db`. It refuses a commit that is on neither `staging` nor `main`. Record in the release notes who bypassed the Action and why.

### Keeping CI and preview builds cheap

CI runs on a self-hosted fleet sized for bursts (ADR-0027), and Vercel bills per preview build. In October 2026 about half of CI minutes were re-runs with no new input since the previous run, so:

- **Open a PR as a draft, and mark it ready once.** On a draft, E2E and integration skip their suites (about half of a run's minutes); they run when the PR is marked ready. Push fix rounds while it is a draft. An agent harness that opens PRs ready (HumanLayer's PR phase does) is followed by `gh pr ready --undo <n>`, and `gh pr ready <n>` after the audit fixes land.
- **Don't update many PRs from `develop` at once.** Each update re-runs the full suite on every PR it touches. Update a branch when it is next to merge or has a conflict; collapse stacks top-down instead of rebasing every slice.
- **Previews build only when someone is likely to open them.** `scripts/vercel-ignore.sh` (the `ignoreCommand` in `vercel.json`) always builds `develop`, `staging` and `main`. It skips pushes by the owner's agent account (`VERCEL_SKIP_AUTHORS`), stacked slices (branches `<type>/<issue>-<n>-` with n of 2 or more) and docs-only changes since the last deployment, and builds everything else. Put `[preview]` in a commit message to force a preview.

### Local pre-push check (opt-in)

`.githooks/pre-push` runs a fast local tier before a push, to catch cheap failures that would otherwise cost a red CI run. It is off unless you opt in, so nobody else is affected:

```sh
git config conductia.prePush true    # this clone; or CONDUCTIA_PREPUSH=1 for one push
```

It diffs the pushed commits against their merge-base with `origin/develop` and skips documentation-only changes, using CI's own rule (`scripts/ci/docs-only.mjs`). Otherwise it stops at the first failure of: ESLint on the changed source files, `npx tsc --noEmit` (through `~/bin/heavy` when present), and `npx vitest related --run` on the changed source files. It reads the working tree, and never runs E2E, integration, Supabase or `next build`. Bypass with `git push --no-verify`, `SKIP_PREPUSH=1` or `CONDUCTIA_PREPUSH=0`. CI remains the authority: a green hook is not evidence for review.

### Migrations in a PR

- Name each file `YYYYMMDDHHMMSS_name.sql`, with lowercase letters, digits and underscores after the timestamp. No two files share a timestamp prefix. `npm run check:migrations` enforces both in `Lint, types, build and small suites` (part of the required `Lint, typecheck, test, build`) and names the colliding files. On a pull request it also compares the migrations the PR adds with those every other open PR adds (drafts and stacked slices included; the same file seen through a stack is not a collision), naming the other PR and its author. If another PR merged or holds the same prefix first, move yours to a later timestamp.
- Date a new migration after the newest one on the PR's base (`develop`, or the parent branch of a stacked slice). A hosted database applies a late-dated file after everything it already has while a fresh replay applies it in filename order, so `npm run check:migrations` fails a file the PR adds whose prefix is not greater than the base's newest, and suggests a current UTC timestamp.
- A migration that restates a `CHECK (col in (...))` list (drop and re-add) keeps every value earlier migrations allowed. `npm run check:migrations` replays every value-list CHECK in filename order and fails when the latest definition drops a value; a deliberate removal carries `-- check-removes: <value>[, <value>] <reason>` on the statement or on the drop just before it.
- `npm run check:migrations` also lints each migration file the PR adds. A failure names the rule, `file:line`, the fix, and the escape hatch: `-- lint-allow: <rule-id> <reason>` on the statement or the line above it (a marker without a reason does not count, and every marker is printed for the reviewer). `node --import tsx scripts/check-migration-lint.ts --all` runs the rules over every migration for calibration, not enforced.
  - `definer-search-path`: a new `security definer` function sets `search_path = public, pg_temp`, the form `supabase/tests/definer_grants.sql` checks.
  - `definer-grants`: a definer the file creates is revoked from `public, anon, authenticated` in the same file (only a `create or replace` of an existing definer with the same argument types keeps its ACL; a new overload, or an invoker turned definer, does not), never granted to `public` or `anon`, and granted to `authenticated` only when it is in the allowlist of `supabase/tests/definer_grants.sql`; `grant ... on all functions in schema public` to `public`, `anon` or `authenticated` always fails.
  - `table-grants`: a `grant ... on <table> to anon|authenticated|public` needs the table listed in `supabase/lint/browser-grants.txt` as `table: reason`, a line the reviewer approves; `on all tables in schema` always fails.
  - `hosted-catalog`: a DO block, or a function loop, that reads `pg_proc`, `pg_class`, `pg_policies`, `pg_policy`, `pg_namespace`, `pg_trigger` or `information_schema` carries a lint-allow saying how it limits itself to objects our migrations create, since a hosted database also holds Supabase's own (#542).
  - `heavy-lock`: `supabase db push` (CLI 2.116.0) runs a file as one transaction, except a statement that cannot run in one (`create index concurrently`, among others), which it runs on its own after committing the statements before it. So on a big table (the list `BIG_TABLES` in `scripts/check-migration-lint.ts`: the ledgers and the per-message tables) an index is built with `create index concurrently if not exists` alone in its own file (beside other statements it fails), a plain index or a CHECK/FK added without `not valid` carries a lint-allow stating the expected lock time, and a `validate constraint` goes in a later file than its `not valid` add.
  - `hosted-counts`: when an added file has a unique index, `set not null`, a validated CHECK/FK (a value-list widening excepted), a `validate constraint`, or an UPDATE/DELETE of existing rows, the PR body needs a line starting `Hosted counts:` with the query and its result on each hosted database (a count, or `none` with a reason; an empty heading fails), e.g. `Hosted counts: dev 0 duplicates, prod 0 duplicates (select ...)`; CI reads the body through the API, so after editing it re-run the job. Locally it prints a reminder, and an API failure warns and passes.
- Commit `supabase/schema-snapshot.txt` in the same PR as the migration. It lists every table, column, function and policy the migrations create, and the promotion requires production to hold every line. Regenerate it from the local stack after a reset, with an env file whose `DATABASE_URL` is the local stack's `DB_URL` (`supabase status -o env` prints it):

  ```sh
  supabase db reset --local
  echo 'DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres' > .env.snapshot.local
  npm run schema:snapshot -- .env.snapshot.local
  ```

  Never point it at `.env.local`. That is Conductia-dev, a lived-in database, and any object it holds that no migration creates would become a line production must match. `Phase 1 integration test (local Supabase)` rebuilds the file the same way and fails when the committed copy differs.
- Never edit or delete a migration file that is already on `main`. It is applied to production and never applied again, so the edit would only reach databases built later. `npm run check:migrations` compares every file on `origin/main` with the branch and fails on any difference. Put the change in a new file.
- A file that is on `develop` but not yet on `main` is edited only to repair one that failed on a hosted database. If it already applied to dev, the edit will not reach dev.
- A revert keeps the migration file the reverted PR added: `git revert -n <sha>`, then `git checkout HEAD -- supabase/migrations supabase/schema-snapshot.txt`, then commit. Deleting an applied file makes every later **Migrate database** run on that database refuse, until someone runs `supabase migration repair --status reverted <version>` against it.

PRs targeting `main` are checked by `.github/workflows/require-ff-to-main.yml`: the head branch must be `staging`, and `main` must already be an ancestor of `staging`. PRs targeting `staging` are checked by `.github/workflows/require-ff-to-staging.yml`: the head branch must be `develop`.

**Enforcement (rulesets, applied 2026-09-18 once the org moved to GitHub Team):**

| Ruleset | Branch | Rules |
|---|---|---|
| `develop` | `refs/heads/develop` | Pull request required, **1 approving review**, allowed merge method **squash** only; required status checks `Lint, typecheck, test, build` · `Phase 1 integration test (local Supabase)` · `E2E (hermetic)` · `Dependency vulnerability audit`, **not strict** (a branch need not be up to date with `develop`; see [Post-merge CI](#post-merge-ci-on-develop)); auto-merge allowed; no deletion, no force push. |
| `staging` | `refs/heads/staging` | Same as `main`: linear history, no deletion, no force push. Moves only by the **Promote develop to staging** Action. |
| `main` | `refs/heads/main` | Linear history, no deletion, no force push. `main` only moves by fast-forward (the Action or `git merge --ff-only`); the GitHub merge button is never used for it. Required checks on `main` follow once CI has run on a `develop` push (they read the check runs of the same SHA). |

Bypass: organization admins only, as the last step of [Break-glass](#break-glass-production-hotfix). A bypass is visible in the audit log; say so in the PR.

### Break-glass (production hotfix)

A commit made directly on `main` cannot flow back: `develop` takes squash merges only, so `main` would stop being its ancestor and every later promotion would refuse. In order:

1. **Roll back** production in Vercel (Instant Rollback) to the previous `main` deployment. This takes seconds and needs no git.
2. **Fix forward, fast.** The fix goes in as an ordinary PR to `develop`. Once its post-merge run is green, run **Promote develop to staging**, then **Promote staging to main** the same day, outside the usual schedule. This ships everything else on `develop` too, so unfinished work must stay behind its feature flag.
3. **Last resort:** an organization admin bypasses the rulesets. Record who did it, why, and what, in the release notes, and bring `develop` and `staging` back in line with `main` immediately.

### Trial: non-strict `develop` (from the ruleset change, two weeks)

`develop`'s strict setting was turned off as a reversible trial. We measure CI runs and minutes per merged PR, the length of the weekly build sync, how often `develop` goes red, and how long until it is green again. The rollback condition is agreed with the reviewer who owns the rulesets before the trial starts, for example: `develop` red more than twice, or for more than two hours in total. Rolling back means setting strict to `true` on the `develop` ruleset; `staging` stays either way.

The `E2E (hermetic)` journey `step-ownership` has timed out once in nine runs since #152 raised its budget; re-run the job before assuming the branch is at fault, and file a Hardening issue if it recurs.

## Releases and tags

`main` is promoted from `staging` by fast-forward, and the promotion tags it `vX.Y.Z` and publishes the GitHub release (`v0.5.0` MVP cut Sep 3, `v0.5.5` Sep 4, `v0.5.6` Labor Day beta Sep 7, `v0.6.0` one tenant per firm Sep 15). The tag is the version: `package.json` `version` is not bumped. Production deploys from `main` (Vercel), so a release's migrations reach the production database before `main` moves. A release is one Action run:

1. **Actions → Promote staging to main → Run workflow**, from `main`. Choose `patch` for a release of fixes only; the default is `minor`.
2. *Pin the staging commit to promote* pins the commit and writes to its summary the commits the release adds to `main`, the migration files it applies and the version it will tag. It stops here when `staging` and `main` are the same commit, or when that version already exists.
3. *Live smoke on staging* (`.github/workflows/e2e-live-smoke.yml`) runs `e2e/journeys/md-spine.spec.ts` from the pinned commit under the `live` project against the staging deployment, with its real Box, Resend and skill services. It is the release's one blocking live check (PL-18, owner decision 2026-10-16): red, or any `e2e-staging` secret missing, and the run stops before production is touched. A merge into `develop` and a promotion to `staging` stay hermetic. To prove the setup, or to retry after a third-party outage, run **Actions → E2E live smoke** with ref `staging`.
4. *Migrate database* applies the pending files to production from the pinned commit, with `supabase db push --include-all`, then runs `preflight:db`. It goes ahead only when the person who started or re-ran the run is listed in `MIGRATION_APPROVERS` on the `db-production` environment. For anyone else it stops before touching the database, and an approver who has read the summary takes it over with **Re-run failed jobs**.
5. Green: `main` fast-forwards to exactly the pinned commit and Vercel deploys it, then *Tag and publish the release* creates the tag and the release. Its notes list the migration files in the release, then every PR since the previous tag. Red: `main` does not move. The file that failed left nothing behind and the files before it stay applied; fix forward on `develop` and promote again.

If *Fast-forward main to staging* is rejected with `refusing to allow a GitHub App to create or update workflow`, the release changes a file under `.github/workflows/`, which the Action's own token may not push. Production is already migrated and `main` has not moved. An approver fast-forwards `main` to the pinned commit by hand, then chooses **Re-run failed jobs** on the same run: the fast-forward finds nothing left to do and the release is tagged. The same button finishes a run in which only *Tag and publish the release* failed. Do not start a new run in either case; it would stop at "nothing to promote". The same rejection can stop *Fast-forward staging to develop*, with the staging database already migrated: fast-forward `staging` by hand in the same way. It has not been seen yet: on 2026-10-14 *Fast-forward staging to develop* pushed five changed workflow files with the Action's token and was accepted. The recovery stays documented until a promotion to `main` has done the same.

A push to `main` that did not come from this Action also starts *Migrate database* against production. That is a net for a hand fast-forward, not a way to release: Vercel is already deploying by then, and the run stops unless the pusher is an approver. The promotion's own fast-forward does not start it, because a push made with an Action's token starts no workflow. A push to `staging` by a person starts the same workflow against the staging database.

The plan's migration list is the files the release adds since `main`. The ledger decides what is applied; the *Migrate database* summary lists what ran.

The approver list guards against accidents. It is not a security boundary: the `main` ruleset does not require a pull request, so anyone with write access can push to `main`. GitHub's required reviewers are not available for a private repository on the Team plan.

The one-time setup of the environments, their secrets, the approver list and the ledger baseline is in `../04-operations/production-bootstrap.md`. So is the first release after that setup, which still ships by hand: the Actions run from `main`, and `main` holds the old workflows until that release reaches it.

## Schema changes: expand, then contract

Migrations reach production before the code that needs them, and the code already live keeps serving traffic against the new schema until `main` moves. Every schema change is therefore split across releases:

1. **Expand.** Add the new shape: a table, a nullable column or one with a default, a wider CHECK, a new function. Guard it so it can re-run (`if not exists`, `or replace`, `not valid` on a superseded CHECK). Ship code that works whether or not the new shape is populated.
2. **Contract.** Drop or rename the old shape in a later release, once no deployed code reads or writes it. A rename is a contract: add the new name, move the code, drop the old name later. So is narrowing a CHECK.

Why: on Sep 4 the code from #125 wrote `deal_steps.bench_conversation_id` before its migration (`20260903130000_deal_step_bench_session.sql`) reached production, and most production 5xx errors that day were `column deal_steps.bench_conversation_id does not exist`. #134 added `preflight:db` to catch that drift, but nothing ran it until the promotion did.

The promotion's preflight only checks that the objects this build expects exist. It cannot see a contract step: a drop takes a line out of the snapshot, so the check still passes while the code that is live breaks. Only this rule prevents that.

## What "done" means

1. Merged to **`develop`**
2. Tests and build green on that merge
3. Issue closed (or sub-issue checked off under the correct epic)
4. Project board item moved to **Done**

Open PRs are **in flight**, not done. A draft PR on the board counts as In progress.

## GitHub project board

**Board:** [Conductia delivery](https://github.com/orgs/Conductia/projects/1) (org project; replaced FutureProofingDev project #3 on 2026-09-18, see #75)

### Fields

One sequencing field only: the repo **Milestone**, shared by name across `Conductia/Conductia` and `Conductia/conductia-agents-backend`.

| Field | Values |
|-------|--------|
| **Milestone** | `W2 Custom rails (Sep 21-25)` · `W3 Skill builder (Sep 28-Oct 2)` · `W4 Email safety (Oct 5-9)` · `W5 Skills wave and twins (Oct 12-16)` · `W6 Buyer, seller and Outlook (Oct 19-23)` · `W7 Acceptance and release (Oct 26-30)` · `MVP 3` · `Backlog` |
| **Status** | Todo · In Progress · In review · Done |
| **Lane** | Feature (a gate deliverable) · Hardening (bugs and prod findings, rolling, capped) · Docs · Decision (needs Storm or Lance) · Chore |
| **Flag** | The feature flag the work ships behind, if any (`project_rail_model`, `skill_authoring`, `mail_channel`, ...) |

Assignee is the owner. Labels keep the existing taxonomy (`theme: *`, `type: *`, `customer: *`, `bug`, `epic`, `needs-decision`, `from: legacy-repo`); the Labor Day labels (`beta-blocker`, `post-beta`, `labor-day-mvp`, `w1`..`w5`) are retired.

### Gates (MVP 2, from the scope doc)

| Milestone | Deliverable | Owner (proposed) |
|---|---|---|
| W2 | Add, hide or delete a step on any deal; inline renumbering; one time or permanent; save a rail and pick it at deal creation (#166, #167, #168, #117; PR #147) | Rob, Charles |
| W3 | Skill builder: describe, dedupe, preview, approve, scope, run; refine in chat; versions and rollback (#87, #88, #169; PRs #151, #180, backend #126, #137) | Charles |
| W4 | Email safety: Confidential tag, EXTERNAL RECIPIENT banner, recipient check (#170, #171, #172); CCO thresholds (#94) | Marcelo |
| W5 | About ten live skills, conflict check at partner approval, public-source twin profiles (#84, #85, #86, #90, #91) | Rob, RTS or Charles |
| W6 | Buyer and seller invitations, scoped access, per-person data-room permissions, send as the user from M365 (#100, #101, #102, #96, #95) | Martin |
| W7 | Realistic deal run, gap fixes, go/no-go (#173, #106, #108) | Lance, Rob |

Hardening items carry the milestone of the week they are scheduled in, never a gate of their own.

### Recommended views

- **Board** — group by Status.
- **By week** — table grouped by Milestone, sorted by Lane.
- **By owner** — table grouped by Assignee.
- **This week** — Milestone = current gate, Status is not Done.
- **Decisions** — Lane = Decision, not Done (the list to bring to the Tuesday build sync).

## Weekly scorecard (delivery review)

Use this template in the weekly delivery review issue or standup notes:

```markdown
## Delivery scorecard — YYYY-MM-DD (Wn)

### Live demo
[What was shown]

### Done
- …

### Next
- …

### At risk
- … (owner: …)

### One bottleneck
- … (owner: …, next action: …)
```

Escalate blockers within 24 hours.

## Scope changes

Labor Day scope was locked per ADR-0013 / D45 and delivered. MVP 2 scope was proposed in PR #146, which closed unmerged; it becomes locked on Storm's approval, with its own ADR and decision-log entry. Changes require **Storm** approval; Lance is accountable, Rob is product lead.

## Related docs

- [`labor-day-mvp-2026-08-03.md`](../02-product/labor-day-mvp-2026-08-03.md) — delivered scope (historical)
- [`ADR-0013-labor-day-mvp-scope-lock.md`](../07-decisions/ADR-0013-labor-day-mvp-scope-lock.md) — formal decision
- [`decision-log.md`](../07-decisions/decision-log.md) — D45
- [`github-project-triage-2026-08-04.md`](github-project-triage-2026-08-04.md) — one-time issue/board reconciliation log

## Issue numbering

The code moved from `FutureProofingDev/intelibank` to `Conductia/Conductia` on 2026-09-03 and issue and PR numbers restarted from #1. Older docs, ADRs and decision-log entries cite legacy numbers, and many of those now collide with unrelated items in this repo (`#31`, `#137`, `#145`, `#160`). Convention: a number from the old repo is always written `intelibank#N`; a bare `#N` means this repo. Legacy items that still matter were re-filed here (see #74 for the map).
