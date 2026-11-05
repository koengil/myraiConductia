---
run_id: smart-onboarding
type: spec
round: 2
---

# Spec v2 — Smart onboarding demo experience

Supersedes `spec-v1.md`. Changes in this round resolve the five blocking findings in `cr-spec-v1.md`:

| Finding | Resolution |
|---|---|
| 1.1 preview zero-access state | New **B13**; D8 extended |
| 2.1 lookup loading/failure/race | New **A13–A16**; D8 extended |
| 4.1 C1/C3 contradiction | **C1** rewritten as a live-reading contract; D8 extended |
| 5.1 another-company roster exception | **C10** prohibition made unconditional; D8 extended |
| 5.2 identity/membership disclosure scope | **A5** re-anchored; new **A17–A19**; D8 extended |

## 1. Problem

Bringing a counterparty onto a deal today is a form. The inviter types an email, picks a company from a list, picks a role, and sends. Nothing in the product tells them what Conductia already knows about that address, and nothing shows them what the person will actually be able to see once they accept. The inviter is asked to make an access decision with no evidence and no preview of its consequence.

On the other side, the invitee accepts, verifies, completes 2FA, and lands on a deal home that states a code, a codename, and two links. It does not tell them who they are on this deal, what has been released to them, what they are permitted to do, or what to do first.

The result reads as plumbing, not as a compliance-first platform. It is also the weakest moment in the Ignatious demo: the single most compliance-loaded action in the product (granting an outsider access to a live sell-side process) is the least instrumented.

## 2. Goals

1. From one work email, the inviter sees a compact, evidence-backed reading of who this person is, which company they belong to, and what the least-privilege setup should be, before anything is sent.
2. Before sending, the inviter can see the exact access perimeter the invitee would receive, computed by the server from the same rules that govern real access, and can watch it change as they adjust the proposed role or phase.
3. After the invitee accepts, verifies, and completes 2FA, the deal home tells them precisely who they are on this deal, what is available to them now, what they may do, and what to do first.
4. Every recommendation remains a proposal. Explicit human confirmation is still required for every access decision.
5. The three parts read as one continuous experience with a single confident voice, and are demonstrable end to end from a documented deterministic setup.

## 3. Non-goals

1. A free-form onboarding chatbot or any conversational surface.
2. Automatic access grants, automatic company creation, automatic invite sending, or autonomous phase raises.
3. Public-web company research, crawling, sanctions adjudication, paid enrichment, or any claim that Conductia has performed KYC/KYB on the invitee or their company.
4. A mandatory LLM call anywhere on the primary path.
5. New workflow or request-management primitives created solely to populate the welcome brief.
6. A fourth invitation flow. No replacement of Gate 0, Team, Data Room, or the scoped external shell.
7. Any change to the external access invariants, TOS consent, out-of-band recipient verification, 2FA, Box mediation, or audit retention.

## 4. Vocabulary (as used below)

- **Inviter**: an authenticated user who is authorized to create the invitation being composed. Includes the deal MD, an MD-delegated seat holder, a company director, and a member holding delegated invite authority.
- **Invitee**: the person identified by the entered email address.
- **Company role**: Director or Member.
- **Deal role**: Managing Director, Deal Team, Legal Counsel, Seller, Buyer, Observer.
- **Phase**: the monotonic disclosure phase carried by a deal seat. Higher phase means more of the deal room is released. Phase gates external users only.
- **Room**: Internal (bank work product) or Deal.
- **Classification**: 1 Public, 2 Internal, 3 Confidential, 4 MNPI.
- **Perimeter**: the set of destinations, document counts, and capabilities a given (company, deal role, company role, phase) tuple would yield on this deal.
- **Invitation surfaces**: the Gate 0 wizard Team step (invitations queued while the deal is being created) and the Team destination's invite dialog (invitations against a live deal).
- **Bound inputs** (new in v2): the tuple that identifies which question a lookup or preview result answers, namely the normalized email, the selected company, the deal in context, and the invitation surface in use. For a preview, the proposed deal role, company role, and phase are bound inputs as well.
- **Visibility scope** (new in v2): the set of facts an actor is already entitled to observe elsewhere in the product without this feature existing. Used to bound what lookup may disclose.

## 5. User behavior

### 5.1 Smart lookup

The inviter opens either existing invitation surface and types a work email. As soon as the address is syntactically complete, Conductia presents an intelligence card beneath the field. The card is a reading, not an action.

The card names what Conductia established: the company this address belongs to when the domain matches a company already on the platform, together with the evidence for that match; or, for an unrecognized business domain, a proposed human-readable company label derived from the domain and plainly labeled as unverified. It raises warnings it can establish from platform data and is entitled to disclose to this actor: a personal or disposable domain, a domain that contradicts the selected company's verified domain, an address that already belongs to a platform user, a person who already holds a seat on this deal, and an invitation to this address that is already pending.

The card recommends a setup: a context-appropriate deal role and the least-privilege starting phase, each with a one-line reason. The recommendation is pre-filled into the form's controls where the form already has such controls, and the inviter can override any of it. Nothing is created, sent, or granted by looking up.

The card always answers the question currently on screen. While it is being computed it says so. If the inviter edits the address or changes the company, whatever was on screen stops being presented as current, and any pre-fill that came from it is withdrawn. If the lookup cannot be completed, the card says that plainly and recommends nothing.

### 5.2 Live perimeter preview

From the same composing surface, the inviter opens **What they'll see**. Conductia asks the server to evaluate the currently proposed setup and returns the perimeter: which destinations the invitee would have, how many documents would be available to them, whether they could upload, whether they could see Team, and whether they could invite a teammate at their own company.

The preview also states, unconditionally, what stays hidden: an external user never reaches Internal-room content, and never reaches classification-4 MNPI, at any phase. This is stated as an invariant, not as a count.

When the proposed setup would open nothing at all, the preview says exactly that: no documents would be available at this phase. It does not go quiet, and it does not hint at how much exists on the other side of the wall.

Adjusting the proposed role, company role, or phase re-evaluates the perimeter. The displayed perimeter always corresponds to the inputs currently on screen; while it is being recomputed, or when the inputs have moved ahead of the last result, the surface says so rather than showing a stale answer as current. Opening the preview grants nothing and records no grant or view.

The same preview is available to an authorized user considering raising an existing member's phase, so the consequence of the raise is visible before it is made.

### 5.3 Personalized welcome brief

The invitee follows the emailed link, enters the out-of-band verification code, accepts, records TOS consent, and completes 2FA. They land on the deal home inside the scoped external shell.

The deal home now opens with a brief addressed to them. It names the deal by codename and code, their company, their role on this deal, and their current phase. It summarizes what is available to them right now: how many documents they can open, and what they are permitted to do. It then offers a short ordered list of real next actions, drawn only from what they are actually permitted to do: review the Data Room, upload when they hold upload rights, open Team, and invite a teammate at their own company when they hold invitation authority.

The brief is a live reading, not a one-time greeting. Its shape is stable across visits, so it is a dependable landmark; its values are recomputed from current server data on every render, so a phase raise or a new release shows up on the next load without any client action.

## 6. Acceptance criteria

Each criterion is independently testable. "The server decides" means the client renders a server-provided answer and never recomputes the rule locally.

### A. Smart lookup

**A1.** Lookup is reachable from both existing invitation surfaces (the Gate 0 wizard Team step and the Team destination's invite dialog). No third invitation flow is introduced, and neither surface loses any capability it has today.

**A2.** Lookup is performed by the server and is authorized with the same authority required to create the invitation being composed. An actor who could not create this invitation receives no lookup result. Authority to compose an invitation is necessary but not sufficient for every disclosure the card can carry; per-fact scoping is governed by A17–A19.

**A3.** For an email whose domain matches a verified domain of a company known to the platform in the actor's scope, the card names that company and states the evidence for the match (the matched verified domain).

**A4.** For an email on an unrecognized business domain, the card proposes a human-readable company label derived from the domain, and labels it explicitly as unverified and pending the inviter's confirmation. The proposal is never treated as an established fact.

**A5.** Subject to the disclosure scoping in A17–A19, the card raises a warning with a one-line reason for each of the following conditions that can be established from platform data: (a) personal or disposable email domain; (b) the address's domain contradicts the selected company's verified domain; (c) the address already belongs to a platform user; (d) that user already holds a seat on this deal; (e) an invitation to this address is already pending. Conditions (a) and (b) are properties of the entered address and the selected company, and are always available to an actor who passes A2.

**A6.** Condition A5(e), and any other statement about an existing invitation, is disclosed only to an actor who is authorized to manage that invitation. To every other actor the pending invitation is not revealed, and the surface does not imply its existence.

**A7.** The card recommends a deal role appropriate to the selected company's relationship to this deal, and recommends the least-privilege starting phase for a new external invitee. Each recommendation carries a one-line reason.

**A8.** Every recommendation is a proposal. Lookup never creates a company, never creates or sends an invitation, never creates a membership, and never grants or raises access. Running lookup repeatedly changes no durable state.

**A9.** The inviter can override any recommended value. Sending still requires the inviter's explicit confirmation of company, role, and phase, and still passes through the existing pre-send domain-confirmation gate for any non-matching domain.

**A10.** Lookup introduces no public-web crawler, sanctions service, paid enrichment dependency, or mandatory LLM call. It produces the same answer for the same platform state, actor, and bound inputs on every run.

**A11.** Lookup never returns a verification code, an invitation credential, a password, a token, or any other secret.

**A12.** For a malformed or incomplete email, the card is not shown and no request is issued. An empty or ambiguous result renders a neutral state, never a fabricated company.

**A13.** Every lookup result, and every control pre-filled from it, is bound to the exact bound inputs that produced it. A result is presented as current only while those inputs are unchanged.

**A14.** When any bound input changes, the previously displayed result immediately stops being presented as current and any pre-fill derived from it is withdrawn, so no security-relevant control retains a value recommended for a different address or company. A response that arrives for superseded bound inputs is discarded and never rendered, never pre-filled, and never allowed to overwrite a newer result, regardless of the order in which responses arrive.

**A15.** While a lookup is in flight, the surface communicates that state to sighted and assistive-technology users, and does not present the previous result as the answer to the current inputs.

**A16.** A lookup that fails renders a neutral unavailable state. It recommends nothing, pre-fills nothing, states no company match, states no warning, and does not bypass, weaken, or auto-satisfy the existing pre-send confirmation gate. The inviter can still compose and send through the normal confirmed path.

**A17.** Condition A5(c) is disclosed only to an actor whose visibility scope already covers that user: an actor who may view the roster of a company the user belongs to, an actor authorized over the membership of a deal on which the user holds a seat, or a firm overseer within the user's tenant. To any other actor the condition is not disclosed.

**A18.** Condition A5(d) is disclosed only to an actor authorized to see this deal's membership. To any other actor the condition is not disclosed.

**A19.** For A5(c), A5(d), and A5(e), the response carries the bare fact only. It never adds the person's name, identifier, company, company role, deal role, phase, tenant, invitation contents, or any other roster or profile metadata. When an actor falls outside a condition's visibility scope, the response contains no field, flag, count, ordering, or wording from which that condition's truth could be inferred, so an unauthorized actor cannot distinguish an existing-but-invisible user, seat, or invitation from a genuinely unknown address.

### B. Live perimeter preview

**B1.** The perimeter is computed on the server. The client renders it and does not reproduce, cache as authoritative, or locally derive any access rule.

**B2.** Preview evaluation and real access evaluation use one shared decision path, so a document counted as available in the preview is a document the invitee could actually open under the same inputs, and one omitted is one they could not.

**B3.** The preview reports: the destinations the invitee would see, the number of documents available to them, whether they could upload, whether they could see Team, and whether they could invite a teammate at their own company.

**B4.** Document counts are reported per accessible room or disclosure band. A count is never reported for a room or band the subject cannot reach.

**B5.** The preview states the invariant denials explicitly: an external user cannot reach Internal-room content, and cannot reach classification-4 MNPI, at any phase.

**B6.** The preview response contains no title, filename, storage identifier, uploader identity, timestamp, or other metadata of any document the subject cannot access, and reports no count of inaccessible documents.

**B7.** Changing the proposed deal role, company role, or phase produces an updated perimeter without any grant. The result on screen always corresponds to the inputs on screen.

**B8.** While a preview is being computed, and whenever the bound inputs have changed since the displayed result, the surface communicates that state rather than presenting the previous result as current. A response for superseded bound inputs is discarded and never overwrites a newer result.

**B9.** Previewing is read-only. It creates no membership, no invitation, no grant, and no document-view audit event. Send, accept, grant, phase change, view, and download retain exactly their current audit behavior.

**B10.** A preview that cannot be computed fails closed: the surface reports it is unavailable, does not display a partial or optimistic perimeter, and states plainly that no access has been granted. The inviter is not blocked from cancelling or from proceeding through the normal confirmation gate.

**B11.** The same preview is available to an authorized actor evaluating a phase raise for an existing member, showing the perimeter that member would hold at the proposed phase. Opening it performs no raise.

**B12.** An actor not authorized to invite into the target, or not authorized to change the member's access, receives no preview.

**B13.** When the proposed setup yields zero available documents, the preview renders an explicit zero-access state that states no documents would be available at this phase. It still reports the destinations and capabilities that would apply and still states the invariant denials of B5. It does not fall silent, does not render an error, does not fabricate content, and does not disclose or imply how many documents exist that the subject could not reach.

### C. Personalized welcome brief

**C1.** The brief renders on the scoped external deal home reached after acceptance, verification, TOS consent, and 2FA, and remains available and structurally intact on every later visit, with no dependence on one-time client state. Its structure is stable across visits; its values, capabilities, and offered actions are recomputed from current trusted server data on every render, so a later visit reflects the viewer's perimeter at that moment rather than the one they had on arrival.

**C2.** The page validates the viewer's membership on this deal before any deal data is rendered. A non-member sees no deal content.

**C3.** All brief content is derived from current server data at render time. A phase raise, a new release into the data room, or a change in the viewer's permissions is reflected on the next render with no client action beyond loading the page.

**C4.** The brief states the deal codename and code, the viewer's company, their deal role, and their current phase, in the platform's own vocabulary.

**C5.** The brief states the number of documents currently available to the viewer, and the capabilities they hold.

**C6.** The brief offers an ordered set of next actions, each of which the viewer is actually permitted to take. It never invents a task and never offers an action the server would refuse.

**C7.** Upload is offered only to a viewer whose seat carries upload rights. A buyer-side or observer viewer is never prompted to upload.

**C8.** Invite a teammate is offered only to a viewer who holds invitation authority for their own company on this deal. A viewer without that authority is never prompted to invite.

**C9.** Every link in the brief targets a destination inside the scoped external shell's permitted set (Deal, Data Room, Team). No link leaves that set.

**C10.** The brief reveals no Internal-room content or metadata, no classification-4 metadata, no hidden company data, and no unaccepted-invitation context. It must not return, render, or derive any of its content from the member roster of any company other than the viewer's own, without exception. The brief may link to Team when the viewer is authorized to reach it; Team applies its own rules at its own boundary, and that link is not a channel for roster content into the brief.

**C11.** A viewer with zero available documents sees an honest empty state, not a fabricated count or a fabricated task.

### D. Cross-cutting

**D1.** All three parts operate only when `platform_onboarding` is enabled. With the flag off, none of the three surfaces appear and every affected surface behaves exactly as it does today.

**D2.** All authorization decisions are made server-side and fail closed. Client-side gating is explanatory only and is never the security boundary.

**D3.** No response introduced by this work exposes a verification code, invitation credential, session token, or storage credential.

**D4.** The existing one-time verification-code handling, TOS consent, 2FA, Box mediation, and audit behavior are unchanged.

**D5.** The primary path is legible at laptop demo size, operable by keyboard alone, announces state changes to assistive technology, and remains usable at narrower widths.

**D6.** The copy is Conductia's voice: senior, precise, statements not questions, evidence and reason labels rather than chat. No em-dashes in visible copy, except where an ARIA or regulatory separator requires one.

**D7.** A deterministic demo fixture or documented setup exists that reproduces, from a clean seeded state: enter one seller email, see the company and setup recommendation, open the perimeter preview, send, accept, complete 2FA, and land on the matching personalized brief. The runbook states any prerequisite and the expected observation at each step.

**D8.** Automated tests cover at least:

1. Each lookup warning condition in A5, positive and negative.
2. Scoped disclosure of a pending invitation (A6), for an authorized and an unauthorized actor.
3. Scoped disclosure of an existing platform user (A17) and an existing deal seat (A18), each for an authorized actor and for an unauthorized actor, including an actor at another company and an actor in another tenant.
4. The indistinguishability requirement of A19: for an unauthorized actor, the response for an existing-but-invisible user, seat, or invitation carries nothing that separates it from the response for an unknown address.
5. Lookup failure behavior (A16): no recommendation, no pre-fill, no confirmation-gate bypass.
6. Lookup response races (A13, A14): a superseded response never renders or pre-fills, and a changed bound input withdraws the prior result and its pre-fill. Covered on both invitation surfaces.
7. Preview parity with real access (B2).
8. Preview leakage prevention (B6): no inaccessible document metadata and no inaccessible counts.
9. Perimeter change under role and phase change (B7), and the phase-raise preview (B11).
10. The zero-document preview state (B13), including that it discloses no inaccessible count.
11. Preview failure (B10) and preview response supersession (B8).
12. Personalized-action selection for each viewer archetype: seller with upload rights, buyer without, observer, director with invitation authority, member without (C6–C8).
13. The later-visit contract (C1, C3): after a phase raise or a permission change, a re-render shows the new values and actions.
14. The cross-company negative for C10: a viewer's brief exposes no roster content from another company on the deal.
15. Flag-off parity (D1) for every affected surface.
16. The end-to-end demo path of D7.

**D9.** API documentation, schema constants, and feature-flag behavior stay synchronized with what ships.

**D10.** The repository's mandatory lint, type-check, test, and production-build gates pass before the pull request is opened.

## 7. Out-of-scope boundaries

The following are explicitly outside this spec and must not appear in the delivered work:

1. Any external network dependency for company or person intelligence.
2. Verified-domain administration UI, company-record editing, or a company directory beyond what already exists.
3. Changes to the invitation state machine, the verification-code lifetime, the acceptance flow, or the 2FA flow.
4. Changes to who may invite, who may raise a phase, or who may upload. This work makes existing authority legible; it does not widen it.
5. Bulk invitation, CSV import, or invitation scheduling.
6. Notification, email, or digest content changes.
7. Persisted preview results, saved perimeter snapshots, or preview history.
8. Anything that makes the invitee's welcome brief a task system.

## 8. Resolved product questions

**Q1. Who may run a lookup?** Exactly the actor who could create the invitation being composed. Lookup reveals company and membership facts, so it inherits the invitation's authority rather than a weaker one.

**Q2. May lookup create the proposed company?** No. The proposal is a label the inviter confirms. Company creation stays where it already happens.

**Q3. What is the recommended starting phase for a new external invitee?** The lowest phase. Disclosure is monotonic and raising is cheap; starting high is unrecoverable.

**Q4. What is the recommended deal role?** The seat that the selected company's relationship to this deal already implies (seller side for the target and co-sellers, buyer side for acquirers), and the bank's own internal seats for the bank company. The recommendation never proposes Managing Director.

**Q5. What is the recommended company role?** Member. Director is available as an explicit inviter choice, never as a recommendation.

**Q6. Is a pending invitation always disclosed?** No. It is disclosed only to an actor authorized to manage it. Otherwise the lookup is silent about it, because a duplicate signal is itself a disclosure about another company's or tenant's activity.

**Q7. Does the preview say how much is hidden?** No. It names the invariant denials qualitatively. Reporting the size of what is hidden is itself a disclosure about inaccessible content.

**Q8. Does the preview show document names?** No. Counts only, and only for reachable rooms or bands.

**Q9. What happens if the preview cannot be computed?** It fails closed and says so. It never renders an optimistic perimeter, and it never blocks the inviter from understanding that nothing has been granted.

**Q10. Where does the welcome brief live, and how long does it last?** On the external deal home, permanently. It is a live reading of the viewer's current perimeter, not a one-time greeting, which is also why it survives a refresh and reflects a phase raise.

**Q11. What does the brief show a viewer with no documents yet?** That no documents have been released to them yet, and the actions they can still take. Never a fabricated count and never a fabricated task.

**Q12. Does any part of this require new persistence?** Not by intent. All three parts read from state the platform already holds. If implementation establishes that new durable state is genuinely required, that is a plan-phase finding and carries a forward migration plus rollback notes.

**Q13. Why is authority to invite not sufficient to learn that an address is already a platform user?** Because that fact is about a person who may sit entirely outside the actor's world. Composing an invitation is a statement of intent toward one address; it is not a licence to probe the platform's user base. The product already limits ordinary roster reads to a caller's own company, and lookup must not become a wider identity oracle than the surfaces it sits beside. An actor therefore learns the fact only where they could already have observed it, and where they could not, the answer is shaped so that absence and invisibility look the same.

**Q14. If the welcome brief is a live reading, in what sense is it the same brief on a later visit?** Its structure is the constant: the same sections in the same order, so the invitee learns the shape once and can return to it. Its values are the variable. A member whose phase was raised between visits sees the same brief telling them something new, which is the point; a brief that froze at first render would quietly become a lie about their access.
