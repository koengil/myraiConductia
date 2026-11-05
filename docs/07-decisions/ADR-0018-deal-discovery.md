# ADR-0018: Deal discovery (two zones, RLS-first reads, deterministic routing, corrections that stick)

Status: Accepted, September 30, 2026 (epic #261; the deal-discovery demo path, design
phases 6 to 12). Decision: D70. Builds on D68 (#262, the mailbox allowlist and guard) and
ADR-0017 (hybrid data residency). Extends ADR-0016's RLS backstop to the discovery tables.
Companion: [ADR-0019](./ADR-0019-milestones-stage-engine-promotion.md) (milestones, the
stage engine, promotion). Runbook:
[`deal-discovery-demo-runbook.md`](../03-engineering/deal-discovery-demo-runbook.md).

## Context

Discovery turns a banker's own mail into proposed deals. The tracer on `develop` read
mail through a fixture reader, normalized it, routed it by three firm rules, clustered it
by code name and listed `proposed` candidates under RLS. Nothing wrote a correction. The
demo needs a banker to rename, reject, re-station and merge a candidate, and to promote
one into a real mandate, without any of that being undone the next time the worker runs.

Two facts shape the design. Mail is the most sensitive content the platform holds, and
D68 already decided that a mailbox is readable only while its owner's invitation and
opt-in allow it. And the platform has two trust models side by side: session reads under
RLS, and Gate 0's service-role deal creation. Discovery touches both.

## Decision

1. **Two zones in one database.** Shared Postgres, `tenant_id` as the isolation boundary
   (ADR-0016). Within the application there are two zones, and each route lives in exactly
   one.
   - **The discovery zone** (`src/app/api/v1/discovery/**`, `src/app/(authed)/discovery/**`)
     reads with the signed-in user's session client. RLS answers. Only the route itself
     and `src/lib/discovery/api.ts` may name a mailbox-derived table (the agent-surface
     test's session-data rule), so every session read lives in `api.ts`.
   - **The deals zone** holds Gate 0's routes. `POST /api/v1/deals/from-discovery`
     follows `POST /api/v1/deals`: `requireApiUser()`, the same validator, an admin
     client, and a service-role RPC that takes the actor from the verified session. It
     reaches mailbox data only through a named service-role definer RPC, which #262's
     agent-surface test accepts through a `definer_rpc` declaration (E5). The route
     imports nothing from `src/lib/discovery/`, and the rail marker reads its type from
     `src/lib/deals/evidenceSuggestion.ts` for the same reason.
   - The classification process (`worker/classify.ts`) and the deal-zone extractor
     (`worker/extract.ts`) never share an import path to a reader or to the model
     gateway. The reader fence keeps readers out of the extractor, and the model fence
     keeps models out of classification.

2. **RLS-first reads.** Every user-visible read, including the decision history and the
   rail marker, answers under the viewer's own session through the existing visibility
   helpers (`app_can_see_candidate`, `app_can_see_item`, `app_is_deal_member`,
   `app_is_deal_overseer`). A colleague's mail arrives as metadata. There is no
   service-role read on behalf of a user except promotion, which asserts
   `app_can_see_candidate` for the acting user first. The stored-text read for the
   extractor is one service-role definer, `discovery_extract_batch`, which returns only
   items with a firm or confirmed, unrejected link and an allowed source, so withdrawn
   consent stops extraction exactly as it stops visibility.

3. **Deterministic firm routing.** The routing rules are code, not a model: three firm
   rules, then clustering by code name. The same mail always routes the same way, and the
   expected outcomes live in test files, never in the corpus. Tentative routes stay
   separate from firm ones, and a tentative misroute leaks nothing (architecture Q7).
   Alias routing is whole-word, so the corpus never writes another deal's code name in
   mail that must not route to it.

4. **Append-only corrections over materialized columns.** A correction (rename, reject,
   set station, merge, and later split, reassign, confirm or reject link, promote,
   dismiss suggestion) is one definer RPC. It asserts the actor's tenant and
   deal-create authority in SQL, because an authenticated RPC can be called without its
   route. It updates the materialized columns, appends a `corrections` row, writes a
   `discovery.correction` audit row and queues a recompute, in one transaction. The
   `corrections` table is append-only by trigger. Rename and set station pin the
   candidate, so a re-run adds evidence but never renames it back. Audit details carry
   ids only, never a name, party or reason (Q19). The decision history on the page
   reads who, what, when, why and the value before.

5. **One per-tenant discovery lock.** Every writer of candidate rows takes
   `discovery_lock_tenant(tenant)` first (a transaction-scoped advisory lock), then row
   locks, and only then reaches the audit chain's own per-tenant lock. That order has no
   cycle. #286's per-group `select ... for update` in the upsert is kept, because it still
   guards any writer that skips the tenant lock. The locks are proved by behavior (a held
   lock must time out with `55P03`, and a concurrent upsert and merge must not raise
   `40P01`), not by reading the function text.

6. **Q21: a promoted deal gains only items its seated members own.** After promotion a
   match in a mailbox whose owner is not seated on the deal is not attached on its own.
   Every path that can put a link on a promoted candidate applies the same filter
   (`discovery_item_owner_seated`): the upsert, a merge into a promoted survivor and a
   triage confirm. Such a match waits in the routing ledger until a control room queue
   exists (phase 11).

7. **Promotion links, it does not move.** The candidate keeps its evidence and
   `promoted_deal_id` links the two. Evidence re-pointing and deal-scoped reads of
   colleagues' text are deferred (ADR-0019, T9). Promotion runs under Gate 0's full
   controls and never provisions a dataroom.

8. **Register, never bypass.** Every new table is classified in the mailbox-derived
   table list, every SQL function that names one is in `mailboxSqlFunctions.json`,
   every `authenticated` definer RPC is in the `definer_grants.sql` allowlist with its
   reason, and every table carries explicit revokes. Nothing adds a guard purpose, a
   fence or a change to a #262 function.

## Consequences

- A banker's correction survives a re-run, a merge survives new mail, and a promoted
  deal's evidence keeps growing. The cost is that candidate writes serialize per tenant:
  a correction waits at most one upsert, under a second at demo volume.
- Discovery adds no access. What a deal member sees after promotion is a subset of what
  architecture Q7 already allows.
- The new tables hold model outputs about mail and mail-derived names, which ADR-0017
  places in the bank's data plane. Until the owner answers T11 (a) they hold synthetic
  data only (ADR-0019).
- The audit chain is append-only and hash-chained per tenant in the database it protects
  (D62). This ADR does not call it tamper-evident.
- Split and reassign, the owner's triage and the control room queue are not part of this
  decision. They follow the same rules when they land.

## Not chosen

- Read-time folding of corrections. It complicates every policy and gives each viewer a
  different answer.
- An `authenticated` promote RPC in the discovery zone. A direct call would skip the code
  name mask and forge the screening verdict the CCO notice carries.
- Row-by-row lock ordering. It cannot rule out a cycle through the audit chain's lock or a
  survivor that a concurrent merge has just assigned.
- Seeding confirmed deals. It would show nothing discovered.
