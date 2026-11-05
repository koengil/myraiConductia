# Finding: the `/v1` agent seam accepted unsigned tokens

| | |
|---|---|
| **Date** | 2026-09-18 |
| **Verdict** | **CONFIRMED** (code). Reachability in production is environment-gated, see §5. |
| **Severity** | High for a compliance-first platform. Unauthenticated read and write across deals, and forgeable `audit_log.actor_id`. |
| **Affected** | All 13 routes under `src/app/v1/**`, via `src/lib/conductia/auth.ts` |
| **Introduced** | `54ba183d` (Feat/md briefing ignatious and skills bench, #7). Never tighter. |
| **Went live** | `v0.5.6`, 2026-09-07, when the Ignatious beta reached app.conductia.com |
| **Fixed by** | This branch. `CONDUCTIA_TRIGGER_TOKEN_MODE=observe` during the window, then enforce. |
| **Method** | Static review of the seam, the seven token mint sites (eight since #183 added skill step runs), `middleware.ts`, `next.config.ts` and the absent `vercel.json`, plus the repo's own unit suite. No deployed environment was queried. |

## 1. Bottom line

`requireConductiaScope` accepted **either** the shared `IGNATIOUS_API_KEY` **or**
anything `readTriggerClaims` could base64-decode. The second branch verified nothing.
A non-null decode was the entire authentication decision.

```ts
// src/lib/conductia/auth.ts, before
function verifyConductiaBearer(request: Request, expectedKey: string): boolean {
  if (verifyConductiaApiKey(request, expectedKey)) return true;
  return readTriggerClaims(request.headers.get('authorization')) !== null;
}
```

`readTriggerClaims` splits on `.`, decodes `parts[1]`, and returns non-null when the
JSON carries two strings. It never reads the header and never reads the signature.
`mintTriggerToken` wrote the literal `local-dev` as the signature and nothing read it.

## 2. Why "algorithm confusion" understates it

There is no JWT library in the project: no `jose`, no `jsonwebtoken`, no `jwtVerify`
anywhere in `src/`. `alg: none` and HS/RS confusion are attacks on a verifier that
consults the header. There was no verifier. A two-segment string with no signature
segment at all was accepted, because the guard was `parts.length < 2`.

## 3. What the forged token reached

- **No session boundary.** `middleware.ts` excludes `v1` from its matcher, so the
  Supabase + AAL2 gate never ran on these routes.
- **No network boundary.** No `vercel.json`, no IP allowlist, no WAF config in the
  repo. `next.config.ts` adds generic response headers only.
- **No database boundary.** Every handler receives `createSupabaseAdminClient()`, the
  service-role client, which bypasses RLS by design.
- **No tenant filter.** `loadDealByIdOrCode` matches `deals.id` **or** `deals.code`
  with no tenant predicate, so any deal in the database was reachable by id or code.
- **Scopes unenforced.** The per-agent grants in `jwt.ts` had zero readers.

## 4. The tenant check answered its own question

```ts
// src/lib/conductia/auth.ts:80-88, before
if (tenantId !== config.tenantId) {
  return conductiaError('scope_denied', 'Tenant is not this Conductia instance.', 403, {
    expected: config.tenantId,   // <- handed to an unauthenticated caller
    actual: tenantId,
  });
}
```

`conductiaError` serializes `detail` into the response body. A wrong-tenant request was
answered with the correct tenant id, so the one identifier the gate asked for was
available on request. `IGNATIOUS_TENANT_ID` also defaults to the literal `tn_demo`.

## 5. Reachability

`requireConductiaScope` returns 503 for every request when `readIgnatiousConfig()` is
null, which needs `IGNATIOUS_API_KEY` plus a base URL. A local checkout with neither set
is dark. Production is not: `README.md` records the Ignatious beta live at
app.conductia.com since 2026-09-07. The skills that call back through `/v1` are MD
Briefing plus skill step runs, skill bench, presearch, debrief and the digital twins;
the Teaser runs in-process and never calls `/v1`. Those callbacks require exactly those variables.
Confirm against the deployment's environment before treating this as historical.

## 6. The worst of it: audit attribution

`resolveFilingActor` took `audit_log.actor_id` from the same unverified token:

```ts
const claims = readTriggerClaims(request.headers.get('authorization'));
if (claims?.userId) return claims.userId;
```

That value flows through `fileBytesToStepDataroom` into both `documents.uploaded_by`
and `audit_log.actor_id`. On a platform whose stated moat is compliance, an audit trail
that can be made to name anyone is worse than the read access that precedes it.

## 7. The in-flight work widened it

PRs #183 and #184 add `stepId` and `stepTitle` to the claims and use `claims.stepId` to
choose which rail step a filing lands in. On the pre-fix seam that is attacker-chosen.
They touch the same two functions this fix touches. Both merged to `develop` ahead of this
fix; the rebase of #188 onto `c05d1306` resolved the conflict, and the step and the filing
actor now come from signature-verified claims only (§11).

## 8. Remediation

### 8a. Shipped here

1. **Signature.** `src/lib/ignatious/triggerToken.ts` signs `header.payload` with
   HMAC-SHA256, modelled on `src/lib/compliance/screenToken.ts`. Signing the header
   makes an alg swap useless. Key: `CONDUCTIA_TRIGGER_TOKEN_SECRET`, falling back to a
   purpose-derived key from `INVITE_VERIFICATION_PEPPER`.
2. **No backend change needed.** This repo mints the token at eight call sites and
   Ignatious forwards it back verbatim, so both ends of the round trip are this
   deployment.
3. **Freshness.** `iat` plus a 24h replay window, generous enough for a slow run.
4. **Binding.** A verified token is held to the deal it was minted for. The `dealId`
   claim is not uniform (lead id for the lead-scoped agents, deal uuid for bench and
   skill step runs, a company id for presearch and the twins), so the check resolves both sides to a deal
   and stands down when the claim is not one.
5. **Scopes enforced** per route, now that they are unforgeable.
6. **Leak closed.** `scope_denied` no longer echoes the expected tenant.
7. **Length oracle closed.** The api-key compare hashes first, as
   `api/v1/inbound/webhook` already did.
8. **Audit actor.** Taken from verified claims *and* a deal-membership check, falling
   back to the mandate owner read from the database.

### 8b. Rollout

`CONDUCTIA_TRIGGER_TOKEN_MODE` defaults to `enforce`. Set `observe` in production
**before** merging: it accepts an unverifiable token, trusts nothing it carries, and
logs one `legacy_unsigned` line per call. When one supervised cycle of the seam agents
(MD Briefing, skill step runs where `skill_authoring` is on, presearch, debrief, digital
twins) shows zero such lines, remove the override. No screen launches skill bench since
#184, so the cycle cannot exercise it. The Teaser runs in-process and cannot produce these lines. Then delete the
legacy branch.

Watch the log for `reason: "scope_would_deny"` during the window. `deals/[dealId]/bench/chat`
mints `presearchScopes()`, which is read-only; if bench files documents, that grant is
too narrow and must be widened before enforcing, not after. Widened in #196: both bench chat routes now
mint `benchScopes()`, which adds `documents.write`.

### 8c. Still open

The missing tenant filter in `loadDealByIdOrCode` is unchanged. Deal-scoped RLS is the
durable answer and is the open D54 follow-up (#78, #79). Rotating `IGNATIOUS_API_KEY` is
worth doing as an ops action.

## 9. Forensic check

Read-only, for the operator to run. Given the seam has been live since 2026-09-07, this
establishes whether the gap was ever exercised.

```sql
-- Agent-seam filings whose recorded actor was not on the deal.
select a.id, a.ts, a.actor_id, a.deal_id, a.detail
from audit_log a
left join deal_memberships m
  on m.deal_id = a.deal_id and m.user_id = a.actor_id
where a.detail->>'source' = 'ignatious'
  and m.id is null
order by a.ts desc;

-- Agent-seam writes with no matching trigger row for their run.
select a.id, a.ts, a.deal_id, a.detail->>'runId' as run_id
from audit_log a
where a.detail->>'source' = 'ignatious'
  and not exists (
    select 1 from audit_log t
    where t.action = 'create'
      and t.detail->>'kind' = 'agent_run'
      and t.detail->>'runId' = a.detail->>'runId'
  )
order by a.ts desc;
```

Neither query proves abuse on its own. A row from the first can also be a legitimate
filing attributed to a mandate owner who is not a member; read them as leads, not
verdicts.

## 10. Confidence

High on the code facts: every claim above is a direct read, and the regression suite in
`tests/conductia-seam-auth.test.ts` asserts the old decision function still accepts a
token the new gate refuses. Medium-high on production reachability, which depends on
deployment environment variables that static analysis cannot see.

## 11. Status (2026-09-22)

The rollout and the edge rule are an operator procedure:
`docs/04-operations/agent-seam-edge-and-rollout.md`.

**Closed in code** (PR #188, not yet merged):

- Signature verified over `header.payload`, so an `alg` swap or strip fails.
- Replay bounded to 24 hours from `iat`.
- Scopes enforced per route under enforce (this also closes PL-04).
- A signed token bound, on the `/v1/leads/*` routes, to the deal it was minted for.
- The `runId` criterion, closed with evidence rather than code. `runId` on `/v1` is
  the unsigned `x-conductia-run-id` header, used only for attribution
  (`uploadedBy.runId`, dataroom audit detail, seam logs). The stacked branch's
  `executionId` binding covers the user-session `/api/v1` run routes, not `/v1`. The
  blast radius of a replayed token is already fenced to its deal, its tenant (stacked
  `tenant_binding`) and its agent's grant. A signed run claim cannot be built without
  an agents-backend change, because Ignatious assigns the run id after the token is
  minted. A token-to-run binding by hash is proposed on #188 for review.
- The step-run filing claims. `stepId` and `stepTitle` (#183), which choose the rail
  step a skill step run's document is filed to, are read with the filing actor from
  the signature-verified claims only. An unverified caller files to MD Briefing's step
  as the mandate owner.

**Remaining:**

- #188 and the stacked PL-02 branch (`fix/agent-seam-tenant-and-run-binding`) merged.
- `enforce` live in Production (`CONDUCTIA_TRIGGER_TOKEN_MODE` absent from the
  serving deployment).
- The Vercel Firewall rule on `/v1/` applied at `deny`, or an explicit waiver
  recorded here.
- Forged run attribution within one valid token: a caller holding a live token can
  label a filing with another run's id on the same deal.
- `IGNATIOUS_API_KEY` rotation.
- The tenant filter in `loadDealByIdOrCode` and deal-scoped RLS (#78, #79).

**Closure.** PL-03 closes only when all three hold: (a) #188 and the stacked PL-02
branch are merged, (b) `enforce` is live in Production, and (c) the firewall rule is
applied or explicitly waived. A merge alone does not close it.
