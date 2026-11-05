# ADR-0025: Gmail send as the banker

Status: Draft for discussion, 2026-10-17, against `develop` @ 6701802b (the base of the `[490 k/10]` stack; revised 2026-10-18 after the independent audit). Number to confirm at merge.
Related: [ADR-0022](./ADR-0022-google-workspace-mailbox-connection.md) (the Gmail reader; its decision 3, "read-only, with no send path", is unchanged), [ADR-0021](./ADR-0021-m365-mailbox-connection.md) (the reader app never sends), [ADR-0023](./ADR-0023-send-path-enforcement.md) (send-path enforcement; its decision 3 on real Message-IDs is follow-up T11 below), D86 (internal mail screened like external), D90 (zero data retention on every model call), D102 (this decision, number to confirm at merge). Issue #490. Send path by Marcelo (PR #536 and the outbox). Gmail card and connect banner by Martin (#555), not touched. Engineering runbook: [`gmail-send-runbook.md`](../03-engineering/gmail-send-runbook.md).

## Bottom line

- **A Gmail banker connects once, in Mail settings, and from then on Conductia sends as them.** Each message is screened first, built by Conductia with `From` pinned to the account Google vouched for, and sent through the banker's own Gmail, so it lands in their Gmail Sent folder.
- **Sending uses its own Google client and one sensitive scope.** Per-user consent to `gmail.send`, plus the sign-in scopes `openid email` so Conductia can tell which account approved. It is a separate client from Google sign-in and from the domain-wide delegation reader, which stays read-only.
- **When Google ends the approval, sending stops and says so.** Any `invalid_grant` marks the connection "Approval ended", and every later send refuses until the banker reconnects or disconnects. A Google connection never falls back to the platform address on its own.
- **Not yet proven live.** Everything is proven offline with a fake Google token endpoint and a fake Gmail API. The live check, planned on the `emailmask.uk` trial until it expired (owner, 2026-10-20), now runs on the paid dev Workspace ([setup checklist](../04-operations/dev-google-workspace-setup.md)). It is an owner step, and it gates telling Ignatious the button is ready (runbook precondition).

## In plain terms

- **The problem.** An Outlook banker can already send from Conductia as themselves. A Gmail banker cannot: their mail leaves from the shared platform address, recipients see Conductia rather than the banker, and their Gmail Sent folder has no copy.
- **What we do.** The banker clicks **Connect for sending** and approves "Send email on your behalf" on Google's screen. Conductia keeps the approval encrypted. On each send, Conductia screens the message, asks Google for a short-lived token, builds the message itself and hands it to Gmail.
- **The main risk, and the control.** Gmail accepts a forged `From` header (rehearsal test 4). So the message is never built from anything the caller supplies as a sender: Conductia writes the `From` from the stored connection and checks the built message before it leaves.
- **What this ADR decides.** Which Google client and scopes, which account may connect, how the message is built, what happens when Google ends the approval, and what Disconnect does.

## Terms

- **Sending client:** the Google OAuth web client used only for Connect for sending. Configured by `GOOGLE_SEND_CLIENT_ID`, `GOOGLE_SEND_CLIENT_SECRET` and `GOOGLE_SEND_REDIRECT_URI`.
- **Approval:** the refresh token Google issues when the banker consents. It is the only Google credential Conductia stores for sending.
- **`invalid_grant`:** Google's answer when an approval no longer works: the banker removed the app, the bank's admin set it to Blocked, the token expired, or similar.
- **`hd` claim:** the Google Workspace domain in the `id_token`. A consumer Google account has none.
- **`sub`:** Google's stable id for an account. Stored as `account_sub`.
- **Send as is:** the banker's choice to send after seeing the screen's warnings. A token replays the first screen's verdict for 60 minutes (#192 slice 2b).
- **Envelope:** the recipients (To, Cc, Bcc) plus the sending mailbox.
- **Platform address:** the shared `EMAIL_FROM` sender used when no mailbox is connected.

## Decision

Each decision names its source. Owner decisions are binding. "Proposed" marks an engineering choice, made under the design discussion for #490 and accepted by the wave orchestrator, that the owner has not separately decided.

1. **A separate sending client, with per-user consent, never domain-wide delegation.**
   - Source: owner, issue #490 scope item 1, and the owner's customer guide (`04-google-sending-setup`), which gives the bank a client ID that is "not the DWD client ID".
   - The sending client is distinct from Google sign-in and from the DWD reader. Where it lives and who publishes it is open point T1; only env values change with the answer.
   - Proposed (design R1, R2): the code lives in `src/lib/email/gmail.ts`, uses plain `fetch`, and imports nothing from `src/lib/google`, `googleapis` or `google-auth-library`. `tests/google/no-send-path.test.ts` keeps holding unchanged, and ADR-0022 decision 3 stays true. `gmailSendConfigured()` requires all three `GOOGLE_SEND_*` values plus `MAILBOX_TOKEN_KEY`.
2. **Scopes `openid email gmail.send`, with the account checked before a connection is kept.**
   - Source for the scopes: the orchestrator, 2026-10-17 (design Q2), from the owner's guide ("Request only the scopes we need: gmail.send plus sign-in") and issue #490 scope item 1 ("plus sign-in scopes"). With `gmail.send` alone Conductia cannot learn which account approved: the profile read returns 403 (rehearsal test 2).
   - Proposed (design R3): the authorize request uses PKCE S256, `access_type=offline` and `prompt=consent` every time, so Google always returns a refresh token, including on a reconnect after a Block. `login_hint` is the banker's own address and `hd` is the firm's domain; both are only hints to Google's account chooser. The state and the PKCE verifier ride in httpOnly, SameSite=Lax cookies (`gmail_send_state`, `gmail_send_verifier`, `gmail_send_next`; 600 s; Secure outside development), and the state is compared in constant time.
   - Proposed (design R19): the callback keeps the connection only when every check passes:
     - **Scopes.** The granted set contains `gmail.send` and nothing beyond `openid`, `email`, `https://www.googleapis.com/auth/userinfo.email` (Google's name for `email`) and `gmail.send`. Otherwise `scope_missing` or `scope_unexpected`. The granted set, not the requested one, is stored.
     - **Token.** The `id_token` has the sending client as `aud`, a Google `iss` and a future `exp`. Its signature is not verified, because it came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7).
     - **Domain.** The `hd` claim is present and is one of the firm's Google Workspace domains, else `not_workspace`. The firm's domain is the `organization_id` of the company's `firm_identity_providers` row with provider `google`, else the company's `company_verified_domains`. Both are read, never written (T14). A firm with neither cannot start a connect (`no_firm_domain`).
     - **Account.** `email_verified` is true and the email equals the banker's Conductia address, and the `sub` equals their bound Google work identity (`work_identity_bindings`) when they have one. Otherwise `wrong_account`.
   - A refusal stores nothing and is audited as `mailbox.connect_refused` (`detail {provider, reason}`, the reason a fixed code). Conductia never revokes a refused grant at Google (decided by the wave orchestrator after the 2026-10-18 audit, replacing design R22): Google's revoke can end every grant the account gave the Cloud project, so if the sending client shares a project with Google sign-in, a `wrong_account` refusal could end the banker's sign-in. When the refusal came after Google returned a code (so Google has recorded the approval, whatever the reason), the redirect carries `granted=1` and the card tells the banker that Conductia kept nothing and links to `myaccount.google.com/permissions` to remove it. If the refusal's audit row cannot be written, the refusal fails closed as `not_recorded`, with copy saying the attempt could not be recorded.
   - Proposed (implementation, S3a): the firm domains and the bound `sub` are read before the code is exchanged, so a read error or a firm with no domain never mints a token. The connection and its `mailbox.connected` row are written by one function, `mailbox_sending_connect_google`, in one transaction (audit item 2): there is no unaudited sending credential, and no stored credential without its audit row.
   - **Bankers only.** Source: owner, 2026-10-19. An external user (`users.is_external`: a counterparty or adviser invited into a deal) cannot connect Gmail for sending, even when their company has a verified domain or a Google sign-in row. The connect route answers `403 { reason: 'not_eligible' }` before any cookie or consent, the callback refuses `not_eligible` before the code is exchanged, and `mailbox_sending_connect_google` raises `not_eligible` for an external user or no user, so nothing is stored. Externals work through the deal's threads. Why: their mail is not the bank's record, Conductia has no agreement with their firm to hold their tokens or sent mail, and opening this later costs two checks, while closing it after externals connect means revoking their tokens and keeping what they already sent. Revisit as a per-firm setting, off by default, if a real need appears.
3. **`From` pinned to the connected address, and checked by a parse-back.**
   - Source: owner, issue #490 scope item 2 ("From is always the connected user, never caller-supplied"). The rehearsal found that Gmail accepts a forged `From`.
   - Proposed (design R7): `src/lib/email/rfc822.ts` builds the message with `nodemailer`'s `MailComposer` only (never SMTP), pinned exactly at `10.0.14`, the newest release at least two weeks old with no open advisory (audit item 6). The message type has no `From` field (`MessageInput`); the `From` comes only from the connection row, with the display name `users.display_name ?? users.full_name`. A CR or LF in any value that becomes a header is refused (`rfc822_header_break`). File and URL content sources are switched off. Bcc stays in the raw message, because Gmail reads recipients from it and strips Bcc on delivery.
   - The built bytes are parsed back with `postal-mime`. The send fails closed (`rfc822_from_not_pinned`) unless there is exactly one `From` header holding exactly one mailbox equal to the connected address, and no `Sender`, `Reply-To` or `Return-Path`.
4. **One sending mailbox per user, and a fresh access token for every send.**
   - Source: issue #490 scope item 2 ("`sendAsConnectedUser` picks Graph or Gmail by connection").
   - Proposed (design R4): `mailbox_connections` keeps `unique(user_id)`; the provider check gains `google`, and the row's provider decides the path (`src/lib/email/connectedSender.ts`). A new connection of either provider replaces the old one; a Google connect deletes the earlier row and inserts a new one, so the row id names one approval (audit item 3). A Microsoft connect over a Google row resets `status`, `revoked_at` and `account_sub` (R20), and the `/setup` card reads only the Microsoft row (R24).
   - Proposed (design R5): only the refresh token is stored, under the same AES-256-GCM envelope and `MAILBOX_TOKEN_KEY` as Graph (`src/lib/email/tokenCrypto.ts`). A fresh access token is minted on every send, as Graph does, so a Block takes effect at the next send.
5. **Every `invalid_grant` ends the approval, and sends refuse until the banker reconnects or disconnects.**
   - Source: owner, issue #490 scope item 4, and the owner's guide ("When an approval is gone, Conductia does not send from that banker's Gmail address. It tells the banker to connect again."), resolved as design Q1 by the orchestrator on 2026-10-17. The ticket's "fall back the way Graph does" is read as Graph's actual behaviour: a broken Graph connection refuses every send, it does not switch to the platform address.
   - The send in flight fails with "Gmail approval ended; connect for sending again in Mail settings". The row turns `status = 'revoked'`, its token is deleted, `revoked_at` is set, and `mailbox.approval_ended` is audited, both by `mailbox_sending_mark_revoked` in one transaction. The update is conditional on the token this send read, so a slow failing send never wipes a reconnect that landed meanwhile. Mail settings shows **Approval ended**, with **Connect for sending** and **Disconnect**.
   - Proposed (design R6): `invalid_client` and `unauthorized_client` are Conductia's own misconfiguration, so they show operator copy and disconnect no banker. A 5xx, a timeout or a network error fails the send as `gmail-token_<status>` and leaves the row alone.
   - Proposed (design R23): a revoked connection, or one on an environment without the sending client, is refused right after the identity read, before any screen, AI spend, `screen` audit row or pending row. The dispatcher keeps both checks for a state change between the read and the send.
6. **Fail closed on missing configuration and on read errors.**
   - Proposed (design R11, R21): a Google connection never yields "no connection". With the `GOOGLE_SEND_*` values removed, its sends refuse with "Gmail sending is switched off on this environment; disconnect in Mail settings to send from the platform address", and the card says the same. A `mailbox_connections` read error fails the send (500 "Mailbox connection unavailable" before the screen, or 502 `mailbox_unavailable` at dispatch) instead of reading as "no connection".
   - Proposed (design R17, R25): the dispatcher re-checks that the row is still the identity read before the screen (row id, provider and address). A connect, disconnect or reconnect in between refuses with "Your sending mailbox changed. Send again." and never re-routes.
   - **Both rules also apply to Microsoft connections** from `[490 6/10]` on. A Graph user with a read error, or a Graph connection created or deleted mid-request, now gets a refusal where the send used to go out from the platform address. No normal Graph send changes (T7, reviewed by Marcelo).
7. **A Gmail send-as-is applies only to the same envelope.**
   - Source for the screen itself: owner, issue #490 scope item 3. Every fresh screen runs as before, rules plus the escalate-only model pass through the ZDR gateway (D90); a ZDR refusal falls back to the rules verdict and never retries elsewhere.
   - Proposed (design R17): for a Google identity the screen token's subject gains `envelope`, a SHA-256 over the recipients (trimmed, lowercased, order kept), the connection's row id, the provider and the connected address. A changed audience or mailbox means a fresh screen, and so does a disconnect and reconnect of the same address, because the reconnect is a new row (audit item 3). Tokens without an envelope, which is every Graph and platform token, verify exactly as before. Whether every provider should bind the envelope, or every send re-screen, is open point T13.
8. **Disconnect deletes only.**
   - Source: the owner's guide, which says Disconnect "deletes its stored approval" and tells the banker to remove the app at Google as a separate step (design R9).
   - `DELETE /api/v1/mailbox` deletes the row and its stored token whatever its provider or status, and audits `mailbox.disconnected` for a Google row, both in `mailbox_sending_disconnect`'s one transaction; a failure changes nothing, so the card's "still connected" is true. It does not call Google's revoke endpoint (open point T3). The card says where mail goes afterwards: "Disconnect deletes Conductia's stored approval. Mail you send here then goes out from the platform address. To remove Conductia from your Google account too, use Google's linked apps page."

Smaller decisions, all Proposed:
- **Lazy platform `From`** (design R18). The outbox resolves `EMAIL_FROM` only when the platform transport sends, so a missing `EMAIL_FROM` never fails a Gmail or Graph sender's mail.
- **Content-free audit** (design R10). Four provider-neutral actions, `mailbox.connected`, `mailbox.disconnected`, `mailbox.approval_ended` and `mailbox.connect_refused`, each with `detail {provider}` and nothing else, plus a fixed refusal code for `connect_refused`. Graph does not write them yet (T5). Every state change and its audit row are one SQL function in one transaction (`mailbox_sending_connect_google`, `mailbox_sending_mark_revoked`, `mailbox_sending_disconnect`; service role only), so neither lands without the other (audit item 2).
- **No new flag** (design R11). The routes sit behind `mail_channel` and `requireApiUser()`; the sending client's env decides whether Gmail is offered. `configured` on `GET /api/v1/mailbox` means any sending client, and `providers` says which (R25).
- **No automatic retry of `messages.send`** (design R8). A 5xx or a timeout is ambiguous, so the outbox deletes the pending row and answers 502, as for Graph. The receipt is Gmail's real message id, stored as `provider_message_id` with `provider = 'gmail'`.
- **Body-free errors.** Google error bodies are never kept: errors carry a status and a code-shaped token (`gmail-token_<status>`, `gmail-send_<status>`), and the content-egress canary covers both.
- **The connect button asks before it navigates** (implementation, S3b). **Connect for sending** first calls the connect route without following the redirect, so a firm with no domain on record (409) shows "Your firm's Google Workspace is not set up for sending yet. Ask the Conductia team." rather than raw JSON. The alternative is a redirect back with `?mailbox=error&reason=no_firm_domain`.

## What the banker sees

Copy is from the design and the owner's guide; look and feel is design to confirm against the Workbench register. Implementation changes from the design are marked.

| State | Mail settings, "Your mailbox" |
|---|---|
| No sending client on this environment | "Sending from your own mailbox is not configured on this environment yet. Until then, mail sends from the platform address." |
| Gmail offered, not connected | "Connect your Gmail to send as your own address. Mail you send here goes out from your Gmail and appears in your Gmail Sent folder. Google asks you to approve one permission, Send email on your behalf. This permission does not let Conductia read your mail." and **Connect for sending**. Changed from the design's "Conductia cannot read your mail.", which would contradict the separate reading consent (#555) |
| Connected | "Connected for sending as {email}. Mail you send here goes out from your Gmail and appears in your Sent folder." **Disconnect**, and the Disconnect note (decision 8) |
| Approval ended | Badge **Approval ended**. "Google ended Conductia's approval to send as {email}. Mail does not send until you connect again." **Connect for sending**, **Disconnect**, and the Disconnect note (shown here too, a change from the design) |
| Gmail sending switched off | "Sending from Gmail is switched off on this environment. Mail does not send from {email} until it is back. Disconnect to send from the platform address." **Disconnect**. The connected dot on the Mail settings pill is hidden in this state (a change from the design) |
| Connect refused | `wrong_account`: "Google connected a different account. Connect with {address}." `not_workspace`: "Connect with your firm's Google Workspace account, {address}." `scope_missing`: "Google did not grant Send email on your behalf. Connect again and allow it." `scope_unexpected`: "Google granted more than Conductia asked for, so the connection was not kept. Tell your admin." `no_firm_domain`: "Your firm's Google Workspace is not set up for sending yet. Ask the Conductia team." `cancelled`, `failed` and any unknown reason: "The connection did not complete. Try again." The address is the caller's own, from `/api/v1/me`; the URL never carries one `not_recorded`: "The connection did not complete, and Conductia could not record the attempt. Try again, and tell the Conductia team if it happens again." With `granted=1` (any refusal after Google returned a code) the notice adds "Conductia kept nothing from that approval. To remove it from the Google account, open myaccount.google.com/permissions." with that page linked (audit item 1) |

When both Microsoft and Google are configured on one deployment, the card shows both connect buttons (T6).

## Status

| Slice | PR | What it adds | Reachable by a banker |
|---|---|---|---|
| S1a | `[490 1/10]` | The migration (`20261017120000_mailbox_connections_google.sql`, with its rollback): the table, the audit actions and the three state-change functions; the provider-safe Microsoft paths | Graph only, behaviour-safe |
| S1b | `[490 2/10]` | `gmail.ts`: OAuth, grant checks, refresh classification, send | No (no importer) |
| S1c | `[490 3/10]` | `rfc822.ts` and `nodemailer` 10.0.14 | No (no importer) |
| S2a | `[490 4/10]` | The optional screen-token envelope and the lazy platform `From` | Live, behaviour-safe |
| S2b, part 1 | `[490 5/10]` | The dispatcher (`connectedSender.ts`), `sendViaGmail`, `markRevoked`, `sendViaGraph` | No (no importer outside `src/lib/email`) |
| S2b, part 2 | `[490 6/10]` | The outbox and `/mailbox` wiring: identity read, early refusal, envelope, `expect`, disconnect | No Google row can exist yet; the Graph fail-closed changes are live |
| S3a | `[490 7/10]` | The callback, the only writer of Google rows | Not from the app: only a hand-made round trip, and only with `GOOGLE_SEND_*` set, which stays unset everywhere until S3b merges |
| S3b | `[490 8/10]` | The connect route and the whole Mail settings card | **Yes, first reachable** |
| S4 | `[490 9/10]` | This ADR, D102 and the runbook | Docs |
| S5 | `[490 10/10]` | Public `/privacy`, `/terms` changes and the verification text | Public pages |

Proven offline: `tests/email-gmail.test.ts`, `tests/email-rfc822.test.ts`, `tests/email-connected-sender.test.ts`, `tests/email/gmail-scopes.test.ts`, `tests/api-v1-outbox.test.ts`, `tests/api-v1-mailbox.test.ts`, `tests/api-v1-mailbox-google-connect.test.ts`, `tests/api-v1-mailbox-google-callback.test.ts`, `tests/email-firm-google-domains.test.ts`, `tests/mail-client.test.tsx`, `tests/content-egress-canary.test.ts`, the SQL probe `supabase/tests/mailbox_connections_google.sql` (including the rollback of each state change when its audit write fails) and the integration test `tests/integration/gmail-send-revoked.test.ts` (both run in CI). The fake Gmail API (`tests/helpers/fakeGmailSend.ts`) decodes each raw message with `postal-mime`, so tests assert the `From`, Bcc, HTML and attachments that would reach Gmail.

Not proven: a live send, the exact consent lines Google shows for `openid email gmail.send`, and Blocked then Trusted on the real client. All are owner step T2, on the paid dev Workspace now that `emailmask.uk` has expired ([setup checklist](../04-operations/dev-google-workspace-setup.md)).

## Not built, by impact

| Gap | Why it matters | Blocks telling Ignatious the button is ready? |
|---|---|---|
| Live check (T2) and the guide's consent sentence (T12) | The guide tells bankers to cancel if the consent screen lists anything besides "Send email on your behalf", and `openid email` may add lines | Yes (runbook precondition) |
| Ignatious's firm domain on record (T14) | Without it every connect is refused with `no_firm_domain` | Yes |
| Google verification: privacy page, homepage, published app (T4, S5) | Unverified sensitive-scope apps show a warning and are capped at 100 new users; a Trusted app lifts this for that org only | No for a Trusted pilot org; yes for broader use |
| Ambiguous 5xx on send (T7) | A retry after a 5xx that in fact delivered sends twice; shared with Graph | No |
| Graph parity (T5) | A broken Graph connection still reads "Connected", with no audit rows | No |
| Real Message-ID and threaded replies (T11) | ADR-0023 decision 3; belongs with #268 | No |

## Alternatives considered

| Option | Why not |
|---|---|
| Send through domain-wide delegation | Out of scope by owner decision (#490). The reader's grant would need `gmail.send` for every user in the domain, which ADR-0022 decision 3 forbids |
| `gmail.send` only (design Q2 option B) | Nothing would tell Conductia which account approved. A wrong-account connect would send `From: <banker>` through someone else's mailbox, with the Sent copy landing there |
| `openid` and a `sub` match only (design Q2 option C) | Works only for bankers bound through Google sign-in. Kept as a secondary check inside decision 2 whenever a binding exists |
| Fall back to the platform address when the approval ends (design Q1 option B) | The sender identity would change without anyone deciding it, an admin's Block would be quietly undone for sending, and the owner's guide says the opposite |
| A per-send "send from the platform address this time" option (design Q1 option C) | Composer UI in Marcelo's area and more scope than W7 allows. It can follow without changing this design |
| Re-screen every Gmail send, even with a send-as-is token | Reverses #192 slice 2b (the record is the read the sender saw, with no second paid, nondeterministic call). A CCO policy call, held as T13 |
| One row per provider, `unique(user_id, provider)` | Needs a precedence rule between two live mailboxes, and no user needs two. One migration if that changes |
| Reuse the reader's HTTP client (`src/lib/google/reader/http.ts`) | Breaks the no-send-path fence, and its retry policy is wrong for a send that must not repeat |
| Hand-rolled MIME, or `mimetext` | Encoded words, filenames, folding and line limits are where mail bugs live; `mimetext` is less used |
| Cache access tokens | A Block could keep working for up to an hour |
| Hide the half-built stack behind unset env alone | Not enough on its own, and not the only control: no Google row can exist before S3a. From S3a the callback needs the state and verifier cookies, which a banker could set by hand in their own browser, so `GOOGLE_SEND_*` also stays unset in every environment until S3b merges (runbook) |
| Revoke a refused grant at Google (design R22, replaced) | Google's revoke can end every grant the account gave the Cloud project, Google sign-in included when the sending client shares that project. A refusal stores nothing instead, and the banker removes the grant at `myaccount.google.com/permissions` |

## Costs

| Item | Cost | Notes |
|---|---|---|
| Gmail API | $0 within quota | `messages.send` costs 100 quota units; the limit is 6,000 units a minute per user. Workspace sending limits apply as for any Gmail send |
| Token call per send | $0 | One extra request per send |
| Google verification | $0 | `gmail.send` is Sensitive, not Restricted, so no annual security assessment. Brand and sensitive-scope review are owner steps (T4) |
| `nodemailer` | $0 | One dependency, pinned exactly, re-checked against advisories before each bump |

## Regulation and Google policy

| Area | What applies | How this design answers it |
|---|---|---|
| Books and records (FINRA 4511, SEC 17a-4) | The bank keeps its correspondence | The outbox row stays Conductia's record, as for every send, and the message now also sits in the banker's own Gmail, inside the bank's tenant and archive. The bank verifies its archive covers it |
| Google API Services User Data Policy, Limited Use | Google user data used only for the user-facing feature | `gmail.send` is used only to send what the banker composes; `openid email` only to confirm the account. No read scope is requested. The disclosure is on the public `/privacy` page (S5) |
| Least privilege | Request only what is needed | Three scopes, pinned by `tests/email/gmail-scopes.test.ts`; a grant holding anything else is refused and nothing is stored |

## Open points

| Item | What changes if wrong | Owner |
|---|---|---|
| T1: which Google Cloud project hosts the sending client, who sets the redirect URIs, publishes the app and submits verification. Recommended: a dedicated sending project, apart from Google sign-in, so no Google-side action on the sending client can touch sign-in grants | Only env values | Owner and Martin |
| T2 and T12: the live check, and the guide's consent sentence once Google's exact wording is known | Gate for telling Ignatious the button is ready | Owner |
| T3: should Disconnect also revoke at Google. A revoke can end the account's other grants in the same Cloud project, so it is safe only with a dedicated sending project (T1) | About 15 lines in `DELETE /api/v1/mailbox` and one guide line | Owner |
| T4: privacy page status (draft banner or not), the homepage URL, the demo video, who submits | Whether Google accepts the verification | Owner and counsel |
| T13: should Graph and platform sends bind the envelope too, and should every send re-screen | One comparison in the outbox for every provider; or a CCO policy change | Marcelo and the CCO |
| T14: `firm_identity_providers.organization_id` for Google is always the primary Workspace domain, and Ignatious has it or verified domains seeded | Every Ignatious connect refused, or a secondary-domain banker refused | Martin, then ops |

## When to revisit

| Trigger | Change |
|---|---|
| A banker's Google address differs from their Conductia address, for example an alias (T10) | Match on the bound work identity or a verified alias list instead of the email |
| The owner answers T3 with "revoke" | Best-effort revoke on Disconnect, and the guide's revoke steps shorten |
| Marcelo and the CCO answer T13 | Bind the envelope for every provider, or re-screen every send |
| A banker needs two sending mailboxes | `unique(user_id, provider)` and a precedence rule |
| Google documents a `From` rule for non-alias senders, or changes the consent lines | Revisit the parse-back's reach, or the guide's Step 2 |
| Reply from the platform ships (#268) | Store the RFC 5322 Message-ID and reply in thread (T11) |

## References

`src/lib/email/gmail.ts`, `src/lib/email/rfc822.ts`, `src/lib/email/connectedSender.ts`, `src/lib/email/tokenCrypto.ts`, `src/lib/email/firmGoogleDomains.ts`, `src/lib/constants/mailboxSend.ts` (scopes, refusal reasons, cookie names, copy), `src/lib/constants/audit.ts`, `src/lib/compliance/screenToken.ts`, `src/app/api/v1/outbox/route.ts`, `src/app/api/v1/mailbox/route.ts`, `src/app/api/v1/mailbox/google/connect/route.ts`, `src/app/api/v1/mailbox/google/callback/route.ts`, `src/components/mail/MailClient.tsx`, `openapi/phase1.json`. Migration `20261017120000_mailbox_connections_google.sql`, rollback `supabase/rollback/20261017120000_mailbox_connections_google_down.sql`. Fences: `tests/google/no-send-path.test.ts`, `tests/email/gmail-scopes.test.ts`, `tests/content-egress-canary.test.ts`. Rehearsal: branch `wave6/deploy-rehearsal`, `ops/wave6-rehearsal/gcp/20-gmail-send-test.py` and `20-gmail-send-RESULTS.md`. Google: OAuth 2.0 for web server applications, Gmail `users.messages.send`, Workspace App access control, sensitive scope verification (read 2026-10-17).
