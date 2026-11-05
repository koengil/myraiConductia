# Gmail send as the banker: engineering runbook

Audience: the Conductia team that configures, checks and supports Gmail sending. Scope: the env values, the prerequisites, the owner steps, what each failure looks like to a banker and what to do about it, and how to prove a send from the audit log. Design: #490, [ADR-0025](../07-decisions/ADR-0025-gmail-send-as-banker.md) (number to confirm at merge), decision-log D102 (number to confirm at merge). Status: Proposed.

**The customer-facing document is the owner's guide, not this file.** It tells a bank's admin how to mark the sending client Trusted in App access control (for the bankers' OU only) and how to revoke it, and tells a banker how to connect. It is held by the owner (`Projects/Conductia/email-setup/sending/04-google-sending-setup`) and is not copied into the repo. Engineering does not edit it; the one change it needs is owner step T12 below.

Engineering never touches Cloud Console, the Workspace admin console, Vercel env or a live mailbox. Every such action below is an owner step.

## Precondition: before Ignatious is told the button is ready

Do not tell Ignatious that **Connect for sending** is ready until all of these hold (ADR-0025, design R26):

1. **T2 step 1 is done.** The owner has connected `probe@<dev domain>` on a deployment with this feature and screenshotted Google's consent screen for `openid email gmail.send`.
2. **T12 is applied.** The owner has updated Step 2 of the guide to match the consent lines in that screenshot. Today the guide tells a banker to click **Cancel** if the screen lists anything besides "Send email on your behalf", and the sign-in scopes may add lines. If the screenshot shows only "Send email on your behalf", the guide needs no change.
3. **The firm domain is on record for Ignatious** (T14, below). Without it every connect is refused with `no_firm_domain`.
4. **The env values are set on the environment Ignatious uses**, and the sending client is marked Trusted for Ignatious's bankers' OU by their admin, per the guide.

**Rollout rule: `GOOGLE_SEND_*` stays unset in every environment until `[490 8/10]` (the connect route and the card) has merged** (#490 audit 5). Before that PR, the callback is not reachable from the app, but a banker controls their own browser's cookies and could complete a round trip by hand. That round trip still passes every check and can store only that banker's own approval, but the card that explains it does not exist yet.

## Configuration

All four values are server-side only. Never give any of them a `NEXT_PUBLIC_` prefix, and never paste a value into an issue, a PR or a log.

| Variable | What it is | Secret |
|---|---|---|
| `GOOGLE_SEND_CLIENT_ID` | The sending OAuth client's ID: a **Web application** client, separate from Google sign-in and from the DWD reader | No |
| `GOOGLE_SEND_CLIENT_SECRET` | That client's secret | Yes |
| `GOOGLE_SEND_REDIRECT_URI` | `<origin>/api/v1/mailbox/google/callback`, exactly as registered on the client | No |
| `MAILBOX_TOKEN_KEY` | The token-at-rest key, already used by the Microsoft connection (32 bytes, 64 hex characters or base64). Shared with Graph | Yes |

`gmailSendConfigured()` (`src/lib/email/gmail.ts`) needs all four. With any one missing, Gmail is not offered, the connect route answers 503, and an existing Gmail connection fails closed (see Failure states). The `mail_channel` flag must also be on; with it off every mail route answers 404.

**Redirect URI per environment.** The redirect must land on the same origin the banker started from, because the state and PKCE cookies are set on that origin. Register one URI per environment on the sending client:

| Environment | Origin | Redirect URI |
|---|---|---|
| Production (`main`) | `https://app.conductia.com` | `https://app.conductia.com/api/v1/mailbox/google/callback` |
| Staging (custom Vercel environment) | `https://conductia-env-staging-conductia.vercel.app` | `https://conductia-env-staging-conductia.vercel.app/api/v1/mailbox/google/callback` |
| Preview (`develop` and every PR) | One stable alias: `TODO(owner)` | `<that alias>/api/v1/mailbox/google/callback` |
| Local development | `http://localhost:3000` | `http://localhost:3000/api/v1/mailbox/google/callback` (Google accepts `http` for localhost only) |

Preview needs care. Vercel's Preview environment holds one value per variable for every preview build, but each build has its own URL. A connect started on any other preview URL comes back to the alias, finds no state cookie there, and is refused as `failed`. Run the live check (T2) on the alias itself. Staging and previews sit behind Vercel login; that is fine, because the redirect is a browser navigation that carries the banker's Vercel session.

**What the client must have** (owner step T1). Whoever owns the Google Cloud project that hosts it:
- registers the redirect URIs above;
- lists exactly `openid`, `email` and `https://www.googleapis.com/auth/gmail.send` on the consent screen, and nothing else (the callback refuses any grant holding more and stores nothing);
- moves the app out of Testing: in Testing, refresh tokens for a sensitive scope expire after 7 days, unless the bank's admin has marked the client Trusted, which lifts that limit for that organization only;
- runs brand verification and submits the `gmail.send` justification (T4, with the pages from `[490 10/10]`).

**Content-Security-Policy.** Nothing to change. **Connect for sending** first calls the connect route with `fetch(..., { redirect: 'manual' })`, which does not follow the redirect, then navigates the page. Top-level navigation is not governed by `connect-src` (see `docs/04-operations/csp-runbook.md`). The Gmail API and Google's token endpoint are called server-side only.

## Firm domain prerequisite (T14)

The callback refuses any Google account whose `hd` claim is not one of the banker's firm's Google Workspace domains. `src/lib/email/firmGoogleDomains.ts` reads, and never writes, these sources for the banker's company:
1. `firm_identity_providers.organization_id` where `provider = 'google'`. This is the value the work-identity start route already sends Google as `hd`. When it exists it is the only domain used.
2. Otherwise every `company_verified_domains.domain` for the company.

If neither yields a domain, **Connect for sending** shows "Your firm's Google Workspace is not set up for sending yet. Ask the Conductia team." Adding the row is an ops step through the existing work-identity or verified-domain setup, not a code change.

Check it read-only, with the service role:

```sql
select 'idp' as source, organization_id as domain
from firm_identity_providers
where company_id = '<firm company id>' and provider = 'google'
union all
select 'verified', domain
from company_verified_domains
where company_id = '<firm company id>';
```

Watch: Google returns the **primary** Workspace domain as `hd`, even for a user on a secondary domain. If the identity-provider row names a secondary domain, every banker is refused as `not_workspace`. To confirm with Martin (T14).

## Owner steps

| Step | What | Who | Gate |
|---|---|---|---|
| T1 | Choose the Google Cloud project for the sending client; create the Web client; register the redirect URIs; publish; verify. **Recommended: a dedicated sending project** (such as the rehearsal's `conductia-email-ingestion`), apart from Martin's sign-in project. Google's revoke can end every grant an account gave a project, so keeping sending apart means nothing done to the sending client at Google can touch a banker's sign-in. Sharing the sign-in project works, because Conductia never revokes (ADR-0025 decision 2) | Owner and Martin | Before any environment can offer Gmail |
| T2 | The live check on the paid dev Workspace (`<dev domain>`), below. Setup: [dev-google-workspace-setup.md](../04-operations/dev-google-workspace-setup.md). The `emailmask.uk` trial it was planned on expired (owner, 2026-10-20) | Owner, with go-ahead | Step 1 gates telling Ignatious |
| T12 | Update Step 2 of the guide to the consent lines seen in T2 step 1 | Owner | Gates telling Ignatious |
| T3 | Decide whether Disconnect should also revoke at Google (today it deletes only, as the guide says). Safe only with a dedicated sending project (T1) | Owner | None |
| T4 | Privacy page status, homepage URL, demo video, submission ([`google-oauth-verification.md`](./google-oauth-verification.md)) | Owner and counsel | Verification |

**T2, the live check.** On the Preview alias with `[490 8/10]` or later deployed, or with the rehearsal script and the same parameters (`ops/wave6-rehearsal/gcp/20-gmail-send-test.py` on branch `wave6/deploy-rehearsal`):
1. Connect for sending as `probe@`. Screenshot Google's consent screen. Note every line it lists besides "Send email on your behalf".
2. Send from `probe@` to `storm@` with a Cc, a Bcc, an HTML body, one PDF attachment and a `[Confidential]` subject. Check: the message is in `probe@`'s Sent folder; it is in `storm@`'s inbox from `probe@` with the expected display name; the Bcc recipient received it; the To recipient cannot see the Bcc.
3. Send a raw message with a forged `From` through the rehearsal script and note which sender the recipient sees. This closes the rehearsal's open note; it does not change the design, because Conductia pins the `From` itself.
4. Set the client to **Blocked** for the OU, send, and confirm Mail settings shows **Approval ended**. Set it back to **Trusted**, connect again and send.
5. **Disconnect** in Mail settings. Confirm Conductia no longer sends as `probe@`, and that the app is still listed in `probe@`'s Google linked apps (unless T3 changes this).
6. Check identity and scopes: the connected row's `scopes` lists what Google granted (expected `openid`, `https://www.googleapis.com/auth/userinfo.email` and `https://www.googleapis.com/auth/gmail.send`); a personal gmail.com account is refused with the not-Workspace copy; a different `<dev domain>` user from the one signed in to Conductia is refused with the different-account copy.

## How it works, briefly

- **Connect.** `GET /api/v1/mailbox/google/connect` sets three cookies (`gmail_send_state`, `gmail_send_verifier`, `gmail_send_next`; httpOnly, SameSite=Lax, 600 s) and redirects to Google with PKCE, `access_type=offline`, `prompt=consent`, `login_hint` and `hd`. `GET /api/v1/mailbox/google/callback` checks the cookies, exchanges the code, checks the scopes and the account (ADR-0025 decision 2), stores the refresh token encrypted with the granted scopes and the account `sub` as a new row and audits `mailbox.connected` in one transaction (`mailbox_sending_connect_google`), and redirects back with `?mailbox=connected` or `?mailbox=error&reason=<reason>`.
- **Send.** `POST /api/v1/outbox` reads the sending mailbox before the screen, refuses a revoked or switched-off Gmail connection before any screen, screens as for every send, then `sendAsConnectedUser` refreshes the token, builds the message with `From` pinned and calls `messages.send`. The outbox records `provider = 'gmail'` and Gmail's message id.
- **Approval ended.** Any `invalid_grant` on the refresh marks the row revoked, deletes its token and audits `mailbox.approval_ended`, in one transaction (`mailbox_sending_mark_revoked`). Later sends refuse until the banker reconnects or disconnects.
- **Disconnect.** `DELETE /api/v1/mailbox` deletes the row and audits `mailbox.disconnected` in one transaction (`mailbox_sending_disconnect`). It does not revoke at Google. If it fails, nothing changed: the card's "still connected" is true.
- **Send as is.** A Gmail send-as-is token is bound to the recipients and the connection's row id. Every connect writes a new row, so after a disconnect and reconnect the next send screens afresh.

## Failure states

Send failures reach the banker as `Email provider send failed: <copy>` for fixed copy, or `Email provider send failed (<code>)` for a code. No Google response body ever reaches the banker or the logs.

| State | What the banker sees | Operator action |
|---|---|---|
| No sending client on this environment, and no Microsoft app | Mail settings: "Sending from your own mailbox is not configured on this environment yet. Until then, mail sends from the platform address." Mail sends from the platform address | Set the four values if this environment should offer Gmail |
| Sending client removed while bankers hold Gmail connections | Mail settings: "Sending from Gmail is switched off on this environment. Mail does not send from {email} until it is back. Disconnect to send from the platform address." Send: `Gmail sending is switched off on this environment; disconnect in Mail settings to send from the platform address`. Refused before the screen | Restore the values, or tell the bankers to disconnect. Mail never falls back to the platform address on its own |
| Approval ended: the banker removed the app, the admin set it to Blocked, or any other `invalid_grant` | Badge **Approval ended**: "Google ended Conductia's approval to send as {email}. Mail does not send until you connect again." The send in flight: `Gmail approval ended; connect for sending again in Mail settings`. Later sends refuse before the screen | Ask the banker to connect again. If many bankers end at once, ask the bank's admin whether the client was set to Blocked. After a Block is lifted, **every banker must connect again**: the old approvals stay dead (rehearsal tests 6 and 7; Google does not document this) |
| Google refuses Conductia's own client (`invalid_client`, `unauthorized_client`) | `Gmail sending is misconfigured on this environment; tell the Conductia team`. The connection is untouched | Check the client ID and secret on this environment, and whether the client was deleted or its secret rotated in Cloud Console (owner) |
| Token endpoint 5xx, timeout or no response | `Email provider send failed (gmail-token_<status>)`; status 0 means no response. The connection is untouched | Transient. The banker sends again |
| `messages.send` fails | `Email provider send failed (gmail-send_<status>)` | **Ambiguous: the message may already have gone out.** Before resending, the banker checks their Gmail Sent folder (T7, shared with Graph) |
| The stored approval cannot be decrypted | `Gmail connection unreadable; connect for sending again in Mail settings`. The row is left alone | `MAILBOX_TOKEN_KEY` differs from the one that encrypted it (a rotation, or another environment's key). Graph connections show `Mailbox connection unreadable; reconnect the mailbox` for the same cause. Bankers connect again |
| `mailbox_connections` cannot be read | `Mailbox connection unavailable` (500, before the screen), or `Email provider send failed (mailbox_unavailable)` (502, at the send). Applies to Microsoft connections too | Database health. Nothing is sent from the platform address instead |
| The banker connected, reconnected or disconnected while a send was in flight | `Your sending mailbox changed. Send again.` | None. The next send screens afresh |
| Disconnect fails | `Disconnect failed; the mailbox is still connected` (500) | Database health. Nothing was deleted and nothing audited; the banker tries again |
| The message could not be built safely | `Email provider send failed (rfc822_header_break)`: a line break in the subject, the display name, an address or an attachment's name or type. `(rfc822_from_not_pinned)`: the built message failed the `From` check | The first is bad input. The second should never happen: treat it as a bug, and note the time and the sender's user id |

**Connect refusals.** The callback redirects back with `?mailbox=error&reason=<reason>`, and Mail settings shows:

| Reason | What the banker sees | Operator action |
|---|---|---|
| `wrong_account` | "Google connected a different account. Connect with {address}." | The banker picked another Google account, its email is unverified, it differs from their Conductia address (for example an alias, T10), or its `sub` differs from their bound Google identity |
| `not_workspace` | "Connect with your firm's Google Workspace account, {address}." | A personal Google account, or a Workspace domain that is not the firm's. Check the firm domain (T14) |
| `scope_missing` | "Google did not grant Send email on your behalf. Connect again and allow it." | The banker unticked the permission |
| `scope_unexpected` | "Google granted more than Conductia asked for, so the connection was not kept. Tell your admin." | The client's consent screen lists a scope beyond the three (T1) |
| `no_firm_domain` | "Your firm's Google Workspace is not set up for sending yet. Ask the Conductia team." | Add the firm's domain (T14) |
| `cancelled`, `failed` | "The connection did not complete. Try again." | `failed` also covers an expired round trip (more than 600 s), a connect started on another origin than the redirect URI's, and a failed code exchange |

Every refusal stores nothing and writes one `mailbox.connect_refused` row (`detail {provider, reason}`). Conductia never revokes at Google: Google's revoke can end every grant the account gave the Cloud project, Google sign-in included. When the refusal came after Google returned a code, the redirect carries `granted=1` (Google records the approval at consent, whatever the reason, `failed` included) and the notice adds "Conductia kept nothing from that approval. To remove it from the Google account, open myaccount.google.com/permissions." If the `mailbox.connect_refused` row cannot be written, the refusal fails closed: the reason becomes `not_recorded` and the banker sees "The connection did not complete, and Conductia could not record the attempt. Try again, and tell the Conductia team if it happens again." Operator action: audit-log health; nothing was stored. A refusal never ends someone's working connection.

## Verify a send in the audit log

Use the service role, read-only. Select no content: no subject, body, recipient or address columns, and never `tokens_encrypted`.

```sql
-- The message: which provider sent it, and Gmail's own id for it.
select id, status, provider, provider_message_id, created_at
from outbound_messages
where id = '<message id>';

-- Its audit trail: a 'screen' row, then a 'send' row with the same provider and id.
select ts, action,
       detail->>'verdict'           as verdict,
       detail->>'replayed'          as replayed,
       detail->>'provider'          as provider,
       detail->>'providerMessageId' as provider_message_id
from audit_log
where actor_id = '<sender user id>' and action in ('screen', 'send')
  and ts between '<from>' and '<to>'
order by ts;

-- The connection's history: connected, connect_refused, approval_ended, disconnected.
-- detail is {provider}, plus a fixed reason code for connect_refused.
select ts, action, detail->>'provider' as provider, detail->>'reason' as reason
from audit_log
where actor_id = '<user id>' and action like 'mailbox.%'
order by ts;

-- The connection itself.
select provider, status, scopes, connected_at, updated_at, revoked_at, account_sub is not null as has_sub
from mailbox_connections
where user_id = '<user id>';
```

A Gmail send is proven when:
- the `outbound_messages` row reads `status = 'sent'`, `provider = 'gmail'`, and a `provider_message_id` from Gmail (Graph's ids look like `graph-<time>`, the noop transport's like `noop-<time>-<n>`);
- a `screen` row precedes the `send` row, and the `send` row's `detail.messageId` is the message's id;
- `replayed = true` on the `screen` row means a send as is replayed an earlier screen; for Gmail that replay was bound to the same recipients and the same connection row.

A refused send leaves no `outbound_messages` row and no `send` row. A send refused because the approval ended or Gmail is switched off also leaves no `screen` row.

## Switching it off

- **Stop offering Gmail on an environment:** unset `GOOGLE_SEND_CLIENT_ID` (or any of the three `GOOGLE_SEND_*` values). The connect route answers 503 and the card offers no Gmail connect. Bankers who hold a Gmail connection see the switched-off state and send nothing until they disconnect. Do not unset `MAILBOX_TOKEN_KEY` for this: it also stops Microsoft connections.
- **Stop all sending from Conductia:** turn `mail_channel` off.
- **Roll back the schema:** `supabase/rollback/20261017120000_mailbox_connections_google_down.sql`. It deletes every Google and every revoked row (they are credentials), then restores the Microsoft-only table and the previous audit action list. Revert the code first.

## Known limits

- One sending mailbox per user. A new connection of either provider replaces the old one.
- The banker's Google address must equal their Conductia address (T10).
- A 5xx or timeout from `messages.send` can mean the message went out; a resend can duplicate it (T7).
- No RFC 5322 Message-ID is stored and replies are not threaded (T11, with #268).
- Microsoft connections do not yet show "Approval ended" or write `mailbox.*` audit rows (T5).
- When both providers are configured, Mail settings shows both connect buttons (T6).

## Offline proof

Unit and route tests run in the normal suite; the SQL and integration files run in CI's `integration` job.

| File | Proves |
|---|---|
| `tests/email-gmail.test.ts` | Authorize URL, code exchange, scope and `id_token` checks, `checkGrantIdentity`, refresh classification, send |
| `tests/email/gmail-scopes.test.ts` | The sending client names exactly `openid`, `email` and `gmail.send`, no read, modify or compose scope appears under `src/lib/email`, and no Google revoke endpoint is named there |
| `tests/email-rfc822.test.ts` | `From` only from the connection; Bcc kept; UTF-8 subject and filenames; HTML, text and attachments; header breaks refused; the parse-back trips |
| `tests/email-connected-sender.test.ts` | Dispatch by provider, fail closed, refuse while revoked, the revoke RPC, the mailbox-changed check (including a reconnect of the same address), the envelope's connection binding |
| `tests/api-v1-outbox.test.ts` | Screen before send, forged `from` ignored, `provider: 'gmail'`, envelope replay rules, refusals before the screen, read errors |
| `tests/api-v1-mailbox-google-connect.test.ts`, `tests/api-v1-mailbox-google-callback.test.ts`, `tests/email-firm-google-domains.test.ts` | Every connect outcome, the cookies, the firm domain, the refusal audit, nothing revoked at Google |
| `tests/api-v1-mailbox.test.ts`, `tests/mail-client.test.tsx` | Status and disconnect; every card state and its copy |
| `tests/content-egress-canary.test.ts` | Gmail token and send failures leak nothing into the response or logs |
| `supabase/tests/mailbox_connections_google.sql` | The table's checks, a Microsoft connect over a revoked Google row, the audit actions, the three state-change functions and their grants, and the rollback of each when its audit write fails |
| `tests/integration/gmail-send-revoked.test.ts` | On a real database: `invalid_grant` revokes and audits, the next send refuses before the screen, Disconnect audits and the platform transport then sends |
