# Template change review (frontend demo)

Status: design confirmed in the brainstorm on 2026-10-01. Implementation has not started. Mockup: [`2026-10-01-template-change-review-demo-mockup.html`](2026-10-01-template-change-review-demo-mockup.html).

## Purpose

Storm asked (Sep 28) that when a company rail template changes, for example "the law just changed and we now need a fairness opinion on every deal", every deal built from it learns about it, and the deal team keeps the final say per step: "it colors it a different color and you can still say no." Deals already under way are never rewritten silently.

This spec covers a **frontend-only demo** of that experience. Its job is to win approval to build the backend described in the handoff (`spec-b-template-change-notice-handoff.md`: notice fan-out, step lineage, pending-change storage). Success means Storm can open a real deal in the demo environment, see that its template moved, review each change, and see the rail reflect the decisions.

### Decisions taken in the brainstorm

- Runs on **real deals** in the demo environment. The incoming change set is a **fixture**; decisions are **local state only**. Nothing is written to the server.
- The notice is a **rail banner only**. No bell item, no notification enum change, no migration. The bell notice is backend work.
- The review surface is a **dialog** opened from the banner, not inline ghost stations.
- A **new flag**, `template_change_review`, gates everything. `rail_templates` is not reused, because the fixture attaches to any deal and must never reach real users.

### Out of scope

Migrations, notification fan-out, `/api/v1` endpoints, step lineage (`templateStepId`, `deal_steps.template_step_id`), the template editing screen, manager notifications, bulk accept, and per-user rails.

## Base

`origin/develop` at `4cd37d48b`. Do not build on `feat/rail-template-management`.

Verified on that base:

- The frontend does not know a deal's template. `deals.rail_template_revision_id` and `rail_template_name` exist in the database but nothing in `src/` reads them, and the deals API does not return them.
- `useProjectRail` returns the server rail only when `project_rail_model` is on. The catalogue fallback (`railFromCatalog`) sets `canEditStructure: false`.
- Rail step identities on the 61-station rail are the catalogue ids from `railData.generated.ts`: `p4-s50` Definitive Agreement Support, `p5-s51` Signing / Announcement Prep, `p5-s53` LinkedIn Post.
- Station cards display their position on the rail (`RailTimeline` passes `steps.indexOf(step) + 1`), so numbers renumber on their own when a step is added or hidden. `displayOrder` is global and phase-major (it defaults to `seq`).
- Flags fail closed; a new flag needs only a `FLAG_REGISTRY` entry plus a row in the environment's flags table.

## Contract

`src/lib/railTemplates/changeReview.ts` defines the shape the backend will later return:

```ts
type TemplateRevisionRef = { id: string; label: string; savedAt: string };

type TemplateChangeSet = {
  template: { id: string; name: string };
  baseRevision: TemplateRevisionRef;
  currentRevision: TemplateRevisionRef & { savedBy: { id: string; name: string } };
  changes: TemplateChange[];
};

type TemplateChangeAnchor = { position: 'after' | 'before'; stepId: string };

type TemplateChange =
  | {
      id: string;
      kind: 'added';
      title: string;
      summary: string;
      phaseIndex: number;
      anchor: TemplateChangeAnchor;
    }
  | { id: string; kind: 'removed'; stepId: string; title: string; phaseIndex: number };

type TemplateChangeDecision = 'accepted' | 'discarded';
```

- `change.id` stands in for the future stable `templateStepId`.
- The diff is between **template revisions**, never against the live rail. A `removed` change whose `stepId` is not active on the deal is dropped before display, so a step the team already removed is never offered again. The backend applies the same rule.
- The `anchor` addresses a deal step by its `stepId`. If the anchor step is absent from the deal, the added step goes to the end of its phase.

### Fixture

| Field | Value |
|---|---|
| Template | Standard sell-side |
| Base revision | v3 |
| Current revision | v4, saved Sep 30 by Storm Duncan |
| Added | **Fairness opinion**, phase 4, after `p4-s50` Definitive Agreement Support. "Independent fairness opinion from a qualified adviser before board approval." |
| Added | **Sanctions re-screen before signing**, phase 5, before `p5-s51` Signing / Announcement Prep. "Re-run KYC and sanctions screening on the counterparty within 10 days of signing." |
| Removed | `p5-s53` **LinkedIn Post** |

The fixture is attached to every deal while the flag is on, because the frontend cannot yet tell which template a deal came from.

## Units

### `useTemplateChanges(projectId)`

Returns `{ changeSet, pending, decisions, decide(changeId, decision), undo(changeId) }`. `changeSet` already has inapplicable removals filtered against the deal's active steps. Today it reads the fixture, and stores decisions in localStorage under `ib-template-changes:<dealId>:<currentRevisionId>`, mirrored live through a window event in the same way as `railRunState.ts`. Returns `changeSet: null` when the flag is off.

### `applyTemplateDecisions(rail, changeSet, decisions)`

A pure function called in `DealRail` before `activeSteps`.

- An accepted addition becomes a `ProjectRailStep` with:
  - `origin: 'custom'`, `stepId: 'template:<changeId>'`, `seq: null` and `status: 'todo'`
  - a manual `definition` of `{ title, description: summary }`
  - a `displayOrder` of the anchor's value plus one third (`after`) or minus one third (`before`), so two additions around neighbouring steps never tie, or the largest value up to and including its phase plus one half when the anchor is absent
  - a `fromTemplate: { revisionLabel }` marker
- An accepted removal is omitted from the returned rail. It does **not** appear in Removed steps, because that section's restore button calls the real API for a step that is still live on the server. Undo lives in the dialog.
- Discarded changes and undecided changes leave the rail unchanged.

### `TemplateChangeBanner`

- **Placement:** in `DealRail`, directly after `Gate0ReceiptBanner`, using the same `role="status"` raised surface.
- **Eyebrow:** "TEMPLATE UPDATED", in mono.
- **Body:** "Standard sell-side moved to v4 on Sep 30 (Storm Duncan). 3 changes wait for your decision. Your rail stays as it is until you choose."
- **Action:** an outline button, "Review changes", that opens the dialog.
- **Visibility:** shown while any change is pending. There is no dismiss.

### `TemplateChangesDialog`

- **Shell:** built on `useModalDialog`, like `SaveRailDialog`.
- **Header:** "Standard sell-side · v3 → v4" with "Saved Sep 30 by Storm Duncan" underneath.
- **Section "Added to the template":** each row shows the title, a meta line ("Diligence, LOI & Definitive Docs · After Definitive Agreement Support"), and the summary. Its buttons are **Add** (primary) and **Discard** (ghost).
- **Section "Removed from the template":** each row shows the title and a meta line ("Signing, Closing & Post-Close · On your rail today"). Its buttons are **Remove** (primary) and **Keep** (ghost).
- **Decided rows:** they collapse to a `Badge` and an **Undo** link. "Added" and "Removed" use the positive tone; "Discarded" and "Kept" use neutral.
- **Footer:** "Nothing changes on your rail until you decide. Discarded changes are not offered again for this version." and a **Close** button.
- **Read-only users:** when `rail.canEditStructure` is false, the buttons are disabled and the dialog adds "Only the deal team can change this rail."

### `StationCard`

A step carrying `fromTemplate` shows a "From template v4" chip and hides its remove control on the card. In Focus it hides the skill runner, Mark complete and the remove control, because the step does not exist on the server.

### Copy

Visible copy contains no em-dashes, uses statements rather than questions, and never names the target company. Deals are identified by codename and code, as the rail header already does.

## Testing

Vitest and React Testing Library, next to the existing rail tests.

- **`applyTemplateDecisions`:**
  - Each addition lands at its `after` or `before` anchor.
  - A missing anchor sends the addition to the end of its phase.
  - An accepted removal hides the step.
  - A discarded or undecided change leaves the rail unchanged.
  - Undo restores the input rail.
- **Removal filtering:** a `removed` change for a step the deal does not have is not offered.
- **`useTemplateChanges`:**
  - Decisions persist across a remount.
  - Decisions are keyed by deal and revision.
  - Two mounted consumers stay in sync through the event.
  - `changeSet` is null with the flag off.
- **Banner:** it shows the pending count, disappears when nothing is pending, and opens the dialog.
- **Dialog:**
  - Each of Add, Discard, Remove and Keep records its decision.
  - Undo returns the change to pending.
  - Read-only users get disabled buttons and the note.
- **`StationCard`:** the `fromTemplate` chip shows, and run, remove and assign controls are absent.
- **`DealRail`:** with `template_change_review` off, there is no banner, no dialog, and the rail is unchanged.
- **Browser validation before the PR:** walk the three mockup moments on a local deal with `project_rail_model` and `template_change_review` on, and capture screenshots.

## Demo environment

Turn on `project_rail_model` and `template_change_review`, and use a deal on the server rail. Turning `template_change_review` off removes every trace of this demo.

## Delivery

Branch `feat/template-change-review-demo` from `origin/develop`, PR to `develop`, four CI checks green, one approval. No migrations, no API changes, no decision-log entry until the backend is approved.

## What the backend replaces

1. Inside `useTemplateChanges`, the fixture becomes `GET /api/v1/deals/:id/rail/template-changes`. Decisions move from localStorage to `POST /api/v1/deals/:id/rail/template-changes/decisions`, stored in a pending-changes table keyed by deal and template revision.
2. `applyTemplateDecisions` and the `fromTemplate` marker go away. Accepting a change writes real deal steps through the rail model, and the page refreshes the rail.
3. Step lineage (`templateStepId` in the manifest and `deal_steps.template_step_id`) gives `change.id` and removal matching for custom steps. Today only catalogue steps can be matched.
4. The notice fan-out in `rail_template_finalize_save` and the `rail_template_updated` bell event follow the handoff's first slice, with `href` pointing to the rail and the dialog open.

The banner, the dialog, the contract types and the `StationCard` chip stay.
