# Conductia — Pre-Send Compliance Rules

> Current marking addendum, September 21, 2026: email on a live deal or pitch
> receives `[Confidential]` automatically in its subject, visible before send
> and enforced server-side. The label is part of the screened, sent and retained
> subject. Source: Storm Q2 A, recorded in the email response ledger.
> The historical hold/block routing below predates the shipped Risk Patcher;
> it must not be used to restore automatic holds. This marking change does not
> implement the separate Q1/Q7 retention decision.

> **Current recipient policy (D60, September 21).** For deal mail, the server
> classifies every To/CC/BCC against current membership, delivered pending
> invitations and explicit Team affiliations. Counterparties and their advisors
> always require recipient approval; clients and their advisors remain visibly
> external without that extra approval. Missing relationships require approval.
> Domain matches never confer deal membership. Approval is signed and bound to
> the exact message, attachments, actor, deal and current relationship policy.
> Recipient approval does not grant Risk Patcher approval. No recipient preflight
> record is persisted; committed outgoing mail records the effective decisions.
> [Approved design](../superpowers/specs/2026-09-21-recipient-relationships-design.md).
>
> **Historical routing below:** the pre-August-24 hold/block behavior described
> below was superseded by Risk Patcher (Conductia PR #2). Current content-risk
> decisions return to the sender, including MNPI, with explicit send-as-is and
> audited override. Authentication, authorization and sender configuration still
> gate sending. Q6 high-risk configuration and Q1/Q7 retention are separate work.

The complete list of checks the email screening runs today, taken directly from the repository (`src/lib/compliance/screen.ts` and `src/lib/compliance/llm.ts`). Requested by Storm at the Aug 3 demo.

## How a message is judged

Every email sent inside Conductia is screened twice before it can leave:

- **Layer 1 — deterministic rules** (this document's lists). They run live while the banker types (advisory flag) and run AGAIN at send as the hard gate. This layer is the control: no AI in the verdict.
- **Layer 2 — AI double-check (Claude)** at send only. It catches what fixed rules cannot: paraphrased MNPI (Material Non-Public Information), implied or softened promises. It can only RAISE a verdict (compliant to hold, hold to blocked), never lower one. If the AI is unavailable, the deterministic verdict stands and the message is visibly marked "not AI-checked".

Three possible verdicts:

- **Compliant** — passes all checks; the email sends.
- **Hold (MNPI)** — MNPI signal; the email does NOT send and waits in the CCO (Chief Compliance Officer) review queue for release or reject. (The approach Storm endorsed on Aug 3.) **The queue has no bypass: a sender sign-off never clears an MNPI signal.**
- **Hold (reputational only)** — the AI's front-page test found ONLY a reputational concern (no MNPI, no promissory issue). This does NOT queue: the concern comes straight back to the sender in a dialog with an AI-suggested rewrite (changes highlighted) and an ephemeral risk read. The sender decides: use the suggestion, send as written (the override is audited), or edit. Per Storm, Aug 11: "the system saves them from themselves, not from sending."
- **Blocked** — promissory language WITHOUT the sender's sign-off; the email does not send and comes back with a suggested rewrite.

**Sender sign-off (Aug 13 refinement, "option A").** While typing, each flagged term is underlined with a one-click "Keep" sign-off. A promissory term the sender explicitly kept no longer blocks: if every flagged issue in the message carries a sign-off and no MNPI signal is present, the message sends — with the sign-off recorded in the compliance audit, so supervision sees exactly which flagged terms were kept knowingly. The AI still reviews the whole message and can hold or block on anything the sender has NOT signed off. Adopted from Storm's most recent guidance ("sender always retains override authority"); **if compliance wants this stricter, say so and the routing flips — the escape clause is part of the decision record (issue #164, decision 2).**

**The ephemeral risk read.** The dialog shows a 0-100 risk read at send time. It is deliberately never stored anywhere (Storm, Aug 11: legal liability) — the audit records the sender's decision, not the number.

Priority when both match: blocked wins over hold. The subject line, the body, the rich-text (HTML) body, and every attachment FILENAME are all screened — each field separately, plus a cross-field MNPI check (a figure in the subject and its context in the body still hold together).

**Attachment content (Storm, Oct 9, "Option B").** At send, the text of every attachment (PDF, DOCX, plain text) is read and screened as one more field, by both layers, exactly as the body is. An attachment that cannot be read in full (part of it scanned, an unsupported file type such as an image or spreadsheet, password protected, damaged, over 300 PDF pages, slower than 8 seconds to read, or past the 100,000 characters of attachment text one message may put through the screen, so the AI pass is never silently dropped for size) is never treated as clean: the message comes back to the sender with the reason "Attachment N was not screened", and a send as written is queued for the CCO like any other flagged send. The screen record names attachments only by position, with how each was read and which rule kinds it hit, never by file name or text (D80). Code: `src/lib/compliance/attachmentText.ts`, `src/lib/compliance/attachmentScreen.ts`.

## Layer 1A — Promissory language (verdict: BLOCKED)

Forward-looking commitment language to a counterparty. Each pattern comes with the rewrite suggestion shown to the banker:

1. "I guarantee / we guarantee / guaranteed / guaranteeing" — rewrite: replace with a non-binding alternative: "we believe / we expect to / our intent is".
2. "guaranteed board seat / role / position / outcome / return" — rewrite: avoid offering a guaranteed role or outcome to a counterparty pre-close; frame as a discussion point, not a commitment.
3. "I promise / we promise" — rewrite: replace with "intend to" or "expect to".
4. "can we promise / could we promise" — rewrite: asking whether to promise is itself promissory framing; rephrase as a discussion of terms.
5. "I commit to / we commit to" — rewrite: replace with "are working toward" or "intend to" pre-signing.
6. "you have my word / you have our word" — rewrite: personal-word commitments are promissory; remove and route through advisors.

Exception for patterns 3, 5 and 6 (tuned 2026-09-30 against the false-positive test set, then tightened after an adversarial review): a promise, commitment or word about our own delivery or timing is a service commitment, not a deal term, and is not flagged. It is an allowlist, not a blocklist:
- only these actions escape: sending, sharing or circulating a known document (deck, materials, slides, presentation, agenda, notes, summary, update, invite, documents, draft, CIM, teaser, NDA, comments, markup, questions, timeline, schedule); getting back to you; following up; reverting to you; responding or replying to you; calling you; keeping you updated, posted or informed; updating you;
- and only when the rest of the sentence, across line breaks, has no number, no currency or percent sign, and no deal term (offer, price, bid, range, valuation, terms, seat, role, earn-out, indemnity, premium, multiple, consideration, exclusivity, equity, stake, proceeds, upside, bonus, retention, job, headcount, board, closing, LOI, SPA, number, figure, return, outcome, deal, merger, acquisition, announce, walk-away, floor, ceiling, model, EBITDA, margin, cap table, no-shop; plurals included);
- and only when the sentence ends right after it, or after nothing but an addressee ("to you"), a topic ("on the diligence questions") or a time ("tomorrow", "by Friday noon", or a known process event such as "as soon as the second round closes" or "once legal signs off"; a free clause like "once your team is safe" keeps the flag). Anything joined on with "and", "so", a comma or a semicolon keeps the flag (tightened 2026-10-01 after Guillermo's review of PR #304).

So "we commit to sending the revised deck by Friday" and "I promise to get back to you by end of day" pass, while "we promise to deliver 20% returns", "we promise to share the upside", "we commit to call the deal off", "I promise to call you with the number" and "we promise to send you the revised deck and the buyer will match it" stay promissory. Guarantees (patterns 1 and 2) have no exception.

## Layer 1B — MNPI signals (verdict: HOLD)

Two independent triggers; either one holds the message.

Trigger 1 — any of these keywords or phrases:

- internal valuation
- internal model
- valuation model
- deal floor
- price floor
- reservation price
- walk-away
- mnpi
- material non-public
- board minutes
- draft 10- (draft SEC filings, e.g. 10-K / 10-Q)
- unannounced

"walk-away" and "unannounced" are not flagged in a narrow set of everyday uses only: "a walk-away success", "an unannounced visit / visitor / guest / drop-in". Any other use ("our walk-away price", "unannounced restructuring") still holds.

Trigger 2 — a dollar figure TOGETHER WITH valuation context in the same message:

- a figure like $510M, 510M, $1.2B, 1.2 billion, 300 million
- plus any of: floor, ceiling, valuation, model, EBITDA, margin, range, target price, cap table, term sheet

A figure alone ("dinner was $80") does not trigger; a figure next to valuation context does.

## Layer 2 — What the AI is asked to catch

The Claude layer is instructed, verbatim in scope: implied or softened promissory commitments to a counterparty, and subtle MNPI leakage such as internal valuations, price floors, or unannounced facts — judged only on the message text, never flagging ordinary deal logistics. Escalate-only; a rules verdict is never downgraded.

## Recording

Every screen and every send is written to the audit log with the verdict, the reasons, whether the AI layer ran, and a hash of the screened text (on an outbox send with attachments, of the screened text plus each attachment's byte hash, so a send-anyway decision covers the exact files). Held and blocked messages are stored in full (SEC 17a-4 / FINRA 4511 retention posture) so a supervisor can actually read what they are reviewing.

Releasing or rejecting a held message is restricted to an overseer (CCO or admin) — and never the message's own sender (four-eyes): a CCO whose message lands in Held cannot clear it themselves; another overseer must review it.

## Known gap, per Storm's Aug 3 request

Storm expanded the screening scope beyond regulatory compliance to REPUTATIONAL risk — the "Wall Street Journal test": would you be embarrassed if this email ran on the front page? No rule above covers that today. Proposed next step: add a reputational-risk instruction to the AI layer (it is judgment-shaped, a poor fit for fixed patterns) and iterate the wording with Lance, Jess and Storm on this document.

## External recipient warning (Storm Q3, September 21, 2026)

Storm selected Q3 A: warn when mail leaves the firm and let the banker send.
The composer checks To, CC and BCC against the sender company's verified domains;
exact domains and subdomains count as internal. An external address shows a red,
text-labelled advisory. Missing policy is explicitly unverified; a failed policy
preview offers Retry. Neither adds a confirmation step. The outbox reloads the
policy on the server and saves the boundary with the normal committed message.
A server lookup failure never stops the send (Storm, Q3: warn, do not block); the message is recorded as `unverified` and the failure is logged.
Historical messages keep an unknown boundary; no backfill is performed.

This does not settle Q4's broader working group or Q6's high-risk confirmation,
and does not change risk screening, access checks, retention or legal holds.
Source: Storm's September 19 answers, preserved in
[the decision record](../project-memory/email-decisions-2026-09-19.md).

## Recipient colours and the project's recipient history (Issues #378 and #429, October 2026)

Storm's rule (September 30): who is on an email follows the project. Each
recipient chip in the composer and in the review dialog carries one marking,
in colour and in text:

| Marking | When | Extra step |
|---|---|---|
| Internal (unmarked, neutral chip) | Inside the firm's verified domains and no approval needed | None |
| External (orange) | Outside the firm, or the firm's domains cannot place the address, and no approval needed | None |
| Needs approval (bright red) | Any recipient that needs a second approval (below) | Review dialog |

A second approval is needed for a counterparty or a counterparty advisor
(every time), a relationship that needs review, and anyone not associated with
the deal, in To, Cc and Bcc alike (D81, Oct 5, which reverses D67's To
exemption). The one exception is the project's recipient history: an outside
recipient (verified outside the firm's domains) who was on an email already
sent on this deal is known to the project and is shown orange with no extra
step. A colleague inside the firm who is not on the deal, and an address the
firm's domains cannot place, are still confirmed: history never crosses the
information wall.

The history is the deal's sent mail only (`outbound_messages` with status
`sent`, newest 1,000 messages). Nothing records an unsent email (D80), so a
recipient becomes known only when an email to them actually leaves.

For an outsider new to the deal the review dialog offers Storm's three
choices: send anyway and add as a known recipient, remove the recipient, or go
back to editing. Sending is what adds them, since the sent message becomes
part of the history.

The send audit row (`audit_log`, action `send`) records the choice: it keeps
the full `recipientReview`, adds `recipientOverride: true` whenever any
recipient needed approval and the sender approved it, and lists
`knownRecipientsAdded` (the outsiders new to the deal that this send made
known). The flags exist only on the row of a message that was sent; a
challenge the sender abandoned leaves no record.
