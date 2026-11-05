# Walkthrough handoff for engineers, Storm and Marco

Date: 2026-10-22, finalized 2026-10-24. Source: the product walkthrough of 2026-10-22 and the branch `feat/walkthrough-refinements` at `182420ec`. File references are relative to the repo root and were checked against that commit. "Develop" means `cb6e5170`, the commit the branch started from.

This page lists everything the walkthrough asked for that needs database, permission or server work. It also lists the server gaps the branch's reviews found.

Lance set the rule for this branch: "anything permission related we need to document simply, clearly, without breaking anything, so we can share it with the engineers. i want to be able to experience things as intended, but dont want to break or change database/permission pieces. i'd rather let the engineers do that."

**What the branch changed.** Screens, copy, browser-only state, tests and local-only seed scripts. It made one additive, read-only API change: `GET /api/v1/deals` now also returns the current step's assignee, its draft-run state and per-phase progress. The run state and the progress go to bank users only (see E14 and E19).

**What the branch did not change.** It made no database or permission changes. There are no migrations (`supabase/` has no diff from develop), and no RPC, RLS, authorization or notification-type changes. Every item that needs one is an entry below, for engineers to build.

Where the walkthrough asked to feel a flow that needs saving or permissions, the branch built a **Preview**. A Preview works in your browser only. It carries the chip "Preview" ("Not saved yet. Engineers are wiring this.") or the banner "Preview. Only you see this. Nothing here is saved to the deal." Code comments on each Preview cite the entry ID here, so the IDs never change.

## How to read this

Every entry has the same fields:

- **What we want and why:** the goal, with the meeting quote where there is one.
- **What the app does today:** the Preview and where to try it, or the screen-side guard, or nothing.
- **Current behavior:** what the server and database do now, with file references.
- **Proposed change:** what engineers should build.
- **Database and permission impact:** what it touches.
- **Risk if left:** what goes wrong if nobody builds it, and the risk of the change where it matters.

A line under each heading gives the kind, the priority, a rough size (XS, S, M or L) and whether the gap predates the branch.

**Kinds.** Confidentiality: data reaches someone who must not see it. Compliance: a compliance check or record can be skipped. Permission: someone can do something they should not. Database: new tables, columns, RPCs or constraints. API read: an additive read-only field or route. Product decision: blocked on an answer from Storm, Marco or counsel. Code only: no database, permission or API change. Not now: recorded so it is not lost.

**Priorities.** Fix first: a gap in what the server allows today. Next: needed for the walkthrough's flows to save for real. Later: wanted, but waits on a decision or on other work. Not now.

**Preview column.** Yes: a Preview you can try. Guard: the screens block, hide or relabel, but the server still allows it. Partial: part of it works from existing data. Works: it works today with no server change. No: nothing in the app.

Routes use `{code}` for a deal code, such as `/projects/EMBER-2026-751/rail`.

## Index

| ID | Title | Kind | Priority | Preview |
|---|---|---|---|---|
| E1 | Save a step reorder (deal rail and rail templates) | Database | Next | Yes |
| E2 | Copy steps from another rail | Database | Later | No |
| E3 | Per-deal rail edit rights and "Propose a change" | Permission | Next | Yes |
| E4 | Step dependencies, per-step dates and "started" facts | Database | Next | Yes |
| E5 | Live presence and pushed updates on the rail | Permission | Later | Partial |
| E6 | CCO and Admin role model and the invite hierarchy | Permission | Later | Guard |
| E7 | Signature storage and import from Gmail or Outlook | Database | Later | Yes |
| E8 | Save the profile photo and title | Database | Next | Yes |
| E9 | Compliance rules inside the skill-authoring and catalog prompts | Product decision | Later | No |
| E10 | Whole-output revision ("What should change?") | Product decision | Later | Works |
| E11 | Returned-draft audit row (Storm's call) | Product decision | Later | Guard |
| E12 | Discovery scanning scope and cost | Product decision | Next | No |
| E13 | Notifications refresh model | API read | Later | Partial |
| E14 | Cross-deal progress for the Book | API read | Next | Partial |
| E15 | Saved views: per user or shared with the deal | Database | Later | Yes |
| E16 | Data room for buyers (future) | Not now | Not now | No |
| E17 | Not now: Superhuman-style @mentions on email threads | Not now | Not now | No |
| E18 | Not now: bio or digital twin for each lead | Not now | Not now | No |
| E19 | Record agent run state so the Conductor Center can show running work | Database | Next | Partial |
| E20 | [CONFIDENTIALITY] Outside users with a firm role should not see every deal in the firm | Confidentiality | Fix first | No |
| E21 | Real tasks for the Book's deal console | Database | Later | Yes |
| E22 | Last activity per step without the 500-row audit cap | API read | Next | Partial |
| E23 | [CONFIDENTIALITY] Document uploads: server-side folder rules and Data Room filing | Confidentiality | Fix first | Guard |
| E24 | [COMPLIANCE] Mail to an outside address skips recipient review when no deal is named | Compliance | Fix first | Guard |
| E25 | [CONFIDENTIALITY] Outside parties can read every seat on the deal (names, emails, roles) | Confidentiality | Fix first | Guard |
| E26 | [CONFIDENTIALITY] Outside parties can read the deal's fee, schedule health and internal phase roll-up | Confidentiality | Fix first | Guard |
| E27 | [PERMISSION] A director can remove the firm administrator, the CCO and other directors | Permission | Fix first | Guard |
| E28 | "Mark complete" on a skill-backed step only moves the current step | Database | Next | Guard |
| E29 | [PERMISSION] A read-only member can be made a step's owner | Permission | Fix first | Guard |
| E30 | [COMPLIANCE] Rail templates let anyone with edit rights remove steps every deal needs | Compliance | Fix first | Guard |
| E31 | [PERMISSION] The invite list and the members list disagree about who can see a deal | Permission | Fix first | Guard |
| E32 | Who opened the deal: a creator name the rail can show | API read | Next | Guard |
| E33 | Notification links store the deal's UUID instead of its code | Code only | Next | Guard |
| E34 | Sign-out signs the person out on every device | Product decision | Later | No |
| E35 | Rail data generator and committed rail data have drifted | Code only | Later | No |
| E36 | `npm run seed:flags:enable` fails without the local env file | Code only | Later | No |
| E37 | Firm-editable default rail, and plain server errors | Database | Later | Guard |
| E38 | [PERMISSION] A read-only member can move the deal to the next step | Permission | Fix first | Guard |
| E39 | Deal-scoped teaser brief | API read | Later | Yes |
| E40 | The step PATCH returns the owner's id without their name | API read | Next | Guard |
| E41 | Team shows the deal seat, not the organization role | API read | Later | Guard |
| E42 | Rail zoom: one extra Back after a reload | Code only | Later | No |
| E43 | No end-to-end test covers the CCO releasing or returning held mail | Code only | Next | Works |
| E44 | A locked step control can show the wrong reason while its data catches up | Code only | Later | Works |
| E45 | The refused team inbox notice has no nav badge | Product decision | Later | Partial |

Where to find each entry: **Fix first** has E20, E23 to E27, E29 to E31 and E38. **Part 1** has the rest, grouped by area. **Part 2** has the questions, and **Part 3** the agenda.

---

## Fix first

Send these to engineers first. Each one is a gap in what the server allows today, and each predates the branch. The branch adds a guard in the screens so that Lance can try the flows as intended. The screens are not a security boundary: the data still reaches the browser, or the action still succeeds when the API is called directly. Every change here alters what the server allows, so each needs a security review.

### E24. [COMPLIANCE] Mail to an outside address skips recipient review when no deal is named

Kind: Compliance. Priority: Fix first. Size: S. Predates the branch: yes (`src/app/api/v1/outbox/route.ts` has no diff from develop).

- **What we want and why:** Every message to someone outside the firm goes through recipient review: not on the deal, counterparty, or unverified domain. There are no exceptions. Compliance is the product's moat: every intent and every message visibly routes through compliance.
- **What the app does today:** Guard. In Mail (`/projects/{code}/mail`), the composer always sends the deal's code, never the raw URL segment (`src/lib/mail/dealRef.ts`). It refuses to send to an outside address when it cannot match the message to a deal (`src/components/mail/MailComposer.tsx`, about lines 252 and 639; `src/components/mail/MailClient.tsx:159`; `src/components/dataroom/DealThreadPane.tsx:163`). A direct API call still gets through. On develop the composer sent the raw URL segment as the deal reference and kept Send enabled when the deal lookup returned 404, so it could already send untagged mail to outside addresses with no recipient review.
- **Current behavior:**
  - `POST /api/v1/outbox` resolves the deal with `resolveDealRefLenient` (`src/app/api/v1/outbox/route.ts:311`). An unknown or malformed reference sends the message untagged.
  - `checkRecipientApproval()` returns early when there is no deal: `if (!dealId) return null;` (`route.ts:395-396`).
  - So with `dealId` missing, null, `"sandbox-atlassian"`, or the real code with a leading space, the send returns 201 `sent` with `recipientBoundary: "external"` and no recipient review. The same body with the exact code returns `recipientReviewRequired`.
  - These messages carry no deal id, so they appear on no deal's Audit Trail or Sent folder. The content screen still runs.
  - Found by review hunt-mail-1, on localhost with the no-op mail provider, so no mail left the machine.
- **Proposed change:**
  - Fail closed. When any recipient is outside the firm's verified domains and no deal resolves, refuse with `400 deal_required`.
  - Keep the lenient path only when every recipient is internal.
  - Trim and validate the deal reference before resolving it.
  - Add tests for a missing, null, unknown and whitespace-padded `dealId` with an outside recipient.
- **Database and permission impact:** Route logic only. No schema change. It changes what the server allows, so it needs a security review.
- **Risk if left:** High. Anyone can email an outside address with no recipient review and no record on any deal. The fix is low risk. Check that no integration sends to outside parties without a deal: there should be none.

### E25. [CONFIDENTIALITY] Outside parties can read every seat on the deal (names, emails, roles)

Kind: Confidentiality. Priority: Fix first. Size: S. Predates the branch: yes (the only diff from develop in the route is one POST error string, `route.ts:186`).

- **What we want and why:** An outside party (the seller, a buyer, their advisers) sees only their own firm's people and the bank's deal contacts. They never see another bidder or the other side's people. On a sell-side deal with two buyers, buyer A must never learn buyer B's name or email. From the meeting: "I can't have a disgruntled employee come in and mess something up." Permissions must not be carte blanche.
- **What the app does today:** Guard (display filtering only).
  - Team (`/projects/{code}/team`) shows outside viewers only their own firm and the bank's deal contacts, and hides the "Data room access" list from them (`src/lib/team/rosterVisibility.ts`, `src/components/team/LiveTeamRoster.tsx:55` and `:307`).
  - For outside viewers, the Data Room and Deal Folder "Who has access" line names only their own firm and the bank's deal team (`src/lib/dataroom/whoHasAccess.ts`, `src/components/dataroom/WhoHasAccess.tsx`). Neither page reads the roster or the invite list for them, and nothing is read before their profile loads.
  - The Mail invite entry (`DealInvite` in mail mode, `src/components/team/DealInvite.tsx`) still reads the roster for outside viewers and renders nothing from it. That read predates the branch.
  - The API response still contains every seat.
  - On develop, `LiveTeamRoster.tsx` rendered every firm on the deal from `groupByCompany(roster)` to every viewer, one column per firm with each person's name and email. Team was an allowed page for outside parties (`ALLOWED_DESTINATIONS.external` includes `team`). So a seller or buyer on Team saw the other side's people and every other bidder. The "Data room access" list did not exist on develop. The branch added it and shows it to bank viewers only.
- **Current behavior:**
  - `GET /api/v1/deals/[dealId]/members` (`src/app/api/v1/deals/[dealId]/members/route.ts`, GET at line 49) returns every seat with name, email, deal role and access phase. It does not check which side the caller is on. Its doc comment (line 47) says "Readable by anyone on the deal".
  - Signed in as `buyer.intelibank@dev.com`, the response includes the seller (Mike Cannon-Brookes, `seller.intelibank@dev.com`) and all bank staff with emails. The seller sees the buyer the same way.
  - Found by review hunts hunt-people-1 and hunt-cross-6.
- **Proposed change:** When the caller is an outside user, filter the response to the caller's own company's seats and the bank's deal staff (with names and work emails only if the bank wants that). Add a test with two buyer firms on one deal.
- **Database and permission impact:** Authorization logic in one route, or an RLS-backed view if the team prefers. Security review required.
- **Risk if left:** High: cross-party disclosure on every deal with outside parties. Risk of the change: medium. Check every screen that reads this route for outside viewers: Team, Data Room "Who has access", and the invite dialogs.

### E26. [CONFIDENTIALITY] Outside parties can read the deal's fee, schedule health and internal phase roll-up

Kind: Confidentiality. Priority: Fix first. Size: S. Predates the branch: yes (`feeUsd` and `scheduleStatus` were returned to every caller on develop, and the Book page existed there).

- **What we want and why:** The sell-side fee, schedule status, internal phase roll-up and the Book's deal console stay bank-only. The fee and the internal schedule are the bank's commercial information. A buyer or seller seeing them is a confidentiality breach.
- **What the app does today:** Guard (display routing only).
  - Outside parties are sent away from `/projects/{code}/book` like other bank-only pages: `destinationFromPathname` now gives `/book` the bank-only Deal Folder classification (`src/lib/perspective/access.ts:80-85`), so the shell sends them to the deal home. They never see the Console and Book switch, which lives in `BankHome` and renders only for bank users.
  - The deal-list fields this branch added (current-step run state, per-phase progress) are already withheld from outside callers.
  - The fee and schedule are still in the API response.
  - On develop, `destinationFromPathname` mapped `/book` to `rail`, which outside parties may reach, and the Book page checked only the flag. So a seller or buyer with the URL could load it wherever `book_view` was on.
- **Current behavior:**
  - `GET /api/v1/deals` (`src/app/api/v1/deals/route.ts:137-139`) returns `targetCloseDate`, `feeUsd` and `scheduleStatus` to every member, including seller and buyer seats. The same route returns run state and progress only to internal callers (`internal ? … : null`, lines 70 and 132).
  - The Book page (`src/app/(authed)/projects/[projectId]/book/page.tsx:18`) checks only the `book_view` flag.
  - Found by review hunt-hub-4.
- **Proposed change:**
  - In `GET /api/v1/deals`, and in any single-deal read the Book uses, return `feeUsd` and `scheduleStatus` (and the target close date, if the bank wants) only when the caller is internal. Use the `classifyInternalUser` check the route already makes (line 111).
  - Have the Book page refuse outside users on the server.
  - Related: E20, where outside users with a firm role see every deal.
- **Database and permission impact:** Route logic, using an existing check. No schema change. Security review.
- **Risk if left:** High: the bank's fee and schedule reach buyers and sellers. The fix is low risk. Confirm that no outside-party screen needs the fee.

### E27. [PERMISSION] A director can remove the firm administrator, the CCO and other directors

Kind: Permission. Priority: Fix first. Size: S. Predates the branch: yes (the route has no diff from develop).

- **What we want and why:** People whose access is shown as "Every permission, fixed" cannot be removed by a director. Only a firm administrator can remove a director, a CCO or an administrator, or whoever Storm chooses (Question 20). A director must not be able to suspend the firm's compliance officer or administrator. The screen already tells everyone these people are fixed.
- **What the app does today:** Guard. In Settings › Organization (`/settings?section=organization`), "Remove" on admin, CCO and director rows is offered only to firm administrators. Others see the lock with the reason "Only a firm administrator can remove a director, a compliance officer or an administrator." (`isRemovalProtected`, `src/components/company/CompanyMembersWorkspace.tsx:145-161`). On develop the roster at `src/app/(authed)/companies/[companyId]/members/page.tsx` offered Remove on every row except the viewer's own, whenever the viewer was a firm administrator or that company's director. It did not check the target's `firm_role` or `company_role`. That page now redirects your own company to Settings › Organization.
- **Current behavior:**
  - `DELETE /api/v1/companies/[companyId]/members/[userId]` (`src/app/api/v1/companies/[companyId]/members/[userId]/route.ts:123-184`) checks only "not yourself" (line 131) and `canManageCompanyMembers` (line 134). Its only other refusal is the database's last-director rule (409, line 167).
  - The access PATCH routes do refuse protected people with "Protected company administrators have immutable access" (409; `[userId]/route.ts:85` and `[userId]/access/route.ts:241`). That refusal comes from the database: the RPC raises `protected_access_root` when `app_company_is_access_root` is true for the target (latest definition `supabase/migrations/20260816120000_client_company_access_management.sql:48`). That helper covers a company's directors and firm administrators. It does not cover a CCO.
  - DELETE has no such check.
  - Found by review hunt-people-2 from reading the code. Removal was not run, because removing seeded accounts is forbidden.
- **Proposed change:**
  - In DELETE, refuse with `409 Protected` when the target is a firm administrator, a CCO or a director, unless the caller is a firm administrator, or apply the rule Storm chooses (Question 20).
  - Mirror the PATCH routes' rule (`app_company_is_access_root`), and add the CCO explicitly, because that helper does not include it.
  - Add tests for a director removing each protected role.
- **Database and permission impact:** Authorization logic in one route. If engineers put the check in SQL instead, it is a function change. Security review.
- **Risk if left:** High: a director can suspend the firm's compliance officer or administrator by calling the API. The fix is low risk: it narrows who can remove.

### E38. [PERMISSION] A read-only member can move the deal to the next step

Kind: Permission. Priority: Fix first. Size: S. Predates the branch: yes.

- **What we want and why:** Only seats that can work a step can move the deal past it. An Observer is told "Your seat can't complete or skip this step." The server should agree.
- **What the app does today:** Guard. On the rail (`/projects/{code}/rail`), every "Move to the next step" and Skip button, on catalog steps and on steps the deal added, is disabled for a read-only seat, with that reason (`src/components/rail/StepContract.tsx`, `src/components/rail/CustomStepPanel.tsx:38-44`).
- **Current behavior:** `PATCH /api/v1/deals/[dealId]/progress` (`src/app/api/v1/deals/[dealId]/progress/route.ts:42-50`) needs only deal membership (`userCanAccessDeal`) for a forward move. Only a backward move checks for the deal MD. So a read-only member who calls it directly moves the shared current step for everyone. Found by the Stage 5 rail review.
- **Proposed change:** Refuse forward moves from read-only seats (403, with a plain message), matching the completion routes.
- **Database and permission impact:** Authorization logic in the progress route.
- **Risk if left:** Medium: an Observer can move a live deal's position for the whole team. The fix is low risk.

### E20. [CONFIDENTIALITY] Outside users with a firm role should not see every deal in the firm

Kind: Confidentiality. Priority: Fix first. Size: S. Predates the branch: yes (found during the build).

- **What we want and why:** An outside party (seller, buyer, counsel) only ever sees the deals they are on. This is the walkthrough's permission worry: "I can't have a disgruntled employee come in and… mess something up." Permissions must not be carte blanche.
- **What the app does today:** No change. The deal-list fields the branch added return nothing to outside users, so the branch does not widen the gap.
- **Current behavior:**
  - `listDealsForUser` (`src/lib/api/v1/access.ts:548`, overseer branch at lines 555-563) treats any caller whose `firm_role` is `cco` or `admin` as an overseer. It returns every deal in the firm without checking `users.is_external`.
  - The comment on `listMemberDealSummaries` (`access.ts:580-585`) already notes this.
  - The same overseer branch, also without an `is_external` check, appears in `userCanAccessDeal` (`access.ts:91`) and `userCanUploadToDataroom` (`access.ts:826`).
- **Proposed change:** Require `is_external = false` for the overseer branch, or forbid firm roles on outside users. The second option covers all three functions at once. Add a test.
- **Database and permission impact:** Authorization logic in one predicate, or a constraint if firm roles are forbidden on outside users.
- **Risk if left:** High: cross-deal visibility for any outside user who holds a firm role. The fix is low risk.

### E23. [CONFIDENTIALITY] Document uploads: server-side folder rules and Data Room filing

Kind: Confidentiality. Priority: Fix first. Size: S. Predates the branch: yes (the documents route has no diff from develop).

- **What we want and why:** Outside uploaders can never choose an internal folder. Bank users can file into the Deal Folder from either room. The Deal Folder is internal only ("the client cannot see that tree").
- **What the app does today:** Guard (UI only), at `/projects/{code}/data-room`.
  - Outside viewers no longer see the Deal Folder destination and send no folder fields.
  - The upload form says files go to Client documents, visible to the client and the buyers given access.
  - It hides the form from outside read-only seats, and shows the category on Client documents rows.
  - The folder choice offers only the client-facing folders (`CLIENT_DOCUMENT_FOLDERS`, `src/components/dataroom/DataRoomLive.tsx:187-193`).
- **Current behavior:**
  - `POST /api/v1/deals/[dealId]/documents` (`src/app/api/v1/deals/[dealId]/documents/route.ts:165`) reads `folder` from the form for every uploader (lines 217-224). It does not check whether the uploader is an outside user.
  - The Data Room upload always posts `room=DEAL` (`DataRoomLive.tsx:264`). So a bank user filing under "04. Buyers" there lands in Client documents.
- **Proposed change:** Ignore `folder` from outside uploaders on the server. Let bank users choose the room when they upload from the Data Room.
- **Database and permission impact:** Authorization rule in the upload route. No schema change.
- **Risk if left:** Medium: an outside uploader can file into an internal folder by calling the API. A bank user can file a document into the client-visible room by mistake. The fix is low risk.

### E29. [PERMISSION] A read-only member can be made a step's owner

Kind: Permission. Priority: Fix first. Size: S. Predates the branch: yes (the route diff is comments only).

- **What we want and why:** A step's owner can actually work the step. Assigning a step tells the person "{name} gets a notification that this step is theirs". An Observer then cannot complete or skip it: the server answers 403.
- **What the app does today:** Guard. The Assign dialog shows read-only members as disabled, with "Read only. Cannot own steps." (`src/components/rail/AssignStepDialog.tsx:35`).
- **Current behavior:** The step PATCH (`src/app/api/v1/deals/[dealId]/steps/[stepId]/route.ts`, `assignTo` from line 318) accepts any deal member as assignee (`userCanAccessDeal`, line 327), including read-only seats, and sends `step_assigned` to them. Found by review hunt-rail-11.
- **Proposed change:** Refuse `assignTo` for read-only seats (409, with a plain message). Or, if Storm decides Observers may own steps (Question 21), let them complete the steps they own.
- **Database and permission impact:** Authorization logic in the step route.
- **Risk if left:** Low to medium: steps are assigned to people who cannot finish them, and the rail shows work as owned when it is stuck.

### E30. [COMPLIANCE] Rail templates let anyone with edit rights remove steps every deal needs

Kind: Compliance. Priority: Fix first. Size: S. Predates the branch: yes (`src/app/api/v1/rail-catalog/**` has no diff, and the template trash button had no confirmation on develop either).

- **What we want and why:** Steps every deal needs (Gate 0 and the persistent Origination steps) cannot be removed from a template, just as they cannot be removed from a deal rail. One rule everywhere. A published template could otherwise drop "Codename" or the compliance notification step.
- **What the app does today:** Guard. In Rails configuration (`/rail-templates`), the template editor hides Remove on those rows and shows a lock. It asks for confirmation before any other step removal (`src/app/(authed)/rail-templates/TemplateDetailPanel.tsx:239-240`).
- **Current behavior:** `DELETE /api/v1/rail-catalog/{templateId}/steps/{stepRowId}` (`src/app/api/v1/rail-catalog/[templateId]/steps/[stepRowId]/route.ts:8`) calls the RPC `remove_rail_template_step`. It refuses only the built-in `default` template and the RPC's "last step" and "not on this template" errors. It removes any other step, including Gate 0. Removing Codename succeeded (21 → 20 Origination steps). Found by review hunt-rail-7.
- **Proposed change:** Refuse removal of `PROTECTED_STEP_IDS` (`src/lib/rail/protectedSteps.ts`) and of the persistent Origination steps in the catalog route and in `remove_rail_template_step`.
- **Database and permission impact:** Route or RPC logic.
- **Risk if left:** Medium: a template can drop the compliance notification step, and every deal created from it then starts without it. The fix is low risk.

### E31. [PERMISSION] The invite list and the members list disagree about who can see a deal

Kind: Permission. Priority: Fix first. Size: S. Predates the branch: yes (the invites route has no diff from develop).

- **What we want and why:** One answer per deal. Someone who cannot see a deal's members cannot list or send its invites. Today a director who is not on the Atlas deal sees "Deal not found" on Team, yet the invites list answers 200.
- **What the app does today:** Guard. "Invite to deal" shows only after the roster has loaded, and a roster read that fails (404 or 403) means the viewer cannot invite (`src/components/team/LiveTeamRoster.tsx:362`).
- **Current behavior:** `GET /api/v1/invites?dealId=` (`src/app/api/v1/invites/route.ts:439-496`) answers 200 for a firm director who is not a member. `GET /api/v1/deals/[dealId]/members` answers 404 for the same person. Found by review hunt-people-3.
- **Proposed change:** Use the members route's visibility check in the invites GET. Do the same in POST (`route.ts:92`) if it differs.
- **Database and permission impact:** Authorization logic.
- **Risk if left:** Medium: a director can list pending invites, with outside email addresses, on deals they are not on. Risk of the change: low. Check that the overseer and firm-director flows still list what they should.

---

## Part 1. For engineers

### Rail

#### E1. Save a step reorder (deal rail and rail templates)

Kind: Database. Priority: Next. Size: L. Predates the branch: not applicable (new feature).

- **What we want and why:** Drag a step to a new position, or use a "Move to…" menu, and have the order saved. It works on a live deal rail and on a rail template. From the meeting: "You should probably be able to drag and drop from the rail directly. Absolutely, no question. That's how you really steal from Trello."
- **What the app does today:** Preview. Try it at `/projects/{code}/rail` (people with rail editing rights, in the "All" view) and in a template at `/rail-templates`.
  - "Move to…" (`src/components/rail/MoveStepDialog.tsx`) is the keyboard and screen-reader path, and it names every position. Pointer drag on the board does the same move (`src/components/rail/SortableStack.tsx`, using `@dnd-kit`, a new dependency on this branch).
  - The new order is held in memory for this person and deal. A reload shows the saved order (`src/lib/rail/railPreview.ts`).
  - Steps move within their phase. Completed steps, required steps (`PROTECTED_STEP_IDS`) and steps before the deal's entry point cannot move, and no step can move ahead of one that cannot (`isMovableStep`, `allowedMoveIndices`). So the Preview never shows an order a saved move would refuse.
  - A move asks nothing about the deal. The prompt after a move says "Only you see this order. It is kept in this browser and is not saved to the deal.", with "Keep in this browser" and "Reset" (`src/components/rail/RailEditPrompt.tsx`).
  - Save rail and template Publish say that a Preview order is not included, and that they use the saved order (`src/components/rail/SaveRailDialog.tsx:33-34`, `TemplateDetailPanel.tsx:53-57`).
- **Current behavior:**
  - Order lives in `deal_steps.display_order` (`supabase/migrations/20260916100000_project_rail_model.sql`).
  - Removed rows keep their `display_order` and `anchor_step_id`, and `rail_restore_step` depends on both (latest definition in `20260924100000_rail_restore_first_in_phase.sql`).
  - `rail_insert_step` with `'after'` follows anchor chains (`20260916120000_skill_publication.sql`).
  - `rail_reselect_current` picks the current step by `display_order`.
  - Moving a step to another phase would rewrite `phase_index`.
  - Protected steps are listed in `src/lib/rail/protectedSteps.ts` (`PROTECTED_STEP_IDS`).
  - For templates, `rail_catalog_changes_action_check` allows only `add_step`, `remove_step`, `set_description`, `set_template_description` and `set_step_skill` (latest definition in `20261007100000_save_rail_on_catalog.sql`; first added in `20261002150000_rail_catalog_changes.sql`).
  - Template change review stores `deal_template_change_decisions.kind`, which allows only `added` and `removed` (`20261005200000_template_change_review.sql`).
  - The template manifest needs a contiguous `displayOrder` from 1 to n (checked in `20260921100000_rail_templates.sql`, restated in `20261005100000_rail_catalog_publish.sql` and `20261006100000_catalog_step_skills.sql`).
  - `PATCH /api/v1/rail-catalog/{templateId}/steps/{stepRowId}` is already used for the description edit.
- **Proposed change:**
  - Deal rail: a reorder RPC. Renumber active rows only. Re-anchor the moved row and any rows anchored to it. Block moves of `complete` steps and protected steps. Define what happens when a move crosses the current step, then reselect the current step. Write an audit row in the style of `rail_remove_step`.
  - Templates: add a `move_step` catalog action. Widen the CHECK constraint and restate the full list of five existing actions plus the new one. Add a `moved` kind to template review, or state that reorders do not reach live deals' template review. Our recommendation: they do not, and the UI says so.
  - Pointer drag uses `@dnd-kit` (`package.json`). The "Move to…" menu is the accessible main path.
- **Database and permission impact:** New RPC. CHECK constraint changes on two tables. New audit action. No new permission: it reuses the rail structure permission (see E3).
- **Risk if left:** Moves never save. Anyone who reorders in the Preview loses the order on reload, and "move" proposals (E3) cannot be accepted for real. Risk of the change: medium. Re-anchoring and restore are the fragile parts. Test restore after a reorder, and a reorder with removed rows present.

#### E2. Copy steps from another rail

Kind: Database. Priority: Later (waits on Question 8). Size: M. Predates the branch: not applicable.

- **What we want and why:** Take part of a rail built earlier and add it to this one. From the meeting: "Do I have to make a whole new rail, or can I take part of something I did in that other rail and add it here?"
- **What the app does today:** Nothing. Adding and removing steps work as before.
- **Current behavior:** Steps are added one at a time through `rail_insert_step` (`supabase/migrations/20260916120000_skill_publication.sql`). A saved rail is chosen whole at the start of a deal, or saved through `src/components/rail/SaveRailDialog.tsx`.
- **Proposed change:** A "copy steps from template" RPC that inserts a chosen range at an anchor, with the same anchoring and audit rules as E1. Whether this is allowed is Storm's call (Question 8).
- **Database and permission impact:** New RPC and audit action.
- **Risk if left:** Low. Bankers rebuild steps by hand. Risk of the change: low to medium, because skill links and step ids must be remapped.

#### E3. Per-deal rail edit rights and "Propose a change"

Kind: Permission. Priority: Next (the rule waits on Question 4). Size: L. Predates the branch: not applicable.

- **What we want and why:** Only the right people change a deal's rail, and everyone else can propose a change that a lead accepts. From the meeting: "I can't have a disgruntled employee come in and mess something up." And: "The person who opens the deal has to say yes to major dependency changes."
- **What the app does today:** Preview, at `/projects/{code}/rail` on a real deal.
  - The rail header says who can change the rail: "People with rail editing rights change this rail." It names the right, never a deal role, because the right is company-wide today (`src/components/rail/RailHeader.tsx`).
  - People without rail editing rights get "Propose a change". The "View as deal lead" switch shows how the lead would review the proposal in a "Proposed changes" tray (`src/components/rail/RailProposals.tsx`).
  - Proposals are kept in this browser (localStorage) for this person and deal, and Reset clears them (`src/lib/rail/railPreview.ts`). Nobody is notified. Accept and Discard mark the proposal only and never call the API.
  - Edits keep today's rules.
- **Current behavior:**
  - Edit rights are company-wide, not per deal. `resolveDealStepStructureCapability` (`src/lib/api/v1/access.ts:464`) takes no deal. It checks the company permission `company:deals:steps:structure` (`DEAL_STEPS_STRUCTURE`, `src/lib/constants/companyPermissions.ts:17`). `requireStructureAuthority` (`src/lib/rail/railRouteGuard.ts:10`) uses it. Anyone holding it can edit any deal they are on.
  - For bank users, only the deal MD can assign a step (`resolveDealStepCapabilities`, `access.ts:405`).
  - `deals.mandate_owner_id` exists (`supabase/migrations/20260604100000_permissions_schema.sql:77`). No rail route checks it for edit rights. The step PATCH reads it only to notify the mandate owner when a step completes.
  - No notification type fits a change request. `access_requested` is about access (`src/lib/constants/notifications.ts:16`).
- **Proposed change:**
  - A `rail_change_proposals` table with RPCs to propose, accept and discard. Audit actions for each. One new notification type.
  - A per-deal host authority (the mandate owner or the deal MD) that sits beside the company-wide permission. The host can accept. The company-wide permission stays as the outer limit.
  - An organization setting for who may propose and who may approve (Question 4).
  - Enforce the host check in `railRouteGuard.ts`.
- **Database and permission impact:** New table with RLS. New RPCs. A new `event_type` needs a CHECK migration, an update to `src/lib/constants/notifications.ts`, and an update to `tests/constants-schema-sync.test.ts`. This is an authorization change, so it needs a security review.
- **Risk if left:** Anyone with the company-wide right can change any deal's rail they are on, and nobody else has a way to ask for a change. Risk of the change: high, because it changes who can do what on live deals. Roll it out behind a flag and test with existing roles.

#### E4. Step dependencies, per-step dates and "started" facts

Kind: Database. Priority: Next (enforcement waits on Questions 1 to 3). Size: L. Predates the branch: not applicable.

- **What we want and why:** Show which steps wait on others, give steps target and drop-dead dates, and record who started a step. From the meeting: "I would love to see a branch that goes, I can't even look at step 35 until step 11 is done." And: "The actual rules behind that also require an understanding of the deal."
- **What the app does today:** Preview, at `/projects/{code}/rail` on a real deal, under the "Dependencies" layout (`src/components/rail/RailDependencyView.tsx`).
  - People draw links between steps and mark each one Hard or Soft. "Waiting on" shows only for a drawn link whose earlier step is not done. Nothing is inferred from the step briefs' "Seq NN" references.
  - Steps take a target date and a drop-dead date. The soonest one shows in the rail header beside the deal's real target close.
  - Links and dates are kept in this browser (localStorage) per person and deal, and Reset clears them (`src/lib/rail/railPreview.ts`). Nothing is enforced, and nothing reaches the deal.
  - The Conductor Center's "Due today" uses deal-level dates only, because per-step deadlines need stored step dates (`src/components/workspace/commandCenter/DueToday.tsx`, `src/lib/deals/commandCenter.ts`).
- **Current behavior:**
  - There are no dependency records.
  - Only one step is `current`. That marks the deal's position, not who is working.
  - Finishing a later step out of order is allowed and does not move the position (`supabase/migrations/20261001100000_deal_step_save.sql`).
  - 26 of the 65 steps in `src/lib/rail/railData.generated.ts` cite "Seq NN". These are source references, not gates: some point forward, steps skipped on entry would wait forever, and real gates are often per buyer.
  - Dates exist only at deal level (`deals.target_close_date`).
  - "Started" is not stored. Assignment is not the same as starting.
- **Proposed change:**
  - `deal_step_dependencies`: from step, to step, kind (hard or soft), source (template or deal), `created_by`. Carried in rail templates. Enforcement in `deal_step_save` follows Storm's answers (Questions 1 to 3).
  - `due_at` and `drop_dead_at` on deal steps, with new notification types for approaching dates.
  - Explicit `started_at` and `started_by`, with `current` kept as the deal's position.
- **Database and permission impact:** New table, new columns, a template manifest change, notification enum widenings (all in one migration), and RLS for the new table.
- **Risk if left:** The team cannot see what blocks what, and dates live only on the deal. Risk of the change: high if enforced, low if soft warnings only. The wrong rule blocks real deals. Do not infer links from "Seq NN".

#### E5. Live presence and pushed updates on the rail

Kind: Permission. Priority: Later. Size: M. Predates the branch: not applicable.

- **What we want and why:** See that a teammate is on the rail, and see their changes without a refresh. From the meeting: "Player 1 is over in step 5 working on something. It's okay."
- **What the app does today:** Partial. `useRailFreshness` (`src/lib/rail/useRailFreshness.ts`) re-reads the rail when the tab regains focus or becomes visible, and every 30 seconds (`RAIL_POLL_MS`) while it is visible. A hidden tab never polls. So two browsers on `/projects/{code}/rail` feel live. It does not show presence.
- **Current behavior:** The app subscribes to no Realtime channel. Realtime is on in the local stack (`supabase/config.toml`), but nothing uses it. Decision D27 deferred Realtime (for flag reads), and no later decision adopted it (`docs/07-decisions/decision-log.md`).
- **Proposed change:** A private Realtime channel `deal:{uuid}:rail`, allowed by a `realtime.messages` policy that calls `app_is_deal_member`. Payloads carry ids only, never names or step text. Change events can come through `postgres_changes` on `deal_steps`, which existing RLS already covers.
- **Database and permission impact:** New `realtime.messages` policies. This is a permission change. Do not use public channels: anyone with the publishable key who knew the channel name could see activity on a deal with inside information.
- **Risk if left:** Low. Changes appear within 30 seconds or on focus, and structure changes by teammates (add, remove, restore, skip) appear on the next rail read. Risk of the change: high if done wrong, because it leaks deal activity. Medium otherwise.

#### E9. Compliance rules inside the skill-authoring and catalog prompts

Kind: Product decision. Priority: Later. Size: M. Predates the branch: not applicable.

- **What we want and why:** Language rules for inside information and promissory wording are part of the original skill prompt, so users never need "clean voice" or "remove compliance language" options. From the meeting: "This should have already been taken into account when it drafted the teaser."
- **What the app does today:** Nothing new. The compliance screen on outputs stays the guarantee in this repo.
- **Current behavior:** The authoring conversation posts to the Ignatious service at `/v1/bench/authoring/turns` (`TURN_PATH`, `src/lib/skillAuthoring/ignatiousAuthoring.ts:39`). The request has no system or rules field, and the candidate preview has no constraints field. The prompts live in the agents backend, not in this repo.
- **Proposed change:** In the agents backend, add the rules to the authoring prompt and to catalog prompts such as the teaser. If compliance should be able to edit the rules, add a rules field to the turn request here.
- **Database and permission impact:** None in this repo's database. Needs an agents backend change and an API contract change.
- **Risk if left:** Drafts keep needing compliance fixes after the fact. Risk of the change: medium, because rule changes alter drafts people already approved.

#### E10. Whole-output revision ("What should change?")

Kind: Product decision. Priority: Later. Size: S. Predates the branch: not applicable.

- **What we want and why:** Type a free-text change and get a new version of the whole output. From the meeting: "The drafting of the second version needs a free text box. Here are some examples of what you can do with it."
- **What the app does today:** Works, and saves; it is not a Preview. In a draft's review on the rail, "What should change?" sends one comment that spans the first passage's start to the last passage's end, through the existing revisions endpoint, and records the next version (`reviseWhole`, `src/components/rail/review/useRunRevisions.ts:190`; `RunOutput.tsx:95`). It revises this output only and never teaches the skill (Question 10).
- **Current behavior:**
  - `POST /api/v1/deals/{dealId}/steps/{stepId}/skill-runs/{runId}/revisions` takes `{parentId, edits:[{kind:'comment', start, end, comment}]}`. It checks the ranges with `validateEdits` (`src/lib/skillRun/revisions.ts:86`) and applies them with `applyCommentBatch` (`src/lib/skillRun/applyRevision.ts:432`).
  - `validateEdits` takes only ranges that cover whole passages. A literal `0..length` range is refused whenever the output starts or ends with blank space. So the client computes the span from the passages (`wholeOutputRange`, `src/components/rail/review/wholeOutput.ts`).
  - The stream route takes `instructions` but no basis, so it re-runs from scratch.
  - The passage composer is `src/components/rail/review/EditComposer.tsx`.
- **Proposed change:** Nothing is required for today's flow. If engineers want an instruction that is not tied to passage boundaries, add a small `kind: 'instruction'` edit that applies to the whole output.
- **Database and permission impact:** None to the database if the edit kind is only checked in code. A new stored edit kind would be a schema change.
- **Risk if left:** Low. The box works through the passage-comment path.

#### E15. Saved views: per user or shared with the deal

Kind: Database. Priority: Later. Size: S to M. Predates the branch: not applicable.

- **What we want and why:** Filters such as All, Mine and Unassigned that stay when you come back. From the meeting: "Let people work through it just like a Trello board."
- **What the app does today:** Preview, at `/projects/{code}/rail` on a real deal. The views are All, Mine, Unassigned and Has activity. The choice is stored in this browser (`railViewFilter` local preference, `src/components/rail/DealRail.tsx:509-516`) with the note "Only you see this view." (`src/components/rail/RailViewFilter.tsx:82`).
- **Current behavior:** View choices are in localStorage only. Another example is the Book and Console choice in `src/components/book/BankHome.tsx`.
- **Proposed change:** A saved views table with an owner and a scope (personal or shared with the deal). Personal views follow the person across devices. Shared views need the host rule from E3.
- **Database and permission impact:** New table and RLS.
- **Risk if left:** Low. Views reset on another device.

#### E19. Record agent run state so the Conductor Center can show running work

Kind: Database (writes an existing column). Priority: Next. Size: S. Predates the branch: not applicable (found during the build).

- **What we want and why:** The Conductor Center's "Running" list shows deals where Conductia is actively drafting. From the meeting: "I want to actually know what's going on… I don't see anything [in motion]."
- **What the app does today:** Partial. The Conductor Center (`/projects`) reads `deal_steps.bench_run_status` through the deal list (read-only, bank users only) and shows Running only when a step is running. Nothing writes that column today, so the section stays hidden (`src/components/workspace/commandCenter/Running.tsx:62`, `src/lib/deals/commandCenter.ts:16`).
- **Current behavior:**
  - `src/lib/constants/dealSteps.ts:47-51` defines the values `running`, `complete` and `failed` (`BENCH_RUN_STATUS`). They mirror the CHECK on `deal_steps.bench_run_status` in `supabase/migrations/20260903130000_deal_step_bench_session.sql`.
  - The step PATCH accepts `benchSession` (`src/app/api/v1/deals/[dealId]/steps/[stepId]/route.ts:357`), but no caller sends it. `SkillStepRunner` sends only `work` (`src/components/rail/SkillStepRunner.tsx:327`).
  - `deal_step_skill_runs` has no status column.
- **Proposed change:** Set `bench_run_status` when a skill run starts and ends, using the existing values (`running`, then `complete` or `failed`). A `queued` state would be an enum widening.
- **Database and permission impact:** Writes to an existing column. No schema or permission change, unless a new value is added.
- **Risk if left:** Low. The Conductor Center never shows work in motion.

#### E22. Last activity per step without the 500-row audit cap

Kind: API read. Priority: Next. Size: S. Predates the branch: not applicable (found during the build).

- **What we want and why:** Every step card says who last worked on it and when, however old. This is multiplayer visibility: "everyone can see that those tasks are being picked up".
- **What the app does today:** Partial. The rail reads the newest 500 audit rows once per load and shows "Draft saved by …" for steps found there (`src/lib/rail/stepActivity.ts`). The "Has activity" view notes "Older activity may not show." (`src/components/rail/RailViewFilter.tsx`).
- **Current behavior:**
  - `GET /api/v1/deals/{id}/audit` is capped at 500 rows. `GET /api/v1/deals/{id}/step-records` carries no last-activity fields.
  - The step PATCH writes no audit row when a step is unassigned (`src/app/api/v1/deals/[dealId]/steps/[stepId]/route.ts:321-324`). So activity history cannot show unassignments.
  - Structure changes by teammates (add, remove, restore, skip) appear only on the next rail read. See E5.
- **Proposed change:** Add read-only `lastWorkAt` and `lastWorkBy` to step-records: the latest step work, assignment or completion per step. Write an audit row on unassign.
- **Database and permission impact:** Read-only query with the same scoping. The unassign audit row reuses an existing action or adds one (an audit action CHECK change).
- **Risk if left:** Low. Older activity is missing from step cards.

#### E28. "Mark complete" on a skill-backed step only moves the current step

Kind: Database (RPC change). Priority: Next. Size: S to M. Predates the branch: yes (on develop, `DealRail.tsx:350-391` had the same path, with the comment "The bare 'Mark complete' buttons never reach the step row"; `progress/route.ts` has no diff).

- **What we want and why:** Completing a step records it as done, whether it is a manual step or a skill-backed one. "Mark complete still completes a step" was a Keep item. Activity and the audit trail must show who completed what.
- **What the app does today:** Guard (relabel). On skill-backed steps the button reads "Move to the next step", with the line "This moves the deal's current step. It does not record this step as done." Manual steps keep "Mark step complete", which does record completion (`src/components/rail/stepActionCopy.ts:54-58`, `StepZoom.tsx:168`, `StepContract.tsx:541`, `CustomStepPanel.tsx:79`).
- **Current behavior:**
  - The bare button calls `PATCH /api/v1/deals/{id}/progress`, which runs `deal_move_cursor` (`src/app/api/v1/deals/[dealId]/progress/route.ts:64`). It writes the deal's position and a move audit row only.
  - The step row is never set to complete, and no completion audit row is written.
  - After moving past a skill-backed step and completing the next step by hand, a reload showed two steps with status `current` (`p1-s9` and `p1-s12`). The header count also leaves out the step that was moved past.
  - Found by review hunt-cross-4.
- **Proposed change:** Let the advance path complete the step through `deal_step_save`, as manual steps do, so one transaction records completion and picks the current step. Fix `deal_move_cursor` so it never leaves two `current` rows.
- **Database and permission impact:** RPC change (`deal_move_cursor`), or a client change to call the step PATCH plus a server check. The existing completion permission applies.
- **Risk if left:** Medium. Skill-backed steps never show as done, the audit trail has no completion record, and a rail can show two current steps. Risk of the change: medium. Test the current step with skipped, removed and pre-entry steps.

#### E32. Who opened the deal: a creator name the rail can show

Kind: API read. Priority: Next. Size: S. Predates the branch: partly (the viewer fallback existed on develop at `RailTimeline.tsx:270`, and the new board kept it until the fix).

- **What we want and why:** The Gate 0 steps (Codename, Notify Compliance) credit the person who actually did them. This is a compliance fact. It must be the same for every viewer.
- **What the app does today:** Guard. The rail shows "On record" when no creator is known. It no longer falls back to the viewer's own name, which made the line differ on every screen (`src/components/rail/RailBoard.tsx:241`).
- **Current behavior:**
  - The rail's deal record has no creator from the API. `creatorNameForDeal` (`src/lib/rail/stepRecords.ts:86`) now reads only `deal.createdBy`, which only fixture and wizard-created deals carry, and otherwise returns "On record". On develop it used the signed-in user.
  - `deals.mandate_owner_id` exists, and the deal's create audit row has the actor, but neither reaches the rail.
  - Found by reviews hunt-rail-1 and verify-hubrail-2.
- **Proposed change:** An additive read-only field on the rail or step-records read: the creator's display name, from the create audit row or `mandate_owner_id`, with the same scoping.
- **Database and permission impact:** Read-only field. No permission change.
- **Risk if left:** Low. Gate 0 credits read "On record" on real deals.

#### E39. Deal-scoped teaser brief

Kind: API read. Priority: Later. Size: M. Predates the branch: yes.

- **What we want and why:** The step's sample teaser is written from this deal's own data. The sandbox teaser runner drafts from sample text, so it cannot show what the real draft for this deal would say.
- **What the app does today:** Preview. The teaser runner on the rail shows the banner "Sample draft. Not written from this deal's data." Its compliance screen says "Screen of this sample text. The deal's compliance status is unchanged." and never sets the deal's compliance status (`src/components/rail/TeaserRunner.tsx:97-98`, `:251-254`).
- **Current behavior:** `src/components/rail/TeaserRunner.tsx` runs on fixed sample input. No deal data reaches it.
- **Proposed change:** Pass the deal's brief fields (sector, size, codename, never the seller's name) to the teaser skill run, and let its screen set the deal's compliance status.
- **Database and permission impact:** None for the read. The compliance-status write goes through the existing screen path.
- **Risk if left:** Low. The teaser stays a sample. Risk of the change: medium. Inside information goes into prompts, and the blind teaser must never name the seller.

#### E40. The step PATCH returns the owner's id without their name

Kind: API read. Priority: Next. Size: XS. Predates the branch: yes.

- **What we want and why:** One step shape from every steps route, so screens never have to fill gaps. After an assign, the screen briefly had an owner id and no name, and showed "Unassigned".
- **What the app does today:** Guard. The Assign dialog names the owner from the deal team it already read. If the name is still missing, the step is read again.
- **Current behavior:** `PATCH /api/v1/deals/{dealId}/steps/{stepId}` (`src/app/api/v1/deals/[dealId]/steps/[stepId]/route.ts:563`) returns the saved step through `serializeStep` with no assignee, so `assignedTo` is set and `assignedToName` is `null`. The GET returns the name.
- **Proposed change:** Return `assignedToName` from the PATCH too.
- **Database and permission impact:** None. An additive read in the route's response.
- **Risk if left:** Low. Every screen that assigns must work around it.

#### E42. Rail zoom: one extra Back after a reload

Kind: Code only. Priority: Later. Size: S. Predates the branch: not applicable (the zoom history is new on this branch).

- **What we want and why:** Browser Back and Forward move between the board and a zoomed step, with no dead Back presses (S6-01, RAIL-02).
- **What the app does today:** Zooming in pushes one `?step=` entry with a marker in `history.state`. Back zooms out and Forward zooms back in (`src/components/rail/zoomHistory.ts`). After a reload on a zoomed step, or after Back from another page onto one, the rail turns that entry into a plain board entry. History then holds two identical board entries, so the first Back press shows the same board.
- **Current behavior:** Client only. No server part.
- **Proposed change:** Restore the zoom from `history.state` on load instead of flattening it. This needs a marker that is safe in development mode, and a way to tell a reload from a history move that does not rely on `performance.navigation`.
- **Database and permission impact:** None.
- **Risk if left:** Low. One extra Back press in that case.

#### E44. A locked step control can show the wrong reason while its data catches up

Kind: Code only. Priority: Later. Size: S. Predates the branch: yes for Mark step complete; Skip shares it since S6R5-03.

- **What we want and why:** Every locked control says why it is locked, truthfully (UX matrix 8.6).
- **What the app does today:** Works in the normal case. On a colleague's step, Save progress, Mark step complete and Skip are locked with "Assigned to {name}. Only they, the MD or a firm administrator can save progress." or "Your seat can't complete or skip this step."
- **Current behavior:** `src/components/rail/ManualStepPanel.tsx:96-103` picks the shared reason by the step row's status, not by the cause. If the step read returns a status other than `current` for the rail's current step (a lagging read, or a cursor moved without a row write), a director or CCO sees "Complete the current step first." on the step that is current.
- **Proposed change:** Choose the reason by cause: the seat's reason when the viewer is neither the MD nor the assignee, otherwise "Complete the current step first." This needs `isMd` and the assignee id from the panel's existing read.
- **Database and permission impact:** None. The server already refuses the same actions.
- **Risk if left:** Low. A wrong reason line in a rare timing case.

Also for the rail: E30 (template step removal) and E38 (read-only seats moving the deal) are under Fix first, and E37 (firm-editable default rail) is under Platform and tooling.

### People and roles

#### E6. CCO and Admin role model and the invite hierarchy

Kind: Permission. Priority: Later (waits on Question 5). Size: M. Predates the branch: not applicable.

- **What we want and why:** Make it clear who can be invited as what, and how a CCO or Admin is set up. From the meeting: "You can invite someone and then it only gives you member or director. So how did the chief compliance officer and admin role even get on here?"
- **What the app does today:** Guard (copy and options only). The invite dialog in Settings › Organization offers only the roles the server grants: Member, plus Director for a firm administrator or that company's director; outside parties invite employees only. It explains: "Chief Compliance Officer and Administrator are set by Conductia when your firm is set up, not by invitation. To change one, contact Conductia." (`src/components/company/InviteMemberDialog.tsx:32-50`). Locked controls show the reason.
- **Current behavior:**
  - `firm_role = 'admin'` is the Conductia platform superuser, not a bank-level admin.
  - `POST /api/v1/companies/onboard` is firm-admin only (`scripts/bootstrap-firm-admin.ts`).
  - In `src/app/api/v1/invites/route.ts` (about lines 157 to 183), a firm admin is never treated as an outside inviter (`actorIsExternal`, lines 162-163), so it skips the outside-party and company limits.
  - `app_is_overseer` gives both `cco` and `admin` overseer reads (`supabase/migrations/20260930180000_rls_helper_caller_guard.sql:38-41`).
  - CCO and admin are firm roles, not deal roles. Company roles are director and member only (decisions D33, D42 and D47).
- **Proposed change:** Decide the hierarchy first (Question 5). If a bank-level CCO assignment is wanted: CCO only, same company, approved by a director, never `admin`, in its own migration and PR. Never let the UI grant `admin`.
- **Database and permission impact:** New assignment RPC and invite rules. Security review required.
- **Risk if left:** Low: CCO and Admin stay set by Conductia staff. Risk of the change: high. A firm admin granting "admin" would be privilege escalation across firms, and the UI must not offer it.

#### E8. Save the profile photo and title

Kind: Database. Priority: Next. Size: S to M. Predates the branch: not applicable.

- **What we want and why:** A photo and a title that stay, and that show in the Team list and on deal pages. From the meeting: "If you want to put a photo on, just click on the circle up there."
- **What the app does today:** Preview, at `/settings?section=profile`.
  - Click the circle to change the photo. The photo is kept in this browser per user, so the next person on a shared browser does not see it. A photo too large for the browser says so (`src/lib/auth/useProfilePhoto.ts`).
  - The title is a Preview kept in this browser per user, with Reset (`src/app/(authed)/profile/profileTitlePreview.ts`, `ProfileView.tsx:138` and `:326`).
  - Nobody else sees either.
- **Current behavior:** No photo or title is stored on the account. Team and rail cards show initials.
- **Proposed change:** A storage bucket with an own-row write policy, a photo path on the user profile, a read route for deal members, and a size and type limit. Add a `title` field on the user profile, editable by its owner, beside the photo path.
- **Database and permission impact:** Two new columns (photo path and title, own-row write), a storage bucket and its policies.
- **Risk if left:** Low. Photos and titles are lost when the person changes browser. Check that a photo is visible only to people who share a deal or company.

#### E41. Team shows the deal seat, not the organization role

Kind: API read. Priority: Later. Size: S. Predates the branch: not applicable.

- **What we want and why:** Profile, the avatar menu and Team agree on a person's role (S6-10, PROF-06).
- **What the app does today:** Profile and the avatar menu show the organization role from `/me` (`organizationRoleLabel`, `src/lib/auth/useCurrentUser.ts`). Team shows the person's seat on this deal (`deal_role`, for example "Managing Director"). These are different facts, and each is labeled as such.
- **Current behavior:** `GET /api/v1/deals/{id}/members` selects `company_role` but not `firm_role` (`src/app/api/v1/deals/[dealId]/members/route.ts:80`). So Team cannot show the organization role without guessing: an admin or CCO would read "Member".
- **Proposed change:** Add a read-only `firm_role` to each member in that response, then let Team show it beside the deal seat. Changing a role stays with E6.
- **Database and permission impact:** None for reading. It shows a colleague's firm role to deal members, which is a visibility decision. Apply it to bank viewers only until E25 is fixed.
- **Risk if left:** Low. Team and Profile describe different facts.

Also for people and roles: E25, E27, E29 and E31 are under Fix first, and E34 (sign-out) is under Platform and tooling.

### Mail and discovery

#### E7. Signature storage and import from Gmail or Outlook

Kind: Database. Priority: Later. Size: M. Predates the branch: not applicable.

- **What we want and why:** A banker's email signature appears on mail sent from Conductia, imported from their own mail client. From the meeting: "You might need to be able to add a signature. Probably important. Or you import your signature somehow."
- **What the app does today:** Preview, at `/settings?section=mail`, in the Signature card. "Import from Gmail" and "Import from Outlook" explain that importing needs permission to read mailbox settings. Pressing one says nothing was imported and nothing was read or saved. There is no signature editor on purpose: the signature stays in the banker's own mail client (`src/components/mail/MailSettingsSection.tsx:19-56`).
- **Current behavior:** No signature is stored. Gmail reading uses `gmail.readonly` (`src/lib/constants/googleReader.ts:14`, ADR-0022). The Outlook reader does not send (ADR-0021). Gmail sending uses `gmail.send` only (ADR-0025), and Microsoft sending uses `Mail.Send` (`src/lib/email/graph.ts`). None of these can read a signature setting.
- **Proposed change:** A signature table with its own route and own-row RLS. Do not add it as a column on `users`: colleagues can read that table. Import needs wider scopes: Gmail settings read for the signature, and the equivalent Graph permission. Both need a new ADR and a consent update.
- **Database and permission impact:** New table and RLS. New OAuth scopes and re-consent for connected users. Changes to the [Google Workspace reader admin guide](google-workspace-reader-admin-guide.md), which says the reader takes exactly one scope.
- **Risk if left:** Low. Mail from Conductia has no signature. Risk of the change: medium. Widening scopes costs trust and a new verification with Google.

#### E11. Returned-draft audit row (Storm's call)

Kind: Product decision. Priority: Later (waits on Question 9). Size: S. Predates the branch: not applicable.

- **What we want and why:** Decide whether a draft that is stopped before sending leaves any trace. From the meeting: "If you override the AI, you might actually get yourself in trouble if we keep that in the audit trail." And: "It takes liability off Conductia."
- **What the app does today:** Guard (display only). The Audit Trail (`/projects/{code}/audit`) shows a Person column and plain labels for overrides, such as "Sent despite a compliance flag" and "Flagged at screening, sent anyway" (`src/components/audit/AuditTrail.tsx:364`).
- **Current behavior:** Decision D80: there is no record of an unsent or abandoned email, not even a count. The returned-send audit row is pending Storm. The sent email and any overridden warnings are kept (email decision Q1 = A, D85). `externalConfirmed` is asserted by the client and is not evidence (D105). See the [decision log](../07-decisions/decision-log.md).
- **Proposed change:** Pending Question 9. Two shapes are possible: no row (today), or a row that records only the warning that was overridden, never the text.
- **Database and permission impact:** A new audit action if a row is wanted.
- **Risk if left:** Medium. It is a legal and liability call, not a technical one.

#### E12. Discovery scanning scope and cost

Kind: Product decision. Priority: Next (waits on Question 6). Size: M. Predates the branch: not applicable.

- **What we want and why:** A clear, agreed answer on how much of a person's mail Conductia reads, how often, and what it costs. From the meeting: "We're only scanning at onboarding, at least for now... We need to double-check on what that scope is." And: "Just run a weekly sync, but we probably want to be really careful about downloading too much."
- **What the app does today:** No change to scanning. The Mail settings consent card says "You're connected. Conductia reads your mailbox each time it checks for new deals." (`src/components/mail/MailboxConsentCard.tsx:54`).
- **Current behavior:**
  - Scanning is continuous, not onboarding only. The worker reads in passes about every five minutes, with incremental sync. Consent is checked before every page.
  - Gmail's first read defaults to 90 days (`BACKFILL_WINDOW_DEFAULT_DAYS`, `src/lib/constants/discovery.ts:88`). A firm admin may set 0 to 730 days (`BACKFILL_WINDOW_MAX_DAYS`, line 93), only before the first read. The CCO can view it but not change it (decision D97).
  - The Microsoft (Graph) reader does not honor the window yet, so a Microsoft mailbox's first read takes every folder whole (`src/lib/graph/reader/mail.ts:83`).
  - The Microsoft reader skips these well-known folders: deleted items, junk, drafts, outbox and recoverable items (`EXCLUDED_WELL_KNOWN_FOLDERS`, `src/lib/graph/reader/mail.ts:36`).
  - Attachments are never kept: Gmail parses and discards them, and Microsoft only records that they exist (ADR-0022 section 6, ADR-0021 section 4).
  - Only messages routed to a deal are stored, top of message only, visible to the owner only. Ending consent purges stored mail (D93).
  - Model cost is capped by `discovery_extract_budget` (`src/lib/discovery/extract/estimate.ts:132`).
- **Proposed change:** Option A: keep continuous scanning and write it down plainly for users. Option B: add a weekly sync mode as a setting. Option C: scan once at onboarding, then on demand. Whichever is chosen, make the Graph reader honor the window. See Question 6.
- **Database and permission impact:** A sync cadence setting needs a column or settings row. Consent copy changes. No new scopes.
- **Risk if left:** Medium. The meeting's belief ("only at onboarding") does not match the system, which matters for consent language and cost.

Also for mail: E24 (outside mail without a deal) is under Fix first.

### Documents

E23 (document uploads and Data Room filing) is under Fix first, and E16 (a data room for buyers) is under Not now. There are no other document entries.

### Conductor Center and Book

#### E14. Cross-deal progress for the Book

Kind: API read. Priority: Next. Size: S to M. Predates the branch: not applicable.

- **What we want and why:** One call that returns phase, percent done, current step, owners and target date for every deal an MD has (10 to 30 deals). From the meeting: "We need a demo account that has more projects, so we can really visualize a more complex Conductor Center."
- **What the app does today:** Partial. The Conductor Center (`/projects`) and the Book build their views from `GET /api/v1/deals`, which this branch extended with additive read-only fields. A local-only seed script fills a demo book (`scripts/seed-demo-book.ts`).
- **Current behavior:**
  - `GET /api/v1/deals` (`src/app/api/v1/deals/route.ts`) now returns, per deal: the current step and its assignee (every caller); the current step's run state and per-phase progress (bank users only, lines 70 and 132); and the deal's target close date.
  - Per-phase progress is counted in the route (`phaseProgressOf`, using `src/lib/rail/progressCount.ts`) from every step row of every deal. The list read embeds those rows (`DEAL_LIST_SELECT`, `src/lib/api/v1/access.ts:528-532`).
  - Owners come back for the current step only.
  - The route reads the caller's profile twice per request: once in `listDealsForUser` for the access check, and once in `classifyInternalUser` for the added fields.
- **Proposed change:** An aggregate read that counts `deal_steps` by status and phase in one query, plus the assignees on the current step, so the route no longer pulls every step row. Combine the two profile reads. Additive and read-only.
- **Database and permission impact:** A new read route or view. No new permission, but RLS must apply to each row.
- **Risk if left:** Low. Watch query cost at 50 deals: each deal embeds about 65 step rows today.

#### E21. Real tasks for the Book's deal console

Kind: Database. Priority: Later. Size: M. Predates the branch: not applicable (found during the build).

- **What we want and why:** The Book deal page's task list shows real work, not sample rows. From the meeting: "Do I actually have a grasp on what I need to do and what's going on… if I have 10 projects going on?"
- **What the app does today:** Preview, at `/projects/{code}/book`. The console shows sample tasks under the Preview banner "Sample tasks. These are not this deal's work yet." (`CONSOLE_SAMPLE_MESSAGE`, `src/components/book/BookDeal.tsx:52`, `:573`). The rows are not tied to the deal's real step. Outside parties are sent away from the Book (see E26).
- **Current behavior:** Fixture data only (`src/lib/mock/consoleTasks.ts`, read through `consoleTasks` in `src/lib/book/dealStatus.ts:84`). No task model exists.
- **Proposed change:** Back the console with real step assignments and due dates (see E4), or remove it.
- **Database and permission impact:** Depends on the task model chosen. None if it reuses `deal_steps`.
- **Risk if left:** Low. The console stays a sample.

Also for the Conductor Center: E19 (run state) is under Rail, and E26 (fee and schedule) is under Fix first.

### Notifications

#### E13. Notifications refresh model

Kind: API read. Priority: Later. Size: S to M. Predates the branch: not applicable.

- **What we want and why:** Count badges on the nav items they belong to, kept current. From the meeting: "Notifications: a badge with a count on the nav icons, the Apple standard."
- **What the app does today:** Partial. The nav shows unread count badges. The bell and every badge read one shared feed per tab (`src/lib/notifications/useNotifications.ts`). The feed refetches when the tab regains focus or becomes visible, at most once every 30 seconds (`VISIBILITY_RELOAD_MIN_MS`, from develop's G-04 work). Opening the bell, and Try again on a failed read, always force a fresh read.
- **Current behavior:**
  - The feed is `GET /api/v1/notifications`. It is read on load and after mark-read. It is also read on focus or visibility, throttled to one read per 30 seconds, and on bell open and Try again, unthrottled. There is no polling and no push.
  - Badges are counted in the browser from the whole feed. `NOTIFICATION_DESTINATION` (`src/lib/notifications/navBadges.ts:16-32`) maps each notification type to Mail, Team, Rails or Settings. Types not listed, such as `deal_created` and `expense_approved`, badge nothing.
- **Proposed change:** Decide push (Realtime, see E5) or polling. Add an `area` or equivalent mapping for each notification type on the server, so badges can be counted per nav item. Add a cheap count endpoint.
- **Database and permission impact:** A count route is additive. A new area column or mapping table is a schema change. Push shares E5's policy work.
- **Risk if left:** Low. Badges go stale while a tab stays in front. Risk of the change: low for polling, medium for push.

#### E33. Notification links store the deal's UUID instead of its code

Kind: Code only. Priority: Next. Size: S. Predates the branch: yes (the file has no diff).

- **What we want and why:** Every notification link opens the deal by its code (`/projects/EMBER-2026-751/...`), as the rest of the app does. The project lives in the URL, and the URL segment is the deal code (D38). On a UUID URL the deal switcher shows the raw UUID.
- **What the app does today:** Guard. The client now recognizes a UUID segment (`src/lib/deals/useDeals.ts:135`). The bell and the badges rewrite a UUID link to the code when the notification carries the code (`storedHrefWithDealCode`, `src/lib/notifications/navBadges.ts:58-80`). The stored link is unchanged.
- **Current behavior:** `src/lib/notifications/mailReviewNotifications.ts:52` writes `href: /projects/${opts.dealId}/mail?folder=held` with the deal UUID. The bell and the Mail badge use that link first. No other notification writer in `src/lib/notifications/` builds a `/projects/` link from the UUID. Found by reviews hunt-hub-2 and hunt-people-6.
- **Proposed change:** Write the deal code into `href` when creating the notification.
- **Database and permission impact:** None to the schema. It changes the content written to `notifications`.
- **Risk if left:** Low. Old rows keep UUID links, which the client now handles.

#### E45. The refused team inbox notice has no nav badge

Kind: Product decision. Priority: Later. Size: XS. Predates the branch: no (develop added the notice in G-04).

- **What we want and why:** Count badges sit on the nav item each notification belongs to (PROF-09).
- **What the app does today:** Partial. The bell lists `team_mailbox_refused` ("Team inbox failed the address check") for the firm's admin and CCO and opens `/discovery`, but no nav badge counts it.
- **Current behavior:** `NOTIFICATION_DESTINATION` (`src/lib/notifications/navBadges.ts`) maps no area for this type, and `tests/foundation-slots.test.tsx:46-47` lists it as knowingly unbadged, because Discovery has no badge slot.
- **Proposed change:** Decide whether Discovery gets a badge slot, or whether this notice should badge Settings, where the team inbox cards live. Then map it and take it off the unbadged list.
- **Database and permission impact:** None.
- **Risk if left:** Low. The notice is still in the bell.

### Platform and tooling

#### E34. Sign-out signs the person out on every device

Kind: Product decision. Priority: Later (waits on Question 22). Size: S. Predates the branch: yes (the global scope does).

- **What we want and why:** A decision on whether "Sign out" ends this browser's session only, or every session the person has. Signing out on a phone also signed the person out on their laptop, and the testers saw this during review.
- **What the app does today:** A failed sign-out now says "Could not sign out. Try again." instead of showing the sign-in page while the session survives. Before, auth-js returned `{ error }` and the code ignored it. The scope is unchanged.
- **Current behavior:** `src/lib/auth/useSignOut.ts:30` calls `supabase.auth.signOut()` with the default global scope, which ends the user's sessions in every browser.
- **Proposed change:** Default to `{ scope: 'local' }`, and offer "Sign out everywhere" in Settings › Profile. Or keep global scope and say so on the button.
- **Database and permission impact:** None. It is a session policy.
- **Risk if left:** Low. People are signed out of every device without warning.

#### E35. Rail data generator and committed rail data have drifted

Kind: Code only. Priority: Later. Size: S. Predates the branch: yes (already true at `ead2bd98`, before this branch's sweep).

- **What we want and why:** Regenerating `src/lib/rail/railData.generated.ts` from its source gives the committed file. Otherwise the next regeneration silently changes step data.
- **What the app does today:** Nothing.
- **Current behavior:** The file is generated from `docs/06-research/hv-extraction/ledger/hv-ledger.json` by `python3 scripts/hv/ledger_to_rail.py`. The generator's output differs from the committed file. The Stage 4 check found three places: two "Working Group List" step descriptions (`p2-s28` and `p2-s30`) and three extra always-on apps. The Stage 6 re-check (after the S6-13 copy fix, commit `3cee1dea`) confirmed the two descriptions still differ.
- **Proposed change:** Reconcile the source ledger with the committed file, then add a check that fails CI on drift.
- **Database and permission impact:** None.
- **Risk if left:** Low. A regeneration changes step text or apps without anyone noticing.

#### E36. `npm run seed:flags:enable` fails without the local env file

Kind: Code only. Priority: Later. Size: S. Predates the branch: yes.

- **What we want and why:** The documented local seed order runs as written, so a new engineer can set up a working local stack.
- **What the app does today:** Nothing.
- **Current behavior:** The script (`package.json:45`) runs `scripts/enable-flags.ts` without `--env-file`, so it fails unless the environment is exported. The working form is `node --env-file=.env.local --import tsx scripts/enable-flags.ts`.
- **Proposed change:** Add `--env-file-if-exists=.env.local` (Node 22), or document the export step in the seed docs. Do not use `--env-file`, which fails in CI where the file is absent.
- **Database and permission impact:** None. Tooling only.
- **Risk if left:** None beyond a failed local setup.

#### E37. Firm-editable default rail, and plain server errors

Kind: Database (default rail); Code only (errors). Priority: Later. Size: M (default rail), S (errors). Predates the branch: yes.

This entry has two parts.

**Firm-editable default rail.**
- **What we want and why:** A firm can edit its Default rail.
- **What the app does today:** Guard. The built-in Default rail is read-only, and the branch shows an honest lock line on it in Rails configuration (ruling RE concern 1).
- **Current behavior:** `DELETE /api/v1/rail-catalog/{templateId}/steps/{stepRowId}` refuses the `default` template with "The house template stays as it is. Start a new template to change its steps." (`src/app/api/v1/rail-catalog/[templateId]/steps/[stepRowId]/route.ts:16-18`).
- **Proposed change:** Let a firm copy the Default rail into a firm-owned default that new deals use.
- **Database and permission impact:** Template ownership and a "firm default" pointer.
- **Risk if left:** Low. Firms start from a copy and must remember to pick it.

**Plain server errors (from review hunt-rail-5).**
- **What we want and why:** People never see raw database text.
- **What the app does today:** The screens map these errors to plain sentences.
- **Current behavior:** Several routes return the raw database message to the browser. One example is `src/app/api/v1/deals/[dealId]/rail/steps/[stepId]/route.ts:22`, `jsonError(error.message, 500)`, which can show text like "pg 23505 constraint …".
- **Proposed change:** Log the database error, and return a fixed plain message with a stable code.
- **Database and permission impact:** None.
- **Risk if left:** Low. Any screen that misses the mapping shows database text, and the text reveals schema details.

#### E43. No end-to-end test covers the CCO releasing or returning held mail

Kind: Code only. Priority: Next. Size: S. Predates the branch: yes.

- **What we want and why:** The compliance officer's Held for review queue is the product's differentiator ("Mail's proactive compliance flagging", KEEP-24). Its release and reject paths should be guarded end to end.
- **What the app does today:** Works. Unit tests cover the queue, the review note, Release and send, and Reject, including the case of a CCO or admin opening `?folder=held` on a deal they are not on (S6R4-R1).
- **Current behavior:** No hermetic journey in `e2e/` drives a held message to release or rejection (found by the develop-merge review, Oct 25).
- **Proposed change:** Add a journey: a deal-team member sends a message that is held, the CCO opens the Held for review link from the bell, adds a review note and releases it, and a second message is rejected and returns to the sender.
- **Database and permission impact:** None. Test only.
- **Risk if left:** Medium. A regression in the compliance queue would reach a release unnoticed.

### Not now

#### E16. Data room for buyers (future)

Kind: Not now. Priority: Not now. Size: L.

- **What we want and why:** Buyer firms see their own view of a deal, with the data room as the bridge between sides. From the meeting: "In future, when the buyers have their own view and portal, then you would invite them to the deal."
- **What the app does today:** Outside parties get data room access only ("Give data room access", `src/components/team/DealInvite.tsx:36`). Existing outside seats are relabeled, not removed.
- **Current behavior:** Buyers are read-only outside users in a limited shell of Deal, Data Room and Team (D44, D46). The data room is off by default for bank users.
- **Proposed change:** Out of scope for now. It needs a model where two firms sit on one deal, each with its own rail and view. Raise it at the view session (Part 3, session 7).
- **Database and permission impact:** Large: how firms are separated in the data, rails per side, and cross-firm visibility rules.
- **Risk if left:** None now. Risk of the change: high.

#### E17. Not now: Superhuman-style @mentions on email threads

Kind: Not now. Priority: Not now. Size: L.

- **What we want and why:** Nothing yet. Recorded so it is not lost. From the meeting: "Then we're building Superhuman all over again, and there's so much complexity here. Why don't we just focus and get the core thing down?"
- **What the app does today:** Nothing. Not built.
- **Current behavior:** Team chat was removed. Threads have no internal notes.
- **Proposed change:** Revisit after the core mail client ships.
- **Database and permission impact:** Would need thread-level notes and notification types.
- **Risk if left:** None. Building it now is scope creep.

#### E18. Not now: bio or digital twin for each lead

Kind: Not now. Priority: Not now. Size: L.

- **What we want and why:** Nothing yet. Recorded so it is not lost. From the meeting: "Eventually the digital twin piece will be built into that. Each lead will have a bio or a twin of sorts."
- **What the app does today:** Nothing. Not built.
- **Current behavior:** Leads come from discovery and show companies, people and network.
- **Proposed change:** Revisit once Leads has a clear job (Question 12).
- **Database and permission impact:** New profile data per lead, with privacy and consent questions.
- **Risk if left:** None now. Risk of the change: medium, because it touches personal data.

---

## Part 2. Questions for Storm, Marco and counsel

These are product questions, not engineering. The branch does not decide them. Where the walkthrough asked for a prototype, it is labeled "Example, not decided". Questions 1 to 14 keep the numbers used in the [rail multiplayer and dependencies proposal](../02-product/rail-multiplayer-and-dependencies-proposal.md) and the notes matrix.

**1. Do dependencies change from deal to deal?** (Storm. Entry E4.)
- Why it matters: "The actual rules behind that also require an understanding of the deal."
- Options: (a) fixed per firm, set once; (b) per rail template, copied into each deal; (c) drawn by the deal lead on each deal.
- Meanwhile: the Preview lets you draw links in your browser. Nothing is saved or enforced.

**2. Do dependencies block, or only warn?** (Storm. Entry E4.)
- Why it matters: "I can't even look at step 35 until step 11 is done."
- Options: (a) hard block; (b) soft warning; (c) an organization setting.
- Meanwhile: links can be marked Hard or Soft in the Preview. Nothing blocks real work.

**3. Do gates apply per buyer or per deal?** (Storm. Entry E4.)
- Why it matters: a buyer's NDA comes before that buyer's data room access, and this repeats for every buyer.
- Options: (a) per deal only; (b) per buyer for chosen steps; (c) per buyer for all gate steps.
- Meanwhile: the rail multiplayer prototype shows one per-buyer gate, labeled "Example, not decided".

**4. Who changes the rail for everyone, and who approves?** (Storm. Entry E3.)
- Why it matters: "Who gets to modify the rail for everyone on the team? And does that apply to everyone or only to an individual?" Today anyone with the company-wide right can edit any deal's rail they are on.
- Options: (a) the mandate owner; (b) the deal MD; (c) a firm setting. Separate sub-questions: what a junior can propose versus change, whether approvals are logged to compliance, and whether the right can differ per organization.
- Meanwhile: edits keep today's rules. The rail says who can change it. "Propose a change" works in your browser only, with a "View as deal lead" switch.

**5. Who may invite whom?** (Storm. Entry E6.)
- Why it matters: "I would think a CEO could invite a CCO and an administrator. I would think a director could invite a person."
- Options: (a) keep today's rule (a firm admin invites the first director; directors invite their own people); (b) let a director invite a CCO at their own bank, approved by a director; (c) keep CCO and Admin as firm-level roles set only by Conductia staff.
- Meanwhile: dialogs offer only the roles the server grants and explain how CCO and Admin are set up. "Admin" is never offered, because it is the platform superuser.

**6. How much mail should Conductia read, and how often?** (Storm. Entry E12.)
- Why it matters: "We're only scanning at onboarding, at least for now... We need to double-check on what that scope is." The system scans continuously.
- Options: (a) keep continuous scanning and say so plainly; (b) weekly sync; (c) once at onboarding, then on demand.
- Meanwhile: no change to scanning. Mail settings say what is read today.

**7. Where do outside parties get invited, and who sees the data room?** (Storm.)
- Why it matters: "If I clicked on Team, I would want to know who has access to the data room." And: "The team view is probably the wrong place for invite to platform."
- Options: (a) invite from the data room, with Team listing access read-only; (b) invite from Team only; (c) both.
- Meanwhile: "Invite to deal" is for colleagues at your firm. Data room access starts from the Data Room. Team shows who has access, read-only, to bank viewers.

**8. Can part of one rail be reused in another, and can a step be hidden instead of removed?** (Storm. Entry E2.)
- Why it matters: "Can I take part of something I did in that other rail and add it here?"
- Options: (a) copy a range of steps; (b) pick single steps from a template; (c) not now. For hiding: (a) hide for me; (b) hide for this deal; (c) remove only.
- Meanwhile: add and remove work as today. Nothing hides.

**9. What should an unsent draft or an override leave in the audit trail?** (Storm and counsel. Entry E11.)
- Why it matters: "If you override the AI, you might get yourself in trouble if we keep that in the audit trail." And: "It takes liability off Conductia."
- Options: (a) no row for abandoned drafts, a row for overrides (today); (b) a row for a returned draft with the warning only, never the text; (c) log nothing about overrides.
- Meanwhile: the audit trail keeps today's rules and adds a Person column and plain override labels. Decision D80 stays.

**10. Should revisions also improve the skill?** (Storm. Entry E10.)
- Why it matters: "That also needs to improve the skill, I think. We'll need to just double-check on that."
- Options: (a) revisions change this output only; (b) suggest a skill improvement after a revision; (c) revisions feed the skill automatically.
- Meanwhile: "What should change?" revises this output only. "Improve this skill" stays as it is.

**11. What should a person's detail on the Team page show?** (Storm and Marco.)
- Why it matters: "This is the type of stuff I would sit down with a person and ask: how much of this matters to you?"
- Options: (a) today's content in plain words; (b) add their other deals and their threads on this deal; (c) vary by viewer role, because a manager may care more than an individual contributor.
- Meanwhile: the detail keeps today's content, in plain words.

**12. Is Leads needed, and should Team be renamed?** (Storm. Entry E18.)
- Why it matters: "The first is Leads... I'm not sure how many of these are necessary." Team mixes colleagues and outside parties.
- Options: (a) keep Leads and Discovery as labeled entries; (b) fold Leads into Discovery; (c) hide Leads until it has a clear job. For the name: keep "Team", or use "Parties" for outside people.
- Meanwhile: Leads and Discovery are clear nav entries. The name stays "Team".

**13. What should the AI flag into the audit trail?** (Storm and counsel.)
- Why it matters: "How often is it only in chat that people are able to click yes or no on an override?"
- Options: (a) overrides only; (b) overrides plus the warnings shown; (c) every screening result.
- Meanwhile: unchanged from option (a).

**14. How should the rail be laid out and zoomed?** (Marco.)
- Why it matters: "Top-level, five phases shown horizontally, expandable into substeps", with a zoomed step showing its neighbors.
- Options: (a) horizontal phases that expand in place; (b) a vertical list with a mini-map; (c) a board of phase columns.
- Meanwhile: the branch ships a provisional horizontal layout and zoom gestures, marked as provisional for Marco.

**15. Can people set their own preferred deal role?** (Storm.)
- Why it matters: Profile shows the role as a choice only to directors and firm admins. Everyone else reads "A director at your firm sets this".
- Options: (a) directors set it (today); (b) each person sets their own preference, which a director can override; (c) drop the field from Profile.
- Meanwhile: (a). Option (b) is a permission change for engineers.

**16. Must every outside invite record the person's relationship to the deal?** (Storm.)
- Why it matters: an invite from Mail requires "Deal relationship". An invite typed directly in the Data Room does not, so a later email to that address skips the counterparty confirmation.
- Options: (a) require it on every outside invite; (b) require it only from Mail (today); (c) ask for it at the first email instead.
- Meanwhile: (b).

**17. What should access phases be called, and can a later phase be granted?** (Storm.)
- Why it matters: "never make somebody use a reference for something they have to go look up." Team shows an outside party's access as "Up to Preparation", by mapping disclosure phase N to the Nth rail phase. Is that the right mapping, or do disclosure phases have their own names? Also, access phases above 4 all read "Signing", and the access select stops at 4. Should a later phase (Closing) be grantable, and what is it called?
- Options: (a) keep the rail phase names; (b) name the disclosure stages separately (for example Teaser, CIM, Data room, Confirmatory); (c) names set per firm.
- Meanwhile: (a), from one map in `src/lib/team/accessPhase.ts`. The select stops at the last named phase.

**18. Should the Data Room list look like the Deal Folder?** (Marco.)
- Why it matters: the Deal Folder shows tinted folders. The Data Room is a flat table with category pills (DOCS-06).
- Options: (a) the same tinted folder list; (b) keep the table with matching colors (today).

**19. Is the privacy page's mail-reading sentence right?** (Counsel.)
- Why it matters: the mail-reading sentence was rewritten in plain English: "let Conductia read the mailboxes of people who agree to deal discovery" (`src/app/privacy/page.tsx:121`). Please confirm or correct it.

**20. Who may remove a director, a CCO or an administrator?** (Storm. Entry E27.)
- Why it matters: today a director can remove all three through the API. The screens assume firm administrators only.
- Options: (a) firm administrators only (the branch's assumption); (b) firm administrators, plus directors for other directors; (c) another rule Storm sets.
- Meanwhile: (a), in the screens only.

**21. Can an Observer own a step?** (Storm. Entry E29.)
- Why it matters: an Observer who owns a step cannot complete or skip it, so the step stalls.
- Options: (a) no: refuse read-only seats as owners; (b) yes: let Observers complete the steps they own.
- Meanwhile: (a), in the Assign dialog only.

**22. Should "Sign out" end this browser's session only, or every device?** (Storm. Entry E34.)
- Why it matters: signing out on a phone also signed the person out on their laptop.
- Options: (a) this browser only, with "Sign out everywhere" in Settings › Profile; (b) every device (today), said on the button.
- Meanwhile: (b), unchanged.

**23. Which steps carry a drop-dead date, where does it come from, and does it show on deal cards?** (Storm. Entry E4.)
- Why it matters: "If this doesn't happen by X date, deal's over."
- Options: (a) the deal's target close only (today); (b) dates on chosen gate steps, set by the deal lead; (c) dates from the rail template, counted from the mandate start.
- Meanwhile: step target and drop-dead dates work in the Preview, in your browser only. Deal cards in the Conductor Center show the real target close.

**24. Should the rail offer a parallel view beside the sequence, and is the choice per person or per firm?** (Storm and Marco. Entry E15.)
- Why it matters: "If we want to allow for asynchronous workflows, it would look a little more like Gantt. That might get a little more confusing." And: "Maybe somebody else wants dependency model versus a sequential model or something that all comes later."
- Options: (a) the sequence only, for the MVP (today); (b) a dependency or timeline view each person can pick; (c) one default view the firm picks.
- Meanwhile: the sequence is the default. The Dependency view is a Preview, and view filters are kept in the browser for one person ("Only you see this view"). The rail multiplayer prototype shows sequential, dependency and timeline views side by side.

**25. Should each firm set who may change its rails?** (Storm. Entry E3. Related to question 4.)
- Why it matters: "I think that's something you just let people set within their own organization."
- Options: (a) one firm-wide permission (today); (b) a firm setting for which roles edit and which only propose; (c) option (b) plus a host on each deal.
- Meanwhile: today's permission is unchanged, and the rail says who can change it.

**26. Should overrides made while editing or improving a skill be logged too?** (Storm and counsel. Related to question 9.)
- Why it matters: "I think maybe when you're editing slash improving a skill."
- Options: (a) only the overrides logged today; (b) also a compliance override inside the skill builder; (c) every skill edit, with its before and after.
- Meanwhile: (a), unchanged.

**27. Do "rail", "phase" and "Conductor Center" stay?** (Marco and Storm.)
- Why it matters: "Very clearly we've got to go rename almost everything." "Step" replaced "station" at Lance's call. The other three were kept by a build ruling and are open to Marco and Storm.
- Options: (a) keep all three (this branch); (b) rename the rail (for example "deal plan"); (c) rename the Conductor Center (for example "Home").
- Meanwhile: (a). The [What changed](../02-product/walkthrough-changes-2026-10-22.md) page lists every word under "Words we now use".

---

## Part 3. Agenda for the two-day view session

Attendees: Storm, Marco, Lance. Each session is 60 to 90 minutes.

1. **Vocabulary and the Conductor Center.**
   - Goal: agree the words (step, rail, phase, Conductor Center) and the Today layout for 10 to 50 deals.
   - Bring: the glossary, the as-is and branch screenshots of the Console and Book, the demo book with 12 deals.
2. **The rail as a board.**
   - Goal: settle orientation, zoom, drag and drop, and what a card shows (owner, activity, phase progress). Answer Question 14.
   - Bring: the interaction notes for Marco, Trello and GitHub Projects references, the branch rail with two browsers signed in.
3. **Multiplayer and dependencies.**
   - Goal: answer Questions 1 to 4. Decide the host model and whether dependencies block or warn.
   - Bring: the rail multiplayer prototype with its "Example, not decided" labels, the decision sheet, one real deal's gates written out by Storm.
4. **Step view and skills.**
   - Goal: decide the step view hierarchy (name first, skill preview and conversation up front), the revise box, and where compliance rules live.
   - Bring: the step view before and after, the teaser skill prompt, Questions 9 and 10.
5. **People, roles and invites.**
   - Goal: answer Questions 5, 7, 11, 12, 15, 16, 17, 20, 21 and 22. Agree who invites whom, who may remove whom, and what Team shows.
   - Bring: the role matrix from the decision log (D33, D42, D47), the Settings and Organization screenshots, a list of the roles the server grants today.
6. **Mail, scanning and the audit trail.**
   - Goal: answer Questions 6, 9, 13 and 19. Confirm scanning scope and consent language, and what the audit trail records.
   - Bring: the scanning facts in E12, the mail client screenshots, the audit trail with its Person column, counsel's view on overrides and on the privacy page sentence.
7. **Deal folder, data room and the buyer future.**
   - Goal: decide who sees the data room now (Question 7 follow-up), answer Question 18, and sketch the two-sided model for later (E16).
   - Bring: the folder and data room screenshots, the access list, the buyer and seller view sketch.
8. **Website and shared copy.**
   - Goal: carry the app vocabulary to the website, and fix the three "capacity, consistency, compliance" cards.
   - Bring: the website review, the notes on the landing page, the hooks that worked ("Bankers should bank", "We are not an AI product").

Close the second day by turning every answer into a decision-log entry and marking the matching entries above as ready for engineering.
