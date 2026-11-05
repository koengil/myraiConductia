# App observability runbook (owner steps, #474 slice 1)

What the web app's server logger writes, how the owner turns it into alerts and checks on Vercel and Supabase, and what it does not cover. Written for issue #474 slice 1 (stack `[474 1/6]` to `[474 6/6]`). Status: Proposed. The decision is D111 (number to confirm at merge) in [`decision-log.md`](../07-decisions/decision-log.md). The SOC 2 row is CC7.2/CC7.3 in [`soc2-control-register.md`](../08-security/soc2-control-register.md), and it stays **Partial** until the items in [Open with the owner](#open-with-the-owner) close.

Nothing on this page has been applied. Every live change below is an owner step.

The conventions follow [`csp-runbook.md`](./csp-runbook.md) and [`m365-sso-runbook.md`](./m365-sso-runbook.md):
- A step marked "(human step)" is done by the owner in a browser console or a shell, never by an agent or a CI job.
- `<placeholders>` are values you fill in. No secret value is written on this page.
- Every step ends with a **Verify:** line.
- `[unsure]` marks a Vercel or Supabase console detail this repo could not confirm without live access. Check it in the console. Where the console differs, follow the console and correct this page in a docs PR.
- Recipients are `TODO(owner)` until T1 is decided. An alert without a named, verified recipient does not count as delivered.
- Record counts, states and dates only. Evidence goes in Vanta, not in the repo ([`soc2-type1-program.md`](../08-security/soc2-type1-program.md), Working rules).

| Placeholder | Meaning |
|---|---|
| `<prod-ref>` | The production Supabase project ref |
| `<admin profile>` | The AWS CLI profile of the worker account's admin, as in the [AWS runbook](./discovery-worker-aws-runbook.md) |
| `<last check, epoch ms>` | The time of the previous weekly check (step 3), in epoch milliseconds |

## Events

Every line is one compact JSON object (no spaces), written by `logServerEvent` in `src/lib/log/index.ts`. `FIELD_TABLE` in `src/lib/log/fields.ts` is the one definition of the events: the `ServerLine` type, the cleaner and `tests/log/server-events-contract.test.ts` all derive from it, and `tests/docs/app-observability-runbook.test.ts` checks this section against it.

- A field holds a member of a closed set, a UUID or an integer in range. Anything else, and a missing required field, is written as `invalid`.
- The cleaner builds a new object from the table's fields. A key the table does not name, such as `subject` or `email`, is never written.
- The fields appear in the order of the tables below, so a full-text search for a run of fields matches literally.
- `src/lib/log/sink.ts` is the only file that writes to the console.

The level is the console method, and Vercel files the line by it: `console.log` is info, `console.error` is error, and `console.warn` is warning on streaming functions and error on the others.

**Counting rule: one line is one attempt, not one incident.** A batch run (the milestone extractor, the deal proposal step) asks again after a 400 `no_providers_available`, at about 15 s and 45 s (D106, `ZDR_RETRY_DELAYS_MS` in `src/lib/modelGateway/gatewayClient.ts`). One item can therefore write up to three `zdr_unavailable` lines. Interactive callers do not retry: one call, one line.

### `auth_denied`

Level warn. A 401 or 403 at an API gate. The gates are `requireApiUser` in `src/lib/api/v1/http.ts` (gate `api`), `requireApiUserScoped` in `src/lib/api/v1/httpScoped.ts` (gate `api_scoped`) and the inbound webhook secret in `src/app/api/v1/inbound/webhook/route.ts` (gate `inbound_webhook`). The response body is the one each gate returned before #474.

| Field | Required | Values |
|---|---|---|
| `reason` | yes | `no_session`, `mfa_required`, `account_suspended`, `onboarding_incomplete`, `bad_secret`, `work_identity_hook` |
| `status` | yes | `401`, `403` |
| `gate` | yes | `api`, `api_scoped`, `inbound_webhook` |
| `user` | no | a UUID |
| `company` | no | a UUID |

Which gate writes which reason, and the ids each line carries:

| Reason | Status | `api` | `api_scoped` | `inbound_webhook` | Ids |
|---|---|---|---|---|---|
| `no_session` | 401 | yes | yes | no | none |
| `mfa_required` | 403 | yes | yes | no | `user` |
| `account_suspended` | 403 | yes | no | no | `user`, `company` |
| `onboarding_incomplete` | 403 | yes | yes | no | `user`, `company` |
| `bad_secret` | 401 | no | no | yes | none |
| `work_identity_hook` | 401 | yes | yes | no | `user` |

### `auth_unavailable`

Level error. A 503: the gate could not decide. `misconfigured` is a server client that could not be built, or an inbound webhook with no secret configured. `session_read` is a Supabase Auth outage on the session read, `mfa_level` a failed assurance-level read, `admin_client` an admin client that could not be built (gate `api` only), and `profile_read` a failed read of the user's profile row.

| Field | Required | Values |
|---|---|---|
| `reason` | yes | `misconfigured`, `session_read`, `mfa_level`, `admin_client`, `profile_read` |
| `status` | yes | `503` |
| `gate` | yes | `api`, `api_scoped`, `inbound_webhook` |

### `model_outcome`

Level error for a failure, info for `ok`. Written by `postGatewayMessages` in `src/lib/modelGateway/gatewayClient.ts`, the one client of the AI Gateway, once per call. A success is logged only for the web features `compliance_screen` and `codename_suggest` (`FEATURE_OK_LOGGED` in `src/lib/log/values.ts`). The worker features `milestone_extract` and `deal_proposal` log failures only, with `tenant`, to the worker's CloudWatch log group `/conductia/discovery-worker`. Their successes are counted by the extract summary line and `model_calls` rows.

| Field | Required | Values |
|---|---|---|
| `feature` | yes | `compliance_screen`, `codename_suggest`, `milestone_extract`, `deal_proposal` |
| `outcome` | yes | `ok`, `no_key`, `timeout`, `http`, `zdr_unavailable` |
| `failure` | no | `non_anthropic_model`, `upstream_status`, `malformed_reply`, `network` |
| `zdrReason` | no | `no_providers_available`, `permission_denied` |
| `status` | no | an integer, 100 to 599 |
| `tenant` | no | a UUID |
| `ms` | yes | an integer, 0 to 600000 |

How to read it:
- `no_key`: no `AI_GATEWAY_API_KEY`, so nothing was sent. AI is off for that feature.
- `zdr_unavailable` with `zdrReason` `permission_denied`: the key's plan has no zero data retention. Permanent, never retried; AI is off (D90). With `no_providers_available`: a passing gap that batch runs retry (D106). Both carry `failure` `upstream_status` and the gateway's `status`.
- `http` with `failure`: `non_anthropic_model` was refused before sending, `upstream_status` is a non-2xx reply (with `status`), `malformed_reply` is a 2xx reply that could not be read, and `network` is a request that failed before any reply.
- `timeout`: the call ran out of time. It carries no `failure`.
- `ms`: the call's duration in milliseconds.

### `request_error`

Level error. Written by `onRequestError` in `src/instrumentation.ts` for an error that escaped a route, a render, a server action or the proxy. `requestErrorLine` in `src/lib/log/requestError.ts` reads the error's class only, never its message or stack:
- `db` is a `DbError`, with its `sqlstate`. A raise token of this repo is written as `P0001`.
- `upstream` is an `UpstreamHttpError` or a status-carrying provider error, with `provider` and the provider's `status`.
- Anything else is its class name when the set has it, else `other`.

The line carries no route or path: the platform's request record for the same request carries them (see [Outside the logger's guarantee](#outside-the-loggers-guarantee)).

| Field | Required | Values |
|---|---|---|
| `routeType` | yes | `render`, `route`, `action`, `proxy` |
| `method` | yes | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` |
| `errorClass` | yes | `db`, `upstream`, `OperatorCopyError`, `SyntaxError`, `TypeError`, `RangeError`, `ReferenceError`, `Error`, `other` |
| `provider` | no | `box`, `resend`, `graph-mail`, `gmail-token`, `gmail-send`, `anthropic`, `ignatious`, `google`, `google-token`, `graph` |
| `status` | no | an integer, 100 to 599 |
| `sqlstate` | no | `22023`, `22P02`, `23502`, `23503`, `23505`, `23514`, `40001`, `42501`, `55000`, `55P03`, `57014`, `P0001`, `P0002`, `P0003`, `P0004`, `P0409` |

### `audit_write_failed`

Level error. Written by the admin client's fetch observer, `observeAuditWrites` in `src/lib/supabase/observeAuditWrites.ts`, for a failed direct POST to `/rest/v1/audit_log` through `createSupabaseAdminClient` (`src/lib/supabase/server.ts`). Each line is an audit row that was not written. `status` `0` means the database could not be reached. `sqlstate` comes from the PostgREST error code: a code outside the set is written as `invalid`, and an unreadable body leaves it out. The caller still gets the same response or the same rejection.

| Field | Required | Values |
|---|---|---|
| `status` | yes | an integer, 0 to 599 |
| `sqlstate` | no | `22023`, `22P02`, `23502`, `23503`, `23505`, `23514`, `40001`, `42501`, `55000`, `55P03`, `57014`, `P0001`, `P0002`, `P0003`, `P0004`, `P0409` |

### A rejected line

`{"evt":"log_line_rejected"}` alone, at error. A call named no event, or its line could not be read. It is a code fault, not traffic: find the deployment that introduced it. It is not an event of `FIELD_TABLE` and carries nothing from the input.

## Owner steps

Step 1 comes first: steps 2 and 3 depend on the plan it records. Steps 4 to 6 are independent of each other. Step 7 comes last, once T1 has named the recipients.

## 1. Confirm Observability Plus on Production and record the retention (human step)

Who: a member of the Vercel `conductia` team with rights to the team's billing and add-ons. Names: `TODO(owner)`. Decision: Q-A (Proposed, owner to confirm).

The alert plan assumes Pro with Observability Plus on the Conductia project. The code does not depend on it: the logger writes plain console lines, which work the same on plain Pro. Without it, the native alerts (step 2) are not available and runtime logs are kept 1 day instead of 30.

1. Open the Conductia project, **Observability**, and read whether Observability Plus is active; the team's **Settings**, **Billing** lists it as an add-on [unsure: the exact tab and label]. From the Vercel docs read for this work: it is on by default for teams that moved to Pro on or after 2026-04-03, and it costs $1.20 per million events.
2. If it is off, enable it from the same page [unsure: the exact control]. It is a paid change, so the owner decides.
3. Record the plan, whether Observability Plus is on, the runtime log retention that follows and the date. The retention is the SOC 2 "log retention defined" value:

   | Plan | Runtime log retention |
   |---|---|
   | Pro | 1 day |
   | Enterprise | 3 days |
   | with Observability Plus | 30 days, 14 consecutive days viewable |

CLI: none confirmed for the add-on [unsure].

**Verify:** two days after the change, the Conductia project's **Logs**, filtered to Production, still lists entries in a time range that starts more than one day ago; and the record names the plan, the add-on state, the retention and the date. If Observability Plus stays off, record that step 2 is not available and that step 3 runs daily.

## 2. Vercel error anomaly alerts, 5xx and 4xx, on Production (human step)

Who: as step 1. Needs step 1: Vercel alerts require Pro with Observability Plus, or Enterprise.

A Vercel error anomaly alert counts errors per route in 5-minute windows against a 24 hour baseline; 5xx is the default and 4xx is configurable. Vercel alerts do not read log content, which is why the three log-keyed signals wait for slice 2 (Q-B, step 3).

1. Open the Conductia project, **Observability**, **Alerts** [unsure: the route], and add an error anomaly rule: environment Production, status 5xx. It covers the 5xx rate, including every `request_error`.
2. Add a second rule: environment Production, status 4xx. It covers an auth-failure spike at the API gates and the inbound webhook. Read the cause with step 3, search 2, which splits the denials by `reason` and `gate`.
3. Channel and recipients: `TODO(owner)` (T1). Vercel offers Slack, email, push, the Vercel inbox and team webhooks (event `alerts.triggered`).

CLI: `vercel alerts rules add` [unsure: its flags; run `vercel alerts rules add --help` and set the same fields as the dashboard].

**Verify:** the project's alert rules list [unsure: the route, or `vercel alerts rules ls`] shows two error anomaly rules on Production, one for 5xx and one for 4xx, each with a recipient that is not `TODO(owner)`. Until T1 names the recipients, record the rules as configured, not delivered.

## 3. Three saved log searches, checked weekly (human step)

Who: `TODO(owner)` (T1). This is the interim control of the open Q-B exception: AI off, auth denials and failed audit writes are logged events, not alerts, until slice 2. Check weekly with Observability Plus. Check daily without it, because plain Pro keeps runtime logs 1 day.

Open the Conductia project, **Logs**, filter to **Production**, set the time range to the window since the last check, and search the message. Save each search as a named query where the plan offers it [unsure: saved queries depend on the plan]. Where it does not, use the strings below as they are.

The lines are compact JSON, so the full-text strings match literally. The field filter form depends on whether this project's Logs view filters on fields inside a JSON message [unsure: the Vercel docs disagree on it].

| # | Signal | Full-text search | Field filter [unsure] | Read |
|---|---|---|---|---|
| 1 | AI off | `"outcome":"zdr_unavailable"`, then `"outcome":"no_key"` | `evt` is `model_outcome` and `outcome` is `zdr_unavailable` or `no_key` | Any line: which `feature`, which `zdrReason` |
| 2 | Auth denials | `"evt":"auth_denied"` | `evt` is `auth_denied`, grouped by `reason` and `gate` | The count per `reason` and `gate`, against the last check |
| 3 | Failed audit writes | `"evt":"audit_write_failed"` | `evt` is `audit_write_failed` | Any line: an audit row was not written |

For search 2, each reason at each gate is one literal run of fields, for example `"evt":"auth_denied","reason":"bad_secret","status":401,"gate":"inbound_webhook"`. In the same pass, look for `"evt":"auth_unavailable"` (a gate outage) and `"evt":"log_line_rejected"` (a code fault).

The worker's half of search 1, once the extract service or a propose run uses the gateway. As admin, because the log group is under the worker key:

```bash
aws logs filter-log-events --profile <admin profile> --log-group-name /conductia/discovery-worker \
  --filter-pattern '{ ($.evt = "model_outcome") && (($.outcome = "zdr_unavailable") || ($.outcome = "no_key")) }' \
  --start-time <last check, epoch ms> --query 'events[].message' --output text
```

How to read a hit, with the counting rule in mind (one line per attempt):
- `zdrReason` `permission_denied`, or `no_key`: AI is off for that feature until the key or its plan is fixed (D90). The compliance screen runs rules only, and code names use the fallback sets.
- `zdrReason` `no_providers_available` from a worker feature: up to three lines per item are retries (D106). AI is off for that run only if the last attempt also failed.
- `audit_write_failed` with `status` `0`: the database was unreachable at that time. With a `sqlstate`: the row was refused.

Where to record each check: `TODO(owner)` (Proposed: the date, the window and the count per search, in Vanta). The lines carry no content, but record the counts only.

**Verify:** the three searches ran on Production over the whole window since the last check, the worker search ran when a worker feature was in use, each count is recorded with the date, and the next check is booked with `TODO(owner)`.

## 4. Supabase Auth: rate limits and the Auth log (human step)

Who: an owner of the production Supabase project: `TODO(owner)`. Decision: T6 (OPEN).

Password sign-in, OAuth and the MFA verify go from the browser to Supabase Auth directly (`src/app/sign-in/page.client.tsx`, `src/app/two-factor/page.client.tsx`, `src/app/auth/work/_shared.ts`). A failed attempt never reaches a Vercel function, so no Vercel alert and no app log line can see it. Supabase Auth rate limits throttle an attack but notify nobody. This step records the limits and where the Auth log is read. The active sign-in attack signal stays open (T6).

1. Read the production project's Auth rate limits. Change nothing. Dashboard: Authentication, Rate Limits [unsure: the page name]. Management API:

   ```bash
   curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
     https://api.supabase.com/v1/projects/<prod-ref>/config/auth | jq 'with_entries(select(.key | startswith("rate_limit_")))'
   ```

   [unsure: that every rate limit key of this endpoint starts with `rate_limit_`; if the output is empty, read the dashboard page instead]. The local defaults are in `supabase/config.toml`, section `[auth.rate_limit]` (for example 30 sign-up and sign-in requests per 5 minutes per IP address). The hosted values can differ, so record the hosted ones.
2. Find where the Auth log is read: the dashboard's **Logs**, the Auth source [unsure: the menu name], and record its retention on the project's plan [unsure: it depends on the plan].

**Verify:** the record names each rate limit and its value, where the Auth log is read, its retention and the date, and nothing on the project was changed.

## 5. Apply the extract "no running task" alarm (human step)

Who: the owner, as **admin** on the worker account ([AWS runbook](./discovery-worker-aws-runbook.md), roles table).

`conductia-discovery-extract-no-running-task` (`infra/discovery-worker/alarms.tf`) is gated like the extract service itself: it exists only in stage 2 with `extract_desired_count` above 0. The extract service is at 0 today, so a plan now creates nothing. The alarm arrives with the apply that starts the extract service ([AWS runbook, Switching later](./discovery-worker-aws-runbook.md#switching-later), P2 = A to B). It notifies the same alert topic as the classify alarms, so the owner and the CCO subscriptions receive it.

```bash
export AWS_PROFILE=<admin profile>
tofu -chdir=infra/discovery-worker plan -var-file=ignatious.tfvars -out=extract-alarm.tfplan
tofu -chdir=infra/discovery-worker apply extract-alarm.tfplan
rm infra/discovery-worker/extract-alarm.tfplan
```

Read the plan before the apply. With extract at 0 it adds no alarm. With extract at 1 it adds `aws_cloudwatch_metric_alarm.extract_running_tasks[0]`. If the plan holds any change you did not expect, stop and find its owner first.

Read the alarm together with search 1 (step 3). A ZDR stop exits 1 and ECS restarts the task, so a ZDR crash loop also reads as no running task. When the alarm fires, run the worker half of search 1 over the same window. `zdr_unavailable` lines with `permission_denied` mean AI is off on that key (D90), not that the service is down.

**Verify:** `aws cloudwatch describe-alarms --alarm-names conductia-discovery-extract-no-running-task --query 'MetricAlarms[].[AlarmName,StateValue]' --output text` prints the alarm name and `OK` once the extract service has run for 10 minutes. While extract is at 0 it prints nothing, which is the intended state: record "extract not started".

## 6. Confirm the classify alarms are live (human step)

Who: the owner, as admin.

`conductia-discovery-no-tick` and `conductia-discovery-no-running-task` watch the classify service. They exist only while `classify_desired_count` is above 0, and the start apply creates them ([AWS runbook, step 13.1](./discovery-worker-aws-runbook.md#131-start-on-the-test-persona)). Their delivery to the owner and the CCO is part of gate G8 ([AWS runbook, step 12](./discovery-worker-aws-runbook.md#12-gates-g1-to-g9)).

```bash
aws cloudwatch describe-alarms --profile <admin profile> \
  --alarm-names conductia-discovery-no-tick conductia-discovery-no-running-task \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text
```

**Verify:** while the classify service runs, both alarms are listed and `OK`, and G8 is signed in the deployment record. While classify is at 0 the command prints nothing: record "classify not started".

## 7. Verify alert delivery once recipients are named (human step)

Who: the owner and every named recipient. Needs T1 decided. Modelled on gate G8: an alert counts as delivered only when each named recipient has confirmed receipt.

1. **Vercel.** Send a test notification from each rule of step 2 where the console offers one [unsure]. Otherwise record the receipt of each rule's first real alert. Do not cause errors on Production to test a rule.
2. **The CCO.** The CCO is probably not a member of the Vercel team. The chosen channel must reach the CCO anyway, for example a team webhook or a forward; the choice is part of T1.
3. **AWS.** The extract alarm uses the same topic and subscriptions as the alarms G8 already tested. After step 5 runs with extract at 1, the alarm's first `OK` notification reaches both subscriptions: record both receipts.

**Verify:** for every rule of step 2 and the extract alarm, each named recipient's receipt is recorded with its date, and the record says T1 is closed.

## Where refusals are already recorded

These endpoints record their own refusals, so the logger leaves them alone.

| Endpoint | Existing record | Where to read it |
|---|---|---|
| Conductia seam, `/v1/*` (`src/lib/conductia/auth.ts`) | a `[conductia-seam]` log line on every decision | Runtime Logs, as in [`agent-seam-edge-and-rollout.md`](./agent-seam-edge-and-rollout.md), Track 1, step 3 |
| Skill-publication service token (`src/lib/skillPublication/serviceAuth.ts`) | an `audit_log` row `skill_publication.admission_denied`. The 429 rate-limit path writes nothing (T3) | `audit_log` |
| Gmail mailbox callback (`src/app/api/v1/mailbox/google/callback/route.ts`) | an `audit_log` row `mailbox.connect_refused` | `audit_log` |

## Outside the logger's guarantee

The logger keeps content out of its own lines. These are outside it:

- **Vercel's request record.** The platform stores each request's path and query string for the runtime log retention. Paths can carry deal codes (`resolveDealRef`, `src/lib/api/v1/dealRef.ts`). ADR-0017 decision 5 names Vercel runtime logs as a store that must hold no content; the logger cannot reach this record.
- **Next's uncaught-error print (T7).** Next prints the message and stack of an error that escapes a route. This repo's own errors carry codes only (#331, ADR-0017 O3), but a library's message can quote its input. `tests/content-egress-canary-throws.test.ts` measured it: a `JSON.parse` error quotes the text it failed on. The `request_error` line stays clean; Next's print does not. The fix belongs to T7.
- **Audit rows written inside an RPC.** The observer sees only direct POSTs to `/rest/v1/audit_log` through `createSupabaseAdminClient`. The discovery worker builds its own client, so its audit writes are not observed either.
- **The skill-publication 429 path** writes nothing (T3, Charles's area).
- **The other bare `console.*` lines**, about 65 bracket-tag sites, stay unstructured (T4). The content-egress guard (rules L1 and L2) still keeps content out of them.
- **Per-attempt counting.** A count of lines is a count of attempts (see the counting rule above).

## Open with the owner

None of these is closed by slice 1. The SOC 2 row names them.

| Id | What | State | Closes when |
|---|---|---|---|
| Q-A | Observability Plus on Production | Proposed (orchestrator, 2026-10-21), owner to confirm | step 1 is recorded |
| Q-B | Log-keyed alerts wait for slice 2: AI off, auth-denial reasons and failed audit writes are logged events, not alerts. Step 3 is the interim control, and AI can stay off until the next check | OPEN exception (approved by the orchestrator on 2026-10-21) | the owner confirms it, or slice 2 alerts on the three signals |
| T1 | Named, verified alert recipients, and a channel that reaches the CCO | OPEN | step 7 is recorded |
| T6 | A sign-in attack signal on Supabase Auth | OPEN requirement | the owner chooses a signal: Supabase log drains or alerting [unsure: it depends on the plan], routing in slice 2, or the rate limits plus a periodic review as the control |

Known limits, named above: T3 (the skill-publication 429 path) and T7 (Next's uncaught-error print).

## Slice 2

`src/lib/log/sink.ts` is the only place the logger touches the console, so slice 2 replaces the sink and no call site moves.

- **CloudWatch.** A Vercel log drain (Pro and Enterprise, $0.50 per GB, each delivery signed with `x-vercel-signature`) feeds a receiver that calls `PutLogEvents`, with metric filters on `$.evt` in the style of `infra/discovery-worker/alarms.tf`. No code change.
- **GlitchTip.** `sink.ts` forwards to `Sentry.logger`, and `onRequestError` calls `Sentry.captureRequestError`. This adds a dependency and a processor.

Either sink is a new store under ADR-0017 decision 5, so the choice is a slice-2 owner decision. Once it lands, the three Q-B signals become alerts. Today `tests/infra/discovery-worker-contract.test.ts` pins that no worker metric filter keys on `model_outcome`; slice 2 changes that pin on purpose.
