# Production bootstrap

How a Conductia database goes from empty to its first working organization.
Written against the production launch of 4 September 2026 (project
`fsaucpwponmzajupvsey`); every step below was executed there.

The ordering is not arbitrary. Two constraints drive it:

- `POST /api/v1/companies/onboard` is firm-admin only, and there is no admin UI
  in production (`/dev-api` returns 404 there). The first company can therefore
  only be created by an account that already holds `firm_role = 'admin'`, and
  nothing in the product can mint that account.
- `scripts/onboard-company.ts` signs in with a password grant, which is AAL1,
  while `requireApiUser` demands AAL2 from invite-created identities. The
  bootstrap admin must therefore be **seeded**, never invited.

## 1. Point the scripts at the right database

The database `npm run` scripts hardcode `--env-file=.env.local`, which is a
developer's own project (`preflight:env`, `preflight:db`, `db:migrate` and
`seed:flags:enable` take their target explicitly instead). `npm run db:migrate` against production is not a thing you can
type by accident, and must not become one.

`scripts/migrate.sh` is for a local or scratch database only. It prints the
target host before it applies anything and, for any env file other than
`.env.local`, requires the host typed back, but it writes no ledger, so it is
never pointed at a hosted database.

A full replay builds an empty database, which is what a bootstrap needs. It is
not safe over a lived-in one, and production has been lived in since the day it
launched. Some files do not re-run:

- Unguarded creates fail once the object exists:
  `20260808120000_invite_phase.sql`, `20260814120000_preferred_deal_role.sql`,
  `20260814190000_company_access_management.sql`,
  `20260814230000_setup_walkthroughs.sql`, `20260831150000_deal_folder_taxonomy.sql`.
- Validated CHECK re-adds narrower than a later migration fail once live rows
  hold the newer values: `20260721120000_conflicts_attestation.sql`,
  `20260730150000_mail_inbound_review_mailbox.sql`,
  `20260731120000_onboarding_invites.sql`, `20260804160000_invite_safeguard_2fa.sql`,
  `20260816150000_company_platform_permissions.sql`,
  `20260816170000_deal_step_and_lead_permissions.sql`,
  `20260901120000_access_request_leads_create.sql`. `audit_log` is append-only,
  so those rows cannot be cleared.

A replay stops at the first failure, and every file before it has been
re-applied. A live database is never replayed and never migrated by hand:
**Migrate database** applies only the files its ledger does not hold
(`../03-engineering/delivery-model.md`). A new empty database is built by the
same Action (A new database, below), which also writes the ledger.
`scripts/migrate.sh` writes none.

### The migration environments

Hosted databases are migrated only by the **Migrate database** Action
(`.github/workflows/migrate.yml`). It reaches each database through a GitHub
environment. Set them up once, as an owner of both the Supabase organization
and the GitHub repository.

| Environment | Database | Deployment branches | `MIGRATION_APPROVERS` |
|---|---|---|---|
| `db-dev` | Conductia-dev | `develop` | not set: anyone |
| `db-staging` | Conductia staging | `staging`, `main` | not set: anyone |
| `db-production` | production | `main` | the GitHub logins allowed to migrate production, comma-separated |

The Action also checks the commit it migrates from (`ref`), before it touches
the database: `db-dev` takes only a commit on `develop`, `db-staging` only one
on `staging`, and `db-production` one on `staging` or `main`. The one
exception is **Promote develop to staging**, which migrates staging from the
pinned `develop` commit before staging moves to it; only a call from that
workflow may use a `develop` commit on `db-staging`. A run from an unmerged
branch is refused with the command to run instead, for example
`gh workflow run migrate.yml --ref develop -f environment=db-dev -f ref=develop`.

1. **Create the environment** under **Settings → Environments**, with
   **Deployment branches and tags** set to *Selected branches and tags* and the
   branches above. `db-staging` allows `main` because the Promote Actions run
   from `main`. Do not name one `production`: names are case-insensitive and
   Vercel owns `Production`.
2. **Set `MIGRATION_APPROVERS`** as an environment variable on `db-production`
   before anything else. The Action refuses to migrate production while it is
   empty, and for any person not on it. Required reviewers are not available
   for a private repository on the Team plan, so this list is the gate. It
   guards against accidents; it is not a security boundary.
3. **Baseline the database's ledger** (below). Skip this for a database that
   is empty.
4. **Add the secret last.** `MIGRATION_DATABASE_URL` is the environment secret
   holding the **Connect → Session pooler (IPv4)** string for the `postgres`
   user (`postgres.<project-ref>`), with the password percent-encoded. GitHub
   runners have no IPv6. Never add it at repository or organization level.
   Until it exists the Action fails before it touches the database, so adding
   it last is what keeps an unbaselined database from being migrated.
   The Action also checks the string against the environment: only
   `db-production` may hold the production project's, and it must hold that
   one. The production project ref is written in the workflow, so a new
   production project means changing it there.

Supabase network restrictions refuse GitHub runners, so every run fails closed
while they are on. In Vercel, the Preview environment must point at the dev
project and the `staging` environment at the staging project; a preview on the
production database would bypass the promotion.

Rotate by resetting the database password in Supabase and updating the secret.

#### Baselining a ledger

A database migrated by hand has the schema and no record of which files built
it. The Action refuses such a database, because a push would replay every file
over it. Record the files once, from a machine that holds the connection
string, never from CI:

```bash
git fetch origin
git checkout --detach origin/main        # production. For dev: origin/develop
npm ci
export DB_URL='postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres'

env_file="$(mktemp)" && printf "DATABASE_URL='%s'\n" "$DB_URL" > "$env_file"
npm run preflight:db -- "$env_file"; rm -f "$env_file"
```

Stop here unless the checkout succeeded and the preflight printed its `✅`
line. Run the rest only then, one command at a time:

```bash
npx supabase@2.116.0 migration list --db-url "$DB_URL"
npx supabase@2.116.0 migration repair --status applied --db-url "$DB_URL"
npx supabase@2.116.0 db push --include-all --dry-run --db-url "$DB_URL"
```

- The preflight is the only evidence that the files were applied. It compares
  tables, columns, functions and policies by name, and the listed CHECK
  values. It does not see indexes, triggers, grants, function bodies or data
  changes. So baseline at the commit whose migrations are known to have been
  applied, not at a later one. If it names missing objects, those files are
  not applied. Run the repair below as written, then take each of those files
  back out with `migration repair --status reverted <version>`. The dry run
  must then list exactly those files, and the Action's first run applies
  them. Passing the other versions to `--status applied` one by one is not
  enough when the ledger also holds rows from another tool: they stay, and
  the push still refuses.
- `migration list` shows what the ledger holds now. A remote version with no
  local file was recorded by another tool. Until 2026-10-13 both hosted
  ledgers held only such rows, written by the Supabase connector under its own
  version numbers: 9 on dev and 55 on production. Until a ledger is baselined
  the Action refuses the database, because `db push` will not run past a
  version it has no file for.
- `migration repair --status applied` with no version asks for confirmation,
  then replaces the whole ledger with the local files. That also removes the
  rows another tool recorded. It writes ledger rows only and changes no
  schema. A file recorded here is never applied by the Action, whether or not
  the database really holds it.
- The dry run answers `Remote database is up to date.` once every file is
  recorded. It confirms the ledger matches the files, not that the baseline
  was right. Only then add the secret.

Rehearsed with CLI 2.116.0 against a local database, on 2026-10-09 with an
emptied ledger and on 2026-10-13 with a ledger holding only connector-style
rows: every file was recorded, the foreign rows were gone and the dry run
listed nothing. A third rehearsal that day left one file unapplied under
connector-style rows: after the repair and one `--status reverted`, the dry
run listed that file alone and the push applied it.

Both hosted ledgers were baselined on 2026-10-13. Production holds the 122
files of `main` at `22cf73bfc`. Dev was missing
`20261010120000_discovery_extract_estimate.sql`, so it was baselined with the
other 138 files of `develop`, and the Action's first run applied that one.

#### What the baseline did not check

On 2026-10-22 each hosted schema was compared with the schema its branch's
files build (`supabase db diff --linked --project-ref <ref>`, read-only on
the hosted side, CLI 2.117.0): dev against `develop`, staging and production
against `main`. The ledgers match the files exactly on all three (177, 139
and 139 files). Every diff also lists the `pgboss.queue_stats_*` daily
partitions, which pg-boss creates at run time; ignore them.

- **Staging** matches its files. It was built by the Action, not baselined.
- **Dev** holds three leftovers of the hand-applied era:
  - the unique index `companies_tenant_name_unique` on
    `(tenant_id, lower(name))`, which `20260818190000_lead_name_per_org.sql`
    drops. The three indexes that file creates exist beside it. Nothing
    records how dev came to hold both. With the old index, two banks in one
    tenant on dev cannot both register a lead of the same name, which that
    file allows.
  - `invites.expires_at` defaults to 7 days, not the 24 hours of
    `20260908110000_invite_ttl_alignment.sql`.
  - `PUBLIC`, `anon` and `authenticated` can execute
    `app_min_password_length`, `mailbox_consents_append_only`,
    `rail_template_reject_removed`, `rail_template_step_snapshot`,
    `work_identity_org_claim` and `work_identity_session_id`. A database
    built from the files grants them none of that
    (`20260929170000_close_definer_function_grants.sql` also narrows the
    default privileges).

  Dev also holds `rls_auto_enable()` and its `ensure_rls` event trigger.
  Hosted Supabase adds those itself (`20261016100000_definer_search_path_pg_temp.sql`);
  they are not drift.
- **Production grants less than its files do.** No file and no step in this
  runbook explains it:
  - `service_role` cannot execute 63 functions the files grant it,
    among them 20 `discovery_*` functions (`discovery_reader_pass_end`,
    `discovery_set_station` and others; not all of them, `discovery_extract_batch`
    keeps its grant), `site_register`, `site_unregister`, the
    `mailbox_consent_*` functions and the `work_identity_*` helpers. Staging
    grants them. A call to one of them as `service_role` is refused on
    production unless the function is reached some other way, for example
    from inside a definer function that holds the grant.
  - `anon` holds no read or write right on the Phase 1 tables (`deals`,
    `companies`, `users`, `documents`, `audit_log` and others), and
    `authenticated` only `select` (and `update` on `notifications`). Staging
    gives both `select`, `insert`, `update` and `delete`, with RLS deciding.
  - `service_role` lacks `update` and `delete` on `corrections`,
    `deal_skill_imports`, `deal_step_skill_runs` and `rail_catalog_changes`,
    and `delete` on `legal_holds`, `mail_warning_outcomes`,
    `rail_template_creations`, `setup_walkthrough_progress` and
    `skill_publication_operations`.
  - The default privileges of `postgres` in `public` are narrowed the same
    way, so a table a later file creates gets these narrower grants on
    production and the wider ones on staging.

  A run that passes on staging therefore does not show that the same call is
  permitted on production.

The baseline missed all of this because `preflight:db` compares names, not
indexes, grants, defaults or function bodies (Baselining a ledger, above). Any
fix is a new migration through the Action, never SQL by hand.

#### Before the first automated release

The promotion computes the next version from the newest `vX.Y.Z` tag `main`
holds. v0.7.0 shipped on Oct 7 untagged, at
`22cf73bfc0c6727d7e10347e2dcd8d8b081c1790`; its tag and release were created
on 2026-10-13, so v0.8.0 was numbered from it, and the next promotion is
numbered from v0.8.0. Every promotion prints the version it will tag in its
plan summary. Read it before migrating.

The Promote Actions run from `main`, which held the old workflows until the
release that carried the new ones reached it. That one release shipped by
hand, by a person listed in `MIGRATION_APPROVERS`, with these steps. They are
kept as the record of that release, not as steps for a later one:

1. Move `staging` to the green `develop` commit with **Promote develop to
   staging**. The old workflow migrates nothing, so start the migration
   afterwards, from the branch that now holds the workflow, and wait for it
   to go green:
   `gh workflow run migrate.yml --ref staging -f environment=db-staging -f ref=staging`.
   If the promotion's push is rejected (Releases and tags in
   `delivery-model.md`), fast-forward `staging` by hand; that push starts
   the same run on its own.
2. Apply the pending files to production from the commit `staging` holds,
   with `DB_URL` set as under Baselining a ledger, and check the result:

   ```bash
   git fetch origin
   git checkout --detach origin/staging
   npm ci
   npx supabase@2.116.0 db push --include-all --skip-vault --db-url "$DB_URL"
   env_file="$(mktemp)" && printf "DATABASE_URL='%s'\n" "$DB_URL" > "$env_file"
   npm run preflight:db -- "$env_file"; rm -f "$env_file"
   ```

   The ledger is baselined, so the push lists only the files `main` does not
   hold yet and asks before it applies them. Stop if the list holds anything
   else.
3. Fast-forward `main` by hand (`delivery-model.md`, Merge policy). The push
   starts **Migrate database** against production, which finds nothing left
   to apply.
4. Tag it: `gh release create vX.Y.Z --target <commit> --title vX.Y.Z --generate-notes --notes-start-tag v0.7.0`.

This release was v0.8.0. Step 1 ran on 2026-10-14: `staging` moved to
`develop` at `39c7d05a6` and the staging run found nothing to apply. Steps 2
to 4 ran on 2026-10-15; the v0.8.0 release notes record the push to
production at 17:20 UTC and that the GitHub Actions budget was exhausted
that day. `v0.8.0` tags `39c7d05a6`, which `main` and `staging` both still
hold (checked 2026-10-22). The **Migrate database** run that the push to
`main` started ran no step; the production ledger holds the 139 files of
`main` all the same.

From the next release on, both promotions are meant to be one Action run
each. **Promote staging to main** has not run yet (no run as of 2026-10-22),
so the next release is the first test of it.

#### A new database

An empty project needs no baseline. Create its environment and secret, then
run **Migrate database** from that environment's own branch, which is both
the branch the run starts from (each environment's deployment branches allow
it) and the commit it migrates (the guard refuses any other):
`gh workflow run migrate.yml --ref <branch> -f environment=<env> -f ref=<branch>`,
with `develop` for `db-dev`, `staging` for `db-staging` and `main` for
`db-production`. The push builds the whole schema and writes the ledger. Rehearsed locally, the result matches
`supabase/schema-snapshot.txt` exactly.

#### The staging database

Conductia staging (`sfiqfmqecormenlfoklc`) was built this way on 2026-10-13
from `develop` at `032fb1c60`: 139 files, `preflight:db` green. `main` did not
hold the workflow yet, so the run was started with
`gh workflow run migrate.yml --ref develop`, under a `develop` branch rule on
`db-staging` that was removed as soon as the job had started.

Since 2026-10-14 the staging deployment reads it. Vercel builds `staging` in
a custom environment of its own, `staging`, served at
`https://conductia-env-staging-conductia.vercel.app` behind Vercel login. That
environment holds its own `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` and
`DATABASE_URL`, and shares every other variable with Preview, the Resend
settings included, so staging sends real mail, as develop does. The old branch link,
`conductia-git-staging-conductia.vercel.app`, still serves the last Preview
build of `staging` (6 October), which reads Conductia-dev. Do not use it.

Staging is a pre-production for testing without `develop`'s churn, not a
bootstrap, so its data is the demo seed rather than sections 5 to 7:

- **Auth URLs (section 3):** Site URL
  `https://conductia-env-staging-conductia.vercel.app`, Redirect URLs
  `https://conductia-env-staging-conductia.vercel.app/**`, Email OTP
  Expiration `86400`.
- **Data:** the demo seed, with dev's `SEED_PASSWORD`, then the same rows
  switched on in `feature_flags` as on dev. `npm run seed` reads `.env.local`,
  so run the scripts directly, with an ignored env file holding the staging
  project's `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  and `SUPABASE_SECRET_KEY`:

  ```bash
  node --env-file=.env.staging.local --import tsx scripts/seed-flags.ts
  SEED_PASSWORD='...' node --env-file=.env.staging.local --import tsx scripts/seed-users.ts
  ```

  Both are idempotent. Neither checks which project it writes to, and
  `node --env-file` does not override a variable already exported in the
  shell.
- **Not done:** Google and Microsoft sign-in. Only the email provider is
  enabled on the staging project, so the work sign-in buttons fail there.
  The owner steps for the Microsoft provider, on dev first, are in
  [`m365-sso-runbook.md`](./m365-sso-runbook.md).
- **The release's live smoke** (`.github/workflows/e2e-live-smoke.yml`) runs
  against this deployment and reads its secrets from the GitHub environment
  `e2e-staging`: `E2E_BASE_URL` (the URL above), `E2E_SUPABASE_URL` and
  `E2E_SUPABASE_PUBLISHABLE_KEY` (the staging project's), `E2E_SEED_PASSWORD`
  (the `SEED_PASSWORD` staging was seeded with) and
  `VERCEL_AUTOMATION_BYPASS_SECRET` (Vercel → project → Deployment Protection
  → Protection Bypass for Automation), which gets the journey past the Vercel
  login. Until the first four are set, **Promote staging to main** stops at
  the smoke. Prove the setup with **Actions → E2E live smoke**, ref
  `staging`.
  As of 2026-10-22 the `e2e-staging` environment does not exist, and the
  smoke (#572) is on `develop` only. The Promote Actions run from `main`, so
  the smoke gates a release only once an earlier release has carried #572
  to `main`.

The app's Content-Security-Policy is built from `NEXT_PUBLIC_SUPABASE_URL` at build time, and `CSP_REPORT_ONLY=1` (a non-sensitive variable on one environment, then a redeploy) switches it to report-only. The steps, the smoke checklist and the host inventory are in [`csp-runbook.md`](./csp-runbook.md).

## 2. What the migrations do and do not create

They create the schema and the reference catalogs only: the `roles` catalog,
`company_permissions`, and the data room storage bucket. Everything else that
looks like an insert is either a function body being defined or an
`insert ... select` backfill that reads existing rows — on an empty database
those write nothing.

A healthy freshly migrated database has zero rows in `companies`, `users`,
`auth.users`, and `feature_flags`.

The bank Compliance role is **not** a gap. `20260902120000_gate0_notify_permission.sql`
backfills it only for companies that already exist, but it also installs the
`seed_bank_compliance_role_on_membership` trigger on `users`, which creates the
role when the first member is attached to the bank company.

## 3. Configure the hosted project's auth URLs

**`supabase/config.toml` governs the local stack only.** A hosted project keeps
its own URL configuration in the dashboard, and a newly created one starts on
the factory default `http://localhost:3000`.

This bit the September launch. `deliverInvite` passes
`redirectTo: ${origin}/accept-invite`, but GoTrue honours a redirect only if it
matches the project's Site URL exactly or one of the allowlisted patterns.
Neither matched, so it silently fell back to the Site URL and the first director
received a link pointing at `http://localhost:3000` — no error anywhere, and
`deliveryStatus` still reported `sent`.

In **Authentication → URL Configuration** for the target project:

- **Site URL** — the deployment origin, e.g. `https://app.conductia.com`
- **Redirect URLs** — add `https://app.conductia.com/**`

The `/**` is required. Without it `/accept-invite` does not match and the
fallback happens again.

Set the same origin as **`NEXT_PUBLIC_APP_URL`** on the deployment. The three
invite senders (`POST /api/v1/invites`, the resend endpoint, and
`POST /api/v1/companies/onboard` — the one `scripts/onboard-company.ts` fires)
build `redirectTo` from it. When it is unset they fall back to the origin of the
incoming request, which is whatever host called the API: a script run through a
tunnel, an internal hostname, or a `*.vercel.app` preview all mint links
pointing at themselves.

Verify without sending anything or creating an identity: `generateLink` returns
the URL rather than mailing it, and `type: 'recovery'` against an account that
already exists touches nothing.

```bash
node --env-file=.env.production -e '
const { createClient } = require("@supabase/supabase-js");
createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false } })
  .auth.admin.generateLink({
    type: "recovery",
    email: "<an existing account>",
    options: { redirectTo: "https://app.conductia.com/accept-invite" },
  }).then(({ data }) =>
    console.log(new URL(data.properties.action_link).searchParams.get("redirect_to")));
'
```

If that prints the app origin the allowlist is live; if it prints the Site URL,
the setting has not taken effect.

### A project shared by several deployments

Since 2026-10-14 staging has its own project and Site URL (The staging
database, above). Conductia-dev is still shared: `develop` and every branch
other than `staging` and `main` deploy as Vercel Preview and read it (see
[delivery model](../03-engineering/delivery-model.md)). That project has one
Site URL, develop's, so every redirect another preview asks for must be
allowlisted on its own, or GoTrue sends the user to develop instead. This is
the most likely cause of #394, where Google Workspace sign-in on staging
finished on develop while staging still read Conductia-dev. The work sign-in routes
(`/auth/work/*`) build their `redirectTo` from `NEXT_PUBLIC_APP_URL` exactly as
the invite senders do.

For each extra deployment on a shared project:

- add `https://<its origin>/**` to that project's **Redirect URLs**, beside
  develop's entry; leave the Site URL on develop
- leave **`NEXT_PUBLIC_APP_URL`** unset on pre-production (the redirect then
  uses the host the request arrived on), or scope it per environment; a value
  shared across "All Pre-Production Environments" points staging at develop
- allowlist every host people actually open a preview on: a per-deployment
  `*.vercel.app` URL or a custom domain that is not in the list falls back to
  the Site URL, i.e. develop. Conductia-dev carries
  `https://conductia-*-conductia.vercel.app/**` for this; note that it accepts
  every team preview deployment as a sign-in redirect target

Check it with the snippet above, run against an env file holding
Conductia-dev's URL and secret key rather than `.env.production`, with `redirectTo` set to
`https://<preview origin>/auth/work/callback`: it must print that URL, not
develop's origin.

### Email OTP Expiration

Same screen family, **Authentication → Emails → Email OTP Expiration**. A new
project ships at `3600`. Set it to `86400`, the maximum Supabase allows.

This is the second thing that bit a launch. The link an invitee clicks is a
GoTrue one-time token governed by this setting and nothing else: not
`invites.expires_at`, not the invite email's copy. At the Ignatious launch on
7 September 2026 it was still `3600`, the director's link died an hour after
delivery, and he opened it the next morning. `auth.one_time_tokens` still held
an unredeemed `confirmation_token` with `updated_at` equal to `created_at`,
which is how you tell an expired token from a consumed one — GoTrue deletes the
row on redemption.

`invites.expires_at` now defaults to 24 hours to match
(`20260908110000_invite_ttl_alignment.sql`, mirrored by `INVITE_TTL_HOURS`).
Lowering this dashboard setting below 24 hours silently reintroduces the
mismatch in the other direction, and the emails hedge with "within" for exactly
that reason.

## 3b. Prove the environment can actually deliver mail

```bash
npm run preflight:env .env.production
```

`RESEND_FROM` (invitations) and `EMAIL_FROM` (the screened outbox) must both be
addresses on a verified Resend domain. Left unset, the send used to fall back to
`onboarding@resend.dev`; Resend **accepts that send and returns 200**, so the
invite reported `deliveryStatus: 'sent'`, the UI went green, and the only inbox
that ever received the mail was the Resend account owner's. Nothing in the
product could see it, and no error row or resend prompt appeared.

Both variables are now required outside `NEXT_PUBLIC_APP_ENV=dev` — a missing
one raises at send time instead of degrading silently — but the point of this
step is to find that out here rather than on the first real invitation. The same
check covers `RESEND_API_KEY` (absent, with no deliberate `EMAIL_PROVIDER=noop`,
the outbox simulates the send while the audit row reads as sent) and
`NEXT_PUBLIC_APP_URL` from step 3.

Run it alongside the schema preflight:

```bash
npm run preflight:db .env.production
```

The same command checks the Ignatious agent configuration: every Ignatious URL
(`IGNATIOUS_CONTROL_PLANE_URL`, `IGNATIOUS_API_URL`, `IGNATIOUS_SKILL_BENCH_URL`,
`CONDUCTIA_PUBLIC_URL`) must be an absolute https origin with no trailing `/v1`,
since the clients append `/v1/...` themselves. In production
`IGNATIOUS_TENANT_ID` must be set (an explicit `tn_demo` passes) and
`IGNATIOUS_LEAD_ID` must not be. Every Vercel build runs those Ignatious checks
against its own environment (`buildCommand` in `vercel.json`), so a bad value
fails the deploy instead of the first agent run.

After go-live **Migrate database** runs the schema preflight itself (step 1,
The migration environments). Before a manual fast-forward of `main`, run it by
hand against production (`../03-engineering/delivery-model.md`, Merge policy).

## 4. Feature flags

Flag rows are created disabled by default (ADR-0007), and
`POST /companies/onboard` 404s while `platform_onboarding` is off.

```bash
node --env-file=.env.production --import tsx scripts/seed-flags.ts
```

Then enable deliberately. Do **not** use `scripts/enable-flags.ts`: it refuses
to run when `NEXT_PUBLIC_APP_ENV=prod`, and it switches on every flag in the
registry. Flip the specific rows in `feature_flags` instead.

`mail_channel` deserves its own decision — it is the server-side kill switch for
a channel that can send real external email.

## 4b. The skill publication sweep

`vercel.json` declares a cron job: every five minutes Vercel calls
`GET /api/v1/internal/skill-publications/process` on the production deployment
with `Authorization: Bearer $CRON_SECRET`. Set on the Vercel project, per
environment:

- `CRON_SECRET`: generated independently (`openssl rand -hex 32`). Without it
  the sweep is refused and stuck publications advance only by hand.
- `SKILL_PUBLICATION_PROCESSOR_TOKEN` (and `_PREVIOUS` during rotation): the
  token for driving the sweep by hand (README, Skill publication operations).
- `IGNATIOUS_SKILL_BENCH_URL` and `IGNATIOUS_PUBLICATION_SERVICE_TOKEN`: both
  required, explicitly, for publication. The bench URL has no fallback to the
  control-plane host; `npm run preflight:env` fails when the token is set
  without it.

Vercel runs cron jobs only on production, so staging and previews get no sweep.

## 5. The bootstrap firm admin

```bash
ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='...' \
  node --env-file=.env.production --import tsx scripts/bootstrap-firm-admin.ts
```

`handle_new_auth_user` mirrors `firm_role` straight out of user metadata, so no
manual `UPDATE` is needed. The script is idempotent and never resets an existing
account's password.

Use a dedicated operations address, not a person's account. Under
`MFA_ENFORCEMENT=invite_only` this identity is exempt from 2FA — it is the one
account in production that is — which is why it should be suspended once the
first organization has a real director.

Do not reuse the `RESEND_FROM` sender address: an address with a live account
can never be invited as a normal user afterwards (`create_invite` raises
`active_account`).

## 6. The first organization

```bash
APP_URL=https://app.conductia.com \
COMPANY_NAME=Conductia COMPANY_TYPE=bank \
OWNER_EMAIL=owner@example.com AUTO_CONFIRM=1 \
  node --env-file=.env.production --import tsx scripts/onboard-company.ts
```

Expect a two-step exchange. A brand-new company has no verified domains, so the
first call creates the company and answers `409 domain_confirmation_required`;
`AUTO_CONFIRM=1` re-submits with the returned confirmation id. This is why a
successful response reports `"created": false` — the company was made on the
first call and found on the second.

The owner must be a different address from the bootstrap admin, for the
`active_account` reason above.

Onboarding a `bank` mints a **new tenant** for it, because a bank is a firm and a
firm owns a tenant. Every other type (`client`, `target`, `counterparty`) is a
party in the onboarding firm's book and stays in that firm's tenant, so it can be
put on a deal. The bootstrap admin therefore ends up in a different tenant from
the firms it creates, which is why `create_invite` and
`prepare_invite_domain_confirmation` let a firm admin — and only a firm admin —
provision across a tenant boundary.

### Splitting a firm that shares a tenant

Firms onboarded before `20260915120000_tenant_per_organization.sql` inherited the
bootstrap admin's tenant, so two banks could share one. That is #156: because
`is_external` is derived from company type, the second bank's staff cleared it,
counted as the first bank's internal staff, and could enumerate its client leads.

Rehearse the move, read the row counts, then apply it:

```bash
DATABASE_URL="$(node --env-file=.env.production -e "process.stdout.write(process.env.DATABASE_URL)")"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v COMPANY=Ignatious -v FINISH=rollback -f scripts/split-company-tenant.sql
# read the output, then re-run with -v FINISH=commit
```

It moves the firm, its members, anyone still holding a pending invite to it, and
every row attributable to it. The `auth.users` metadata moves in the same
transaction on purpose: `handle_new_auth_user` seeds `users.tenant_id` from
`raw_user_meta_data.tenant_id`, and `accept_invite` refuses when the invite's
tenant and the accepting user's tenant disagree, so moving the rows alone would
silently break every pending invitation. The script refuses the move outright if
the firm is entangled with the tenant it is leaving — a deal party, a seat on
another firm's deal, or counterparties left behind.

## 7. Acceptance closes the bootstrap

The owner receives two emails: the six-digit challenge first (deliberately, so
that no credential link escapes if delivery fails partway), then the link. They
set their own password and enrol TOTP — `MFA_ENFORCEMENT=invite_only` makes 2FA
mandatory for invite-born identities.

Their acceptance is what satisfies the `company_has_director` invariant; a
memberless company row is legal until then. It also fires the Compliance role
trigger from step 2.

Everyone else should be invited from inside the product, so they arrive with
their own passwords and 2FA. Then suspend the bootstrap admin.

A firm admin may invite into another tenant only while that tenant is
unprovisioned (no user in it beyond pending invitees), and only without a deal.
Each invitation records at issue that it was sent under this provisioning
exception, and acceptance honours that record, so every invitation the admin
sent before the first invitee went active can still be accepted afterwards.
Once the tenant is provisioned the admin can send no new invitation into it
(`tenant_mismatch`): the organization's director invites the rest. An
invitation that crossed tenants without that record (one issued before the
record existed into a tenant that was already provisioned) is refused at
acceptance with `inviter_not_authorized` and has to be re-issued by the director.

Suspend the bootstrap admin only after every invitation it issued has been
accepted or revoked: acceptance re-checks that the inviter is still active and
still holds the authority the invitation was issued under, so an invitation
still pending when the admin is suspended can no longer be accepted (the
recipient sees "The sender can no longer grant this access") and has to be
re-issued.

## Recovering a bad invitation

```bash
APP_URL=https://app.conductia.com INVITE_ID=<uuid> \
  node --env-file=.env.production --env-file=.env.bootstrap.local \
  --import tsx scripts/resend-invite.ts
```

Resend rotates the credential nonce, which retires the previously delivered
pair, and re-issues the six-digit challenge at the next `challenge_version`.
Tell the recipient which version to use: the number is in the subject line and
in the body, and a rotated code is not necessarily numerically larger than the
one it replaces. Wrong codes consume attempts and can lock the challenge.

**Resend is only a recovery path inside the 24-hour window.**
`rotate_invite_credential` refuses a row whose `expires_at` has passed, so a
lapsed invitation answers `409` and is terminal. Recovery from there is a fresh
invite, created from inside the product or through `POST /api/v1/invites`;
`create_invite` flips the stale `pending` row to `expired` first, which frees
the partial unique index on the email.

Fix the underlying cause first. A resend regenerates the link against the same
project configuration, so if step 3 is still wrong it reproduces the identical
broken URL, and `deliveryStatus: 'sent'` will not tell you otherwise. If the
recipient is a person rather than a script, resend while they are at their desk:
the clock starts at delivery.
