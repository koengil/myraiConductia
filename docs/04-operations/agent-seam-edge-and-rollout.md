# Agent seam: credential rollout and edge rule

How the `/v1/*` agent seam on app.conductia.com goes from "anyone who can reach the
host gets service-role access" to two independent locks: a signed trigger token
checked by the app, and a Vercel Firewall rule that only lets the Ignatious egress
through. Written for the merge of PR #188 (ADR-0015, D61). Every step targets the
**Production** environment of the Conductia Vercel project.

Background: `docs/03-engineering/finding-agent-seam-unsigned-token-2026-09-18.md`
and `docs/07-decisions/ADR-0015-agent-seam-token-signing.md`.

Two facts drive the ordering:

- **`observe` gives zero protection.** Under `CONDUCTIA_TRIGGER_TOKEN_MODE=observe`
  the seam still accepts a forged token, as `legacy_unsigned`
  (`src/lib/ignatious/triggerToken.ts`, `triggerTokenMode`;
  `src/lib/conductia/auth.ts`, `authenticate`). Every hour in observe is an hour of
  the live exposure. Keep the window to one supervised cycle: target enforce the same
  day, with a **48 hour hard ceiling**. At 48 hours after the first Production
  deployment carrying #188, switch to enforce (Track 1, step 4) even if a gate is
  still red, and use [Rollback: mode](#rollback-mode) only for a skill that then
  fails.
- **Env var changes reach new deployments only.** The code reads `process.env` at
  request time, but the value a function sees is the one attached to the deployment
  serving it. Every mode change below is "change the variable, then Redeploy".

The two tracks run in parallel. **Neither gates the other.** If on merge day the
owner's egress list and the observed Firewall Traffic already agree (Track 2, steps
1 to 3 done), publish the deny rule (Track 2, step 4) first.

## Preconditions

1. **Vercel access.** You are a member of the Conductia Vercel team with rights to
   change Production environment variables, redeploy, and edit the project Firewall.
   Anyone outside the team gets `403` from the Vercel API and dashboard.
2. **Vercel CLI linked** to the Conductia project, if you use the CLI commands
   below. Every step also has a dashboard route.
3. **A signing key on Production.** Confirm in the project's Environment Variables
   (Production scope) that at least one of these is set:
   - `CONDUCTIA_TRIGGER_TOKEN_SECRET`, or
   - `INVITE_VERIFICATION_PEPPER` (the fallback; the seam derives a purpose-bound key
     from it).

   With neither set the token path is closed and only `IGNATIOUS_API_KEY`
   authenticates, so under enforce every token-carrying callback returns 401. Do
   not add, change or remove either value during the rollout: any of these
   invalidates every token for a run already in flight (adding the dedicated secret
   where only the pepper is set switches the key).
4. **The seam is configured.** `IGNATIOUS_API_KEY` and a base URL
   (`IGNATIOUS_API_URL` or `IGNATIOUS_CONTROL_PLANE_URL`) are set on Production.
   Without them every `/v1/*` call answers 503 and nothing below produces a signal.
5. **A firewall rule slot.** Custom rules are capped per plan (3 on Hobby, 40 on Pro).
   Track 2 needs one, two while the staging `log` rule and the `deny` rule coexist.

Verify: the Production Environment Variables list shows a signing key,
`IGNATIOUS_API_KEY` and a base URL, and does **not** yet show
`CONDUCTIA_TRIGGER_TOKEN_MODE`.

## Track 1: credential

### 1. Deploy #188 in observe

1. Add `CONDUCTIA_TRIGGER_TOKEN_MODE` = `observe` to **Production** only (dashboard:
   Environment Variables; CLI:
   `vercel env add CONDUCTIA_TRIGGER_TOKEN_MODE production --no-sensitive` and enter
   `observe` at the prompt, or non-interactively
   `printf observe | vercel env add CONDUCTIA_TRIGGER_TOKEN_MODE production --no-sensitive`).
   The CLI makes Production variables sensitive by default, and a sensitive value
   cannot be read back for the verification below; this one is not a secret.
   Set it **before** the merge, so the first deployment carrying #188 is already in
   observe.
2. Merge #188 to `develop`, then promote `develop` to `main`. Production deploys
   from `main` (`docs/03-engineering/delivery-model.md`). Promoting ships all of
   `develop`, not only #188. Before promoting, apply any pending migrations to the
   production database (`docs/04-operations/production-bootstrap.md`) and follow
   the release steps in `docs/03-engineering/delivery-model.md` (Releases and
   tags).
3. Confirm the Production deployment is Ready and its commit contains #188
   (dashboard: Deployments, filtered to Production; CLI: `vercel ls --prod`). The
   commit SHA on the deployment must equal the head of `main`.

Verify: the deployment's environment lists `CONDUCTIA_TRIGGER_TOKEN_MODE=observe`,
and Runtime Logs for Production show `[conductia-seam]` lines on `/v1/` requests.

### 2. Run one supervised cycle of the seam skills

Exercise every agent that calls back through `/v1`. The Teaser (rail seq 36) runs
in-process and never calls `/v1`, so it cannot produce a signal and is not part of
the cycle.

Skill step run is behind the `skill_authoring` flag: while the flag is off its
route (`src/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route.ts`)
answers 404 and it never reaches Ignatious. Read the `skill_authoring` row of
`feature_flags` in the production database. Exercise skill step run only where the
flag is on in Production; otherwise leave it out of the cycle and out of every gate
below.

| Skill | Where to launch it | `agentName` in the logs |
|---|---|---|
| MD Briefing | a deal's rail, station seq 9 (`p1-s9`) | `md-briefing` |
| Skill step run | any deal rail station other than seq 9 and seq 36 whose runner shows a skill, then **Draft this step** (Ignatious tags skills to stations, so this repo fixes no seq) | `skill-step-run` |
| Skill output revision | a recorded skill run on a deal rail station, then **Review output**, add a comment that needs a lookup, **Apply 1 edit** (flags `skill_authoring` and `skill_output_revisions`). It calls back only when the model uses a lookup tool | `skill-bench`, with `runId` the revision id (the token's agent claim is `skill-run-revision`, which the seam does not log) |
| Presearch | a lead's presearch skill on `/leads` | `presearch` |
| Debrief | a lead's debrief skill on `/leads` | `source-intelligence`, `digital-twin-builder` |
| Digital twins | chat with a lead's digital twin on `/leads` | `digital-twin` |

The last column is the `x-conductia-agent-name` header Ignatious sends on each
callback. The seam logs it as sent and does not check it against the token; expect
it to match the name the token was minted with.

Both skill bench routes
(`src/app/api/v1/deals/[dealId]/bench/chat/route.ts` and
`src/app/api/v1/companies/[companyId]/bench/chat/route.ts`) still mint
`skill-bench`, but no screen launches either: #184 replaced the rail's bench runner
with the skill step runner, and the bench was taken off the lead view before that.
Neither is part of the cycle.

Let each run finish, including any document it files. A briefing that files its
brief exercises the write scopes; a run that only reads does not.

A skill step run files its document to its own step only on a verified token: the
documents callback (`src/app/v1/leads/[leadId]/documents/route.ts`) reads `stepId`,
`stepTitle` and the filing actor from the signature-verified claims alone. A
document filed by an unverified caller (`api_key`, or `legacy_unsigned` under
observe) lands on MD Briefing's step (`p1-s9`), recorded as the mandate owner.

Verify: each row above produced a completed run in the UI. Note the time window of
the cycle; you read exactly that window next.

### 3. Read the gates in Runtime Logs

Open **Logs** for the project, filter to **Production**, request path prefix
`/v1/`, and search the message for `[conductia-seam]`. Read promptly: Runtime Logs
retention is 1 hour on Hobby and 1 day on Pro unless the project has Observability
Plus.

Most seam decisions write one line, `[conductia-seam] {json}`, from `logSeamAuth` in
`src/lib/conductia/auth.ts`; the `binding` deny is written by `requireConductiaLead`
in `src/lib/conductia/route.ts`. Two refusals write no line at all: a request
missing an `x-conductia-*` header (401) and a path and header lead mismatch (403).
The JSON is compact (no spaces), so the searches below match it literally. Denies
and `legacy_unsigned` accepts are logged at `warn`, everything else at `log`.

| Signal | Search | Gate |
|---|---|---|
| Legacy tokens in use | `"outcome":"accept","credential":"legacy_unsigned"` (warn) | 0 across the supervised cycle |
| Under-scoped signed tokens | `scope_would_deny` | 0, or each explained and the grant fixed first |
| Signed tokens working | `"outcome":"accept","credential":"signed_token"` | at least 1 per agent exercised, or that agent's accepts are all `"credential":"api_key"` |
| Shared key path | `"credential":"api_key"` | Not a gate; see below |
| Binding or tenant denies | `"reason":"binding"` / `"reason":"tenant"` / `"reason":"tenant_binding"` / `"reason":"tenant_claim_missing"` / `"reason":"tenant_owner_missing"` | 0 unexplained |
| Shared key on a lead route | `"outcome":"deny","reason":"api_key"` | 0 once the PL-02 branch is deployed |

How to read them:

- **`legacy_unsigned`** means Ignatious presented a token this deployment cannot
  verify: unsigned, signed with another key, or older than 24 hours. Under enforce
  each of these becomes a 401. Group the lines by `agentName` to see which skill.
- **`scope_would_deny`** carries `required` and `granted`. Under enforce it becomes
  a 403. Bench mints the read-only presearch grant; if bench files documents, widen
  the grant in code and redeploy before enforcing.
- **`signed_token` accepts** prove the round trip works. An agent from step 2 with
  no such line either authenticated some other way (check the other rows), never
  called back, or was refused for a missing header or a lead mismatch, which is not
  logged.
- **`api_key`**: if a skill authenticates with the shared key rather than the
  forwarded token, enforce is risk-free for it, and `IGNATIOUS_API_KEY` becomes the
  whole remaining credential surface. Rotating it moves from "still open" to "next".
  Also record whether `api_key` appears on `/v1/personas` or `/v1/leads` paths:
  once the stacked PL-02 branch is deployed, the lead routes refuse the key with a
  401 (logged `"reason":"api_key"`), as the persona routes already do, so any skill
  still sending it there must switch to the forwarded token first.
- **`binding`** is logged by `requireConductiaLead` in `src/lib/conductia/route.ts`,
  not by `logSeamAuth`: a signed token was presented against a deal other than the
  one it was minted for. **`tenant`** is a wrong `x-conductia-tenant-id`.
  **`tenant_binding`**, **`tenant_claim_missing`** and **`tenant_owner_missing`**
  only exist once the stacked PL-02 branch is deployed. Those three, and `binding`
  once that branch is deployed (before it, a 403 `{field: dealId}`), answer the
  caller with the same 404 as a missing lead, so the log is the only place they
  differ.
- `"reason":"authentication"` denies with empty `agentName` are callers with no
  valid credential at all, mostly scanners. They are not a gate.

Verify: every gate is met, with the evidence noted (counts per signal, per
`agentName`).

### 4. Switch to enforce

1. Remove `CONDUCTIA_TRIGGER_TOKEN_MODE` from **Production** (dashboard:
   Environment Variables, delete the Production entry; CLI:
   `vercel env rm CONDUCTIA_TRIGGER_TOKEN_MODE production`). Do not set it to
   `enforce`: unset already means enforce, and any value other than `observe`
   (matched case-insensitively, surrounding whitespace ignored), including a typo,
   also fails closed to enforce.
2. **Redeploy** the current Production deployment (dashboard: Deployments, the
   current Production deployment, its menu, Redeploy; CLI:
   `vercel redeploy <deployment-url> --target production`). Without it the running
   deployment keeps `observe`.
3. Probe with a forged token that carries every header, so only the credential can
   decide the answer:

   ```bash
   curl -si https://app.conductia.com/v1/library \
     -H 'Authorization: Bearer eyJhbGciOiJub25lIn0.eyJhZ2VudE5hbWUiOiJwcm9iZSIsImRlYWxJZCI6InByb2JlIn0.local-dev' \
     -H 'x-conductia-tenant-id: not-a-tenant' \
     -H 'x-conductia-lead-id: probe' \
     -H 'x-conductia-agent-name: probe' \
     -H 'x-conductia-run-id: probe'
   ```

   Under enforce this is **401** `authentication` with a `"reason":"authentication"`
   deny line. Under observe it is **403** `scope_denied` with a
   `"reason":"tenant","credential":"legacy_unsigned"` line, which means the Redeploy
   did not take. The probe reads nothing either way. If the Track 2 deny rule is
   already live and you are off the allowlist, the edge answers 403 first and no
   seam line appears; rely on the next check instead.
4. Run one MD Briefing and confirm its callbacks return 200 with an accept line
   carrying the credential the cycle recorded for `md-briefing` (`signed_token` or
   `api_key`).

Verify: the Production deployment's environment no longer lists
`CONDUCTIA_TRIGGER_TOKEN_MODE`, the probe returns 401, and a real MD Briefing
completes.

## Track 2: edge

### 1. Publish the rule in `log` mode

```bash
vercel firewall rules add "Ignatious-only /v1" \
  --condition '{"type":"path","op":"pre","value":"/v1/"}' \
  --action log --yes
vercel firewall diff
vercel firewall publish --yes
```

Read the `diff` before publishing: one added rule, path prefix `/v1/`, action log.

`log` changes no traffic. The path is matched with its trailing slash, and the
browser API lives under `/api/v1/`, which does not start with `/v1/`, so it is
unaffected (`src/app/v1/` and `src/app/api/v1/` are separate route trees;
`src/middleware.ts` excludes both from its matcher).

Verify: Firewall shows the rule published and enabled, action Log.

### 2. Ask for the egress list (human step)

Ask the owner of `Conductia/conductia-agents-backend` for the static outbound IPs
Ignatious calls back from (a NAT gateway with Elastic IPs, if it runs on AWS as the
"ALB" comment in `src/lib/ignatious/config.ts` suggests). This repo does not name a
host or any IP. Record the answer and who gave it.

Verify: you hold a written list, or a written "egress is not static".

### 3. Read the observed callers

Open Firewall, **Traffic**, filtered to the "Ignatious-only /v1" rule (CLI:
`vercel firewall traffic list`). Group by client IP, ASN and user agent. Runtime
Logs do not show the client IP; Traffic does. Traffic retention is 24 hours without
Observability Plus, so read it the same day a real skill ran (Track 1, step 2
produces exactly that traffic). If the cycle is older than 24 hours, run one MD
Briefing first.

Separate the Ignatious callers (the IPs that hit `/v1/` while a seam skill ran,
consistently from one ASN) from the scanners.

Verify: an observed list of Ignatious source IPs, with the ASN, that covers every
`agentName` exercised in Track 1, step 2 (match by time: the IPs that hit `/v1/`
while each skill ran).

### 4. Switch the rule to deny, or waive it

**If the owner's list and the observed IPs agree**, deny everything else on `/v1/`.
Edit the existing rule in the dashboard to add the negated IP condition, set the
action to Deny and rename it "Ignatious-only /v1 (deny)", or add it from the CLI:

```bash
vercel firewall rules add "Ignatious-only /v1 (deny)" \
  --condition '{"type":"path","op":"pre","value":"/v1/"}' \
  --condition '{"type":"ip_address","op":"inc","value":"<EIP1>,<EIP2>","neg":true}' \
  --action deny --yes
vercel firewall diff
vercel firewall publish --yes
```

The two conditions are ANDed: path starts with `/v1/` **and** the IP is not in the
list. Before `publish`, read the `diff` and confirm each IP appears as its own
entry in the IP condition, not as one comma-joined string; after publishing,
`vercel firewall rules list --expand` shows the same. If you added a second rule
from the CLI, disable or delete the staging `log` rule in the dashboard afterwards;
it does not change traffic, but it keeps the list unambiguous.

Do not deny on the owner's list alone, and do not deny on observed traffic alone:
one missed IP takes MD Briefing down. Do not use a header condition: any scanner
can send a header.

**If egress is not static**, an IP allowlist is not viable. Record an explicit
waiver instead: who decided, the date, why, and that the credential check (Track 1)
is the only lock on `/v1/*`, effective from the enforce switch (Track 1, step 4).
Add it to the finding's §11 Status. A written waiver satisfies PL-03 closure
criterion (c); silence does not. Keep the `log` rule as monitoring: it changes no
traffic and keeps the `/v1/` callers visible in Traffic.

Verify: Firewall shows the rule at action Deny with the IP list, or the waiver is
recorded in the finding.

### 5. Verify the deny rule

1. From a machine **not** on the list:

   ```bash
   curl -si https://app.conductia.com/v1/library
   ```

   Expect **403**, and a `deny` hit for this rule in Firewall, Traffic. (Without a
   credential the seam itself would answer 401, so a 403 here is the edge.)
2. Run one of each skill from Track 1, step 2 (skill step run only where
   `skill_authoring` is on) and confirm their callbacks return 200, with a
   `[conductia-seam]` accept line in Runtime Logs.
3. For the next hour, watch Firewall, Traffic for `deny` hits from the Ignatious
   ASN. Any such hit is a missed IP: go to [Rollback: firewall](#rollback-firewall).

Verify: all three checks pass.

## Rollback: mode

Use this when enforce breaks a live skill: its callbacks get a 401, or a 403 with a
`[conductia-seam]` deny line. A 403 with no seam line is the edge; use
[Rollback: firewall](#rollback-firewall). Observe loosens only the `authentication`
and `scope` denies; a `tenant` or `binding` deny, and the unlogged lead mismatch,
are the same in both modes.

1. Add `CONDUCTIA_TRIGGER_TOKEN_MODE` = `observe` back to **Production** (same
   routes as Track 1, step 1).
2. **Redeploy** the current Production deployment (same routes as Track 1,
   step 4).

Recovery takes minutes, the time of one redeploy. Then read the gates again to find
what the failing skill presents. Rolling back to observe reopens the exposure, and
the 48 hour ceiling applies again from that moment.

**Never use Instant Rollback as the lever.** It restores an older deployment with
its original code and env, which for any deployment before #188 is the unsigned
seam itself.

Verify: the forged-token probe from Track 1, step 4 now returns 403 with a
`legacy_unsigned` line, and the failing skill completes. If the Track 2 deny rule is
live and you are off the allowlist, the edge answers the probe with 403 first and no
seam line appears; verify with the failing skill instead.

## Rollback: firewall

If the deny rule blocks Ignatious:

1. Open Firewall, **View Audit Log**, and **Restore** the previous configuration
   version. It takes effect in about 300 ms.
2. Or disable the rule whose action is Deny, "Ignatious-only /v1 (deny)"
   (dashboard, or `vercel firewall rules disable "Ignatious-only /v1 (deny)" --yes`),
   and publish.

Then return to Track 2, step 3 and find the missing IP.

Verify: the next MD Briefing callbacks return 200.

## PL-02 hand-off: deploying the stacked branch

`fix/agent-seam-tenant-and-run-binding` (PL-02) stacks on #188 and changes what a
valid token is. Before deploying it to Production, its owner must account for two
effects.

1. **In-flight tokens stop verifying.** On that branch `verifyTriggerClaims` in
   `src/lib/ignatious/jwt.ts` requires `iss` **and** `aud`, and tokens minted by
   #188 carry no `aud`. For up to 24 hours after the stacked deploy, tokens from
   runs started earlier fail as `signed_token`:
   - on lead routes, under observe they fall back to `legacy_unsigned` and survive;
     under enforce they 401 until those runs age out;
   - on persona routes they fail **even in observe**, because
     `requireConductiaPersonaScope` (in `src/lib/conductia/route.ts` on that branch)
     demands a verified tenant claim, and `legacy_unsigned` carries no claims.
2. **The shared key is refused on personas.** The same gate refuses `api_key` on
   `/v1/personas*`. If Ignatious writes personas (twin builder) with the shared key,
   the stacked deploy breaks personas outright.

Before deploying the stack: check the Track 1 telemetry for
`"credential":"api_key"` on `/v1/personas` paths, and deploy when no digital twin
run is in flight: in Logs, filter to Production, request path prefix
`/v1/personas`, last 24 hours, and confirm no request in the 30 minutes before you
deploy. The persona 401 is not logged as a `[conductia-seam]` line; watch
the status codes on `/v1/personas` in Runtime Logs instead.

If PR #188 is rebased, PL-02 must rebase its stack onto it.

## Note: the logged 413s

Vercel logged `413 GET /v1/leads/:code/documents` on Production. The cause is not
established. A 413 from a function is the 4.5 MB request or response body limit,
but the list response carries only summaries (`src/lib/conductia/documents.ts`),
so on its face it is not an oversized response. The list query used to select
`text_content` for every document on the lead, which was wasted transfer from the
database. Since PL-24 (#224) it reads the stored `content_hash` and `text_length`
instead of the text, and answers at most 200 summaries per call with a `nextCursor`
for the next page. A `POST` to the same path that carries a base64 `.docx` over
4.5 MB would also be refused with a 413 before the handler runs.
