# Google OAuth verification: the sending client

Audience: the owner or Martin, who submit the sending client for Google's brand and sensitive-scope verification in the Google Auth Platform. Scope: the values each form asks for, the per-scope justification text, the demo video script, the submission checklist, and the points counsel must settle first. Design: #490, [ADR-0025](../07-decisions/ADR-0025-gmail-send-as-banker.md) (number to confirm at merge). Operations: [`gmail-send-runbook.md`](./gmail-send-runbook.md). Status: Proposed, pending counsel (T4).

**Engineering never touches Cloud Console.** Every step below is done by the owner or Martin. Engineering supplies the pages and the text.

This covers the **sending client** only: a Web application OAuth client that requests `openid`, `email` and `https://www.googleapis.com/auth/gmail.send`. It is not the Google sign-in client and not the domain-wide delegation reader (ADR-0022). The reader is authorized by each bank's admin in their own Admin console and is not part of this submission.

## What Google needs, and where it is

| Requirement | Value | Status |
|---|---|---|
| App name | Conductia | Owner to confirm it matches the brand on the homepage |
| User support email | A monitored Conductia address | Owner (T4) |
| App logo | `src/components/brand/assets/` (120 x 120 px PNG for the consent screen) | Owner exports and uploads |
| Application home page | Public, on a verified domain, describes the app and links to the privacy policy. The app root `/` is behind sign-in, so it cannot be the homepage | **Open (T4).** For example the `conductia.com` marketing site, once it links to the privacy policy |
| Privacy policy | `https://app.conductia.com/privacy` (`src/app/privacy/page.tsx`), public, no session | This PR. Google requires the policy on the same domain as the homepage: if the homepage is `conductia.com`, either verify both domains or host the policy there too (T4) |
| Terms of service | `https://app.conductia.com/terms` (`src/app/terms/page.tsx`) | This PR. Still a placeholder with "no legal force" (T4) |
| Authorized domains | `conductia.com` (covers `app.conductia.com`), verified in Search Console by a project Owner or Editor | Owner |
| Redirect URIs | Per environment, in the runbook's Configuration section | Owner (T1) |
| Scopes | `openid`, `.../auth/userinfo.email` (shown for `email`), `.../auth/gmail.send`. Nothing else | Owner adds exactly these three |
| Publishing status | In production, not Testing | Owner (T1) |
| Scope justification and demo video | Below | Owner records the video |

## Scope justification

Paste per scope in the Data Access page. Each text is under 1,000 characters `[unsure of the field's current limit]`.

### `https://www.googleapis.com/auth/gmail.send` (Sensitive)

> Conductia is compliance software for investment bankers working on M&A deals. Bankers write deal correspondence in Conductia, which screens every message for compliance before it is sent. With gmail.send, a banker who chooses Connect for sending in Mail settings has those messages sent from their own Gmail address, so recipients see the banker as the sender and a copy lands in the banker's Gmail Sent folder, inside their firm's archive. Conductia calls users.messages.send only when the banker sends a message from Conductia. It never reads, modifies or deletes mail with this client. Narrower options do not work: gmail.send is the narrowest Gmail scope that can send. gmail.compose and gmail.modify are broader (drafts, reading) and are not requested. Sending through a shared Conductia address would not appear as the banker or in their Sent folder.

### `openid` and `email` (non-sensitive)

> Used only to confirm which Google account approved sending. Before keeping the approval, Conductia checks that the account's verified email equals the banker's Conductia address and that its Workspace domain (hd) is the banker's firm. Without them Conductia cannot tell which account approved, and could send mail with the banker's address through someone else's mailbox. No profile data is requested.

### How the data is used (if the form asks for one summary)

> Conductia stores only the refresh token, encrypted at rest, plus the connected address, Google's account id and the granted scopes. A short-lived access token is minted for each send and not stored. Conductia stores the Gmail message id returned for each send, to trace it in the firm's compliance record. Disconnect in Conductia deletes the stored token at once. No Google user data is used for advertising, sold, or used to train AI models.

## Demo video script

Requirements (research 7e): in English; unlisted on YouTube; shows the consent screen with the app name and the OAuth client ID visible in the browser's address bar; shows each scope's feature in use. Record on production, or on the environment whose client is being submitted, as a banker in a Workspace domain whose admin has **not** marked the client Trusted, so Google's full consent screen appears `[unsure: a Trusted org may skip parts of the screen]`. Target length 2 to 3 minutes.

1. **Open (10 s).** Narrate: "Conductia is compliance software for M&A bankers. This video shows how Conductia uses the Gmail send scope." Show `https://app.conductia.com/privacy`, scroll to "Google user data" and pause on the Limited Use statement.
2. **Sign in (15 s).** Sign in as the demo banker. Open a project, then **Mail**, then **Mail settings**. Show the "Your mailbox" card with **Connect for sending** and its copy, including "This permission does not let Conductia read your mail."
3. **Consent (40 s).** Click **Connect for sending**. On Google's screen, click into the address bar and show `client_id=` with the full client ID. Show the app name, the account, and each permission line ("Send email on your behalf", plus any sign-in lines). Narrate that Conductia asks for sending only, plus the account's email to confirm it is the banker's own. Click **Allow**.
4. **Connected (15 s).** Back in Conductia, show "Connected for sending as {email}". Narrate: "Conductia checked the account is the banker's own Workspace account before keeping the approval."
5. **Use of gmail.send (45 s).** Click **New message**. Write to a test recipient, add a subject and body, click **Send**, approve the recipient review if shown. Narrate: "Conductia screens the message for compliance, then sends it through the banker's Gmail with the banker's address as the sender." Show the message in Conductia's message list.
6. **Result in Gmail (20 s).** Switch to the banker's Gmail. Show the message in **Sent**. Optionally show it in the recipient's inbox from the banker's address.
7. **Removing access (20 s).** In Conductia's Mail settings, click **Disconnect** and show the note that the stored approval is deleted. Then open `https://myaccount.google.com/connections` and show where the banker removes Conductia from their Google Account.
8. **Close (5 s).** Narrate: "Conductia never reads the mailbox with this permission."

Do not show real client mail, deal names or MNPI. Use test accounts on the paid dev Workspace ([dev-google-workspace-setup.md](../04-operations/dev-google-workspace-setup.md)); the `emailmask.uk` trial accounts expired on 2026-10-20.

## Submission checklist

Done by the owner or Martin, in order. Each line names the thread it closes.

- [ ] T1: the Google Cloud project for the sending client is chosen; the Web client exists with the redirect URIs from the runbook.
- [ ] T4: counsel signs off `/privacy` and decides whether its draft notice can stay or must go before submission (see below). If it goes, engineering removes the notice and bumps `PRIVACY_VERSION` in `src/lib/constants/legal.ts`.
- [ ] T4: the support email and `PRIVACY_CONTACT_EMAIL` (`privacy@conductia.com` today) exist and are monitored, or engineering changes the constant.
- [ ] T4: the homepage URL is chosen, it describes Conductia, links to the privacy policy, and its domain is verified in Search Console with the privacy policy on the same domain.
- [ ] Branding: app name, logo, support email, homepage, privacy and terms URLs, and authorized domains entered; brand verification submitted and passed.
- [ ] Data Access: exactly the three scopes added; the justification texts above pasted.
- [ ] The app published to production (out of Testing).
- [ ] The demo video recorded per the script, uploaded unlisted, and its link entered.
- [ ] Prepare for Verification, then Submit. Google's sensitive-scope review "typically takes 3-5 business days".
- [ ] Reply to any reviewer email from the project contact. Engineering supplies text changes; the owner or Martin submits them.

A Trusted pilot org (Ignatious) does not wait on verification: an admin marking the client Trusted lifts the unverified-app warning and the 100-user cap for that org only (ADR-0025, Not built). Verification is needed before banks that have not trusted the client can connect.

## Points for counsel and the owner

These are flagged, not decided. The page text states what the code does today; where a sentence depends on something engineering cannot prove from the repo, it is listed here.

1. **The draft notice.** `/privacy` opens with "Draft pending counsel review". Google's reviewers may reject a policy that reads as not in force. `/terms` still says it "has no legal force". Counsel decides both (T4).
2. **The Limited Use sentence.** The page uses: "Conductia's use and transfer to any other app of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements." This matches the wording published apps use (no "the" before the policy name); Google's policy page itself does not print the sentence, so confirm it in the OAuth verification help pages before submission. If it differs, change the page and the pinned string in `tests/privacy-page.test.tsx` together.
3. **Reading is disclosed beside sending.** The page does not say Conductia never reads mail. It says the sending permission does not let Conductia read mail, and separately discloses the deal-discovery reader (ADR-0022): a different authorization, granted by the firm's Workspace admin through domain-wide delegation, applied only after the banker consents in their profile. Counsel confirms the reading paragraph is complete enough, in particular on what the reader keeps and for how long, which the page does not state.
4. **"Does not use Google user data to train AI models."** This is a Limited Use requirement for Workspace API data. Model calls go through the zero-data-retention gateway (D90). The owner confirms that no Conductia process, including the deal-discovery evaluation harness (`evals/deal-discovery`), trains or tunes a model on mail read from Google.
   - **Owner, open: does anyone at Conductia read real mail?** The page no longer says "personnel do not read Google user data". Until the owner confirms that no person reads mail read from Google, including through the deal-discovery evaluation harness, it states only Google's Limited Use exceptions (the banker's agreement for specific messages, security, law, and aggregated and anonymized data for internal operations). If confirmed, the firmer sentence can return. If people do read real mail for evaluation, that needs the banker's agreement or anonymization first, and the page must say so (#490 audit, owner item 2).
   - **AI processing of read mail is disclosed.** Content read for deal discovery goes to Anthropic through Vercel's AI Gateway with zero data retention (`src/lib/modelGateway/gatewayClient.ts`; `src/lib/discovery/extract/run.ts`, `src/lib/discovery/propose/model.ts`). The page names it as a transfer needed for discovery, with no retention and no training (#490 audit item 4). Counsel confirms the provider should be named.
5. **Transfers to service providers.** Hosting and infrastructure providers process stored data on Conductia's behalf. The page treats that as "needed to provide those features". Counsel confirms whether the policy should name the categories of processors.
6. **Compliance review of sent mail.** Messages a banker composes in Conductia are screened and kept as the firm's compliance record, and held messages are reviewed by the firm's compliance officer. That content is written in Conductia, not received from Google, so the page treats it under section 2 rather than as Google user data. Counsel confirms.
7. **Acceptance records one version.** Invite acceptance records `TOS_VERSION` only (`audit_log` attest, `detail.tos_version`), while the checkbox now links to two documents. `TOS_VERSION` was bumped to `draft-2026-10-18` because `/terms` changed (it is no longer also the privacy policy). Recording `PRIVACY_VERSION` too would change the acceptance RPCs and is left as a follow-up.
8. **Legal entity and contact.** The page names "Conductia" with no legal entity or postal address. Counsel adds them if required.
   - **Owner, open: `privacy@conductia.com` must exist and be monitored before submission** (`src/lib/constants/legal.ts`, `PRIVACY_CONTACT_EMAIL`, `TODO(owner)`). Google's reviewers and users write to it (#490 audit, owner item 1).
9. **The Google linked-apps link.** The page links `https://myaccount.google.com/connections` as Google's third-party apps page `[unsure the path is current]`. Check it before submission.
