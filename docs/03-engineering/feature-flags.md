# Feature Flags — How To

Practical guide for creating, configuring, and consuming feature flags. For the
*why* (architecture and decisions), see
[`../07-decisions/ADR-0007-supabase-backend-feature-flags.md`](../07-decisions/ADR-0007-supabase-backend-feature-flags.md).

---

## The model in one minute

- **Code-owned keys.** The set of flags that exists is defined in code: the
  `FLAG_REGISTRY` in `src/lib/flags/keys.ts`. `FlagKey` is derived from it, so
  every flag lookup is type-checked. A row in the DB whose key is not in the
  registry is **inert** — the code never reads it.
- **The DB owns the runtime state.** The `feature_flags` table holds each flag's
  `enabled` boolean. The registry owns *existence*; the table owns *on/off*.
- **Per-environment by project.** Each environment is a separate Supabase project
  (the shared `-dev` project, the staging project and the production project; ids
  and keys live in the env files, see `../04-operations/production-bootstrap.md`),
  each with its own `feature_flags` table, seeded separately. A flag can be on in
  dev and off in prod. There is **no `environment` column** — the app reads
  whichever project its env vars point to. `npm run seed:flags:enable` turns on
  *every* registry flag; it refuses when `NEXT_PUBLIC_APP_ENV=prod` and refuses a
  non-local host unless `E2E_ALLOW_REMOTE_FLAGS=1`. Staging and production flags
  are flipped row by row.
- **Fail-closed.** An unknown key, a missing row, or any read error resolves to
  `false`. A capability is on only when its row is explicitly `true`.
- **Server-side reads.** Reads go through the secret key (server only). Client
  components read through `FlagsProvider`, mounted in the `(authed)` layout (D38),
  so `useFlag(key)` works anywhere inside the shell.

---

## Create a new flag

Example: a flag named `my_new_flag`.

### 1. Register it in code — `src/lib/flags/keys.ts`

```ts
export const FLAG_REGISTRY = {
  gate0_api_create: { description: 'Route the Gate 0 wizard through POST /api/v1/deals.' },
  my_new_flag: { description: 'What this flag gates.' }, // ← add
} as const satisfies Record<string, FlagDefinition>;
```

This makes `FlagKey` include `'my_new_flag'` (type-checked everywhere) and lets the
seed materialise it. Commit this — it goes through the PR.

### 2. Materialise it in the database — seed

```bash
npm run seed:flags
```

Upserts the new flag with `enabled = false` (the column default), without touching
the toggles of flags that already exist. It runs against the environment your
`.env.local` points to. For staging/prod, run it pointed at each project's keys
(and the table must exist there first — a hosted environment is migrated by the
**Migrate database** workflow, never by `npm run db:migrate`; see `delivery-model.md`).

### 3. Configure it (enable/disable) — in the table

The flag is born `false`. To turn it on for an environment, set `enabled` in that
environment's table:

```sql
update feature_flags set enabled = true where key = 'my_new_flag';
```

Do this via the Supabase dashboard (Table editor), the SQL editor, TablePlus, or
(later) the management UI. Toggling is per environment.

### 4. Consume it (so it actually changes behavior)

**Server component / route handler** (works today):

```ts
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';

if (await isEnabled('my_new_flag', supabaseFlagSource)) {
  // ...
}
```

**Client component** (`'use client'`), inside the `(authed)` shell:

```ts
import { useFlag } from '@/lib/flags/FlagsContext';

const on = useFlag('my_new_flag');
```

---

## The registry today (`src/lib/flags/keys.ts`, 2026-10-24)

| Key | Gates |
|---|---|
| `gate0_api_create` | Gate 0 wizard through `POST /api/v1/deals` instead of the localStorage fixture path (D38).
| `mail_channel` | The compliance email surface (screen, outbox, inbox, inbound webhook, mailbox connect); the server-side kill switch.
| `platform_onboarding` | Invite lifecycle, accept page, room-split data room, phase controls, external scoped shell.
| `company_access_management` | Company-scoped roles, direct grants, effective permissions.
| `setup_walkthroughs` | Setup readiness and versioned walkthroughs (#125).
| `workbench_top_nav` | 56px light top-nav shell replacing the sidebar (D48).
| `book_view` | The Book home preview (intelibank#191).
| `project_rail_model` | The project-owned rail: server-driven structure, removal, restoration (#147).
| `skill_authoring` | Durable skill authoring and candidate preview (#151, #180).
| `rail_templates` | Save and replace named company rails, and choose one at Gate 0.
| `mail_jev_second_opinion` | Jev (TypeSafe AI, through the AI Gateway) as a second opinion on a send-time rule flag (D82).
| `teaser_sandbox_runner` | The sandbox Teaser runner on rail seq 36, on fixed Atlassian content.
| `template_change_review` | Template change review on the deal rail (`/deals/{dealId}/rail/template-changes`).
| `deal_discovery` | Deal discovery: the `/discovery` candidate list and its routes.
| `deal_data_room_nav` | The external Data Room row in the per-deal nav (off for MVP 2; internal Deal Folder only).
| `discovery_worker_enabled` | The discovery ingestion worker's own pause switch.
| `discovery_model_proposals_demo` | Demo only (#460): model proposals for mail the codename rules did not route.
| `work_identity_onboarding` | Work-account invitations, Google Workspace or Entra sign-in, identity connect, `/join`.
| `skill_output_revisions` | Comments, hand edits and immutable revisions on a skill run's output.

Which of these are on in each environment is only in that environment's table, not derivable from code. `tests/flags-doc.test.ts` keeps this table in step with the registry.

### `rail_templates` is off by default, and has an order of enablement

`rail_templates` never acts alone. Every rail template route refuses unless
`rail_templates`, `project_rail_model` and `gate0_api_create` are all enabled
(`TEMPLATE_FLAGS` in `src/lib/railTemplates/access.ts`), and the two UI entry
points read the same three. Turning it on before the others changes nothing.

Enable it only after all of the following hold in the target environment.

1. **The project rail is backfilled.** A saved rail refuses a source whose steps
   carry no `phase_index` / `display_order` (`This rail is not on the project
   rail model yet.`). Any deal expected to be a template source must already be
   on the project rail model.
2. **Every rail template migration is applied**, from
   `supabase/migrations/20260921100000_rail_templates.sql` through
   `20261008100000_retire_old_saved_rails.sql`. The last one retires templates
   saved before the catalog: they leave the Gate 0 picker and the rail has to be
   saved again from its deal. Apply it before the code that ships with it is
   live: that code reads only templates the catalog published, and it names the
   deal when it looks up a retried save, which the earlier function does not
   accept.
3. **The Ignatious backend carries its migration 004 and the retain that names
   no source project** (#148 in the skill service repository). Retention and
   import are the backend's `/v1/conductia/rail-templates` routes; without them
   every save of a skill-bearing rail answers 503 `provider_unavailable`, and
   without the second a save is refused when it carries a skill.
4. **`IGNATIOUS_SKILL_BENCH_URL` and `IGNATIOUS_PUBLICATION_SERVICE_TOKEN` are
   configured.** They are the same pair skill publication uses. Unconfigured,
   the save fails with `Skill retention is not configured on this environment.`
5. **Skill capability is on.** With `skill_authoring` off, a save or a create
   that carries any skill fails explicitly (`skill_unavailable`). It never
   silently drops the skills and copies the structure alone.
6. **The binding-drift check has been run.** Read below; this is the one check
   that cannot be made from a development stack.

### The binding-drift check, before enabling anywhere with real deals

Since the skill-enhancement work, a rail step whose effective binding matches no
publication operation and no import is a `ComparisonSetIntegrityError` rather
than a step quietly left out of duplicate comparison. That error pauses skill
publication on the deal, with backoff, until the data is repaired. It is the
behaviour the design asks for, but it is a behaviour change with production
reach: a deal already carrying such legacy data would start pausing publication
the moment this ships to it, whether or not anyone uses a saved rail. It is also
not behind this feature's flags. `buildComparisonSet` is reached from the
publication processor, which runs under `skill_authoring`, so the change lands
anywhere that flag is already on.

Match the code exactly or the check is worthless. `buildStepTargets` keys every
lookup on `bindingKey` = `skillId:versionId:digest`
(`src/lib/skillPublication/comparisonTargets.ts`), and the import fallback in
`src/lib/skillRun/publicationMetadata.ts` rejects a row whose `skillId` or
`digest` differs even when the version matches. A version matched on its own is
not a match, and the step that names the right version under a **different
digest** is the reachable case: it resolves to neither map and throws.

Two further rules the query has to follow:

- A step that has a `deal_step_skill_bindings` row is resolved from **that row
  alone**. If the row is not a usable publication binding (`kind` is not
  `publication`, or any of `skill_id`, `version_id`, `digest` is null) the step
  contributes no binding at all and cannot trip the error, so it must not be
  reported. The step definition is read only when there is no binding row.
- Removed steps (`removed_at is not null`) are skipped by the same code and are
  not a stop.

```sql
with effective as (
  select
    s.deal_id,
    s.id as deal_step_id,
    s.step_id,
    coalesce(b.skill_id::text,   s.definition -> 'skillBinding' ->> 'skillId')   as skill_id,
    coalesce(b.version_id::text, s.definition -> 'skillBinding' ->> 'versionId') as version_id,
    coalesce(b.digest,           s.definition -> 'skillBinding' ->> 'digest')    as digest
  from deal_steps s
  left join deal_step_skill_bindings b on b.deal_step_id = s.id
 where s.removed_at is null
   and case
         when b.deal_step_id is not null then
           b.kind = 'publication'
           and b.skill_id is not null
           and b.version_id is not null
           and b.digest is not null
         else
           s.definition ->> 'type' = 'skill'
           and s.definition -> 'skillBinding' ->> 'skillId' is not null
           and s.definition -> 'skillBinding' ->> 'versionId' is not null
           and s.definition -> 'skillBinding' ->> 'digest' is not null
       end
)
select e.deal_id, e.deal_step_id, e.step_id, e.skill_id, e.version_id, e.digest
  from effective e
 where not exists (
     select 1 from skill_publication_operations o
      where o.deal_id = e.deal_id
        and o.published_skill_id::text = e.skill_id
        and o.published_version_id::text = e.version_id
        and o.published_digest = e.digest)
   and not exists (
     select 1 from deal_skill_imports i
      where i.deal_id = e.deal_id
        and i.skill_id::text = e.skill_id
        and i.version_id::text = e.version_id
        and i.digest = e.digest);
```

A non-empty result is a stop. Repair or remove those steps first, or publication
pauses for the whole deal. An empty result clears the flag for enablement.

An earlier revision of this check matched `published_version_id` alone. It
returned nothing for a step bound to the right version under a different digest,
which is the one case it existed to catch, and it reported steps whose binding
row is a mount, which the code skips. If you are adapting this query, verify it
against a case you construct rather than against whatever the database happens
to hold: a stack with no drifted digests cannot tell a correct check from a
useless one, and the local stack this was written on could not.

There is a second, rarer cause of the same pause: an operation that matches the
full triple but carries an unparseable `capability_contract`. It raises
`unparseable_capability_contract` from the same place. No query for it is
offered here because none has been verified; if publication pauses on a deal the
query above cleared, read the error code before assuming this check was wrong.

---

## Toggle an existing flag

No code change needed — just set `enabled` in the target environment's table
(step 3 above). With no caching wired yet, server-side reads pick up the change on
the next render.

> A row alone is not enough to *introduce* a flag: without step 1 (the registry),
> the code will not read it (fail-closed). The table only controls on/off for flags
> the code already knows about.

---

## Quick reference

| Task | What | Where |
|---|---|---|
| New flag | add to `FLAG_REGISTRY` | `src/lib/flags/keys.ts` (code, via PR) |
| Materialise | `npm run seed:flags` | creates the row (`false`) in the env DB |
| Enable/disable | `update feature_flags set enabled = …` | the table, per environment |
| Read (server) | `isEnabled(key, supabaseFlagSource)` | server components / route handlers |
| Read (client) | `useFlag(key)` | client components inside `(authed)` |

**Files:** `src/lib/flags/` (`keys.ts`, `source.ts`, `isEnabled.ts`,
`supabaseSource.ts`, `resolveFlags.ts`, `FlagsContext.tsx`) ·
`supabase/migrations/` (table + RLS) · `scripts/` (`seed-flags.ts`,
`check-db.ts`, `migrate.sh`, `check-pg.sh`).

**Scripts:** `npm run db:migrate` · `npm run seed:flags` · `npm run check:db` ·
`npm run check:pg`.

Source: ADR-0007; decision-log D27.
