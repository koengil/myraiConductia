# Conductia Workbench — Component Map
Register: warm-neutral workbench (Workbench Kit.dc.html). Sources: references/01-product-workbenches (Harvey + Hebbia) for grammar and craft; all content, labels, and flows are Conductia's (repo: conductia/src). Scores from the section-07 audit; every component ships only at 10/10.

## Legend
- Kit = section anchor in Workbench Kit.dc.html
- Screens = repo routes the component serves
- Journey = the user moment it exists for

## Foundations (Kit 01) — score 10/10
| Token group | Values | Consumed by |
|---|---|---|
| Neutrals | canvas #F5F4F1 · surface #FFF · field #F1F0EC · border #ECEAE5 hairline / #E0DED8 strong | every surface |
| Ink | #191919 primary · #55534E secondary · #6B6B68 tertiary · #9C9A94 quiet (non-text) | text, primary buttons |
| Status fills | negative #F8C9D1/#8E2440 · caution #FAE6A8/#6E5308 · positive #8FE6BF/#0B5C3B | verdict chips, held/blocked |
| Signals | strong #17B26A · situational #F5A524 · sync #2E90FA · AI violet #5E5CE6 | dots, send button, active station |
| Type | Inter (system-first); serif (Georgia) ONLY for project identity + source excerpts; mono for ids/receipts | global |
| Shape | 8 controls · 12 cards/modals · 16–18 composers · pill chips/tabs | global |
| Elevation | hairlines; one ambient shadow on floating composers only | composer, popovers |

## Components
| Component | Kit | Reference grammar | Screens (repo route) | Journey moment | Score |
|---|---|---|---|---|---|
| Ink primary button | 02 | harvey upload/create | all | the one commit per decision area | 10 |
| Outline button | 02 | harvey queries/share/cancel | all | secondary action | 10 |
| Quiet toolbar button | 02 | harvey composer footer | chat, rail, mail | low-stakes tools | 10 |
| Send (ink square / violet circle) | 02 | harvey arrow · hebbia max | chat, deal home | submit; violet = AI actor | 10 |
| Suggestion chips | 02 | harvey vault hero | deal home, chat empty state | first-run prompts | 10 |
| Segmented pill tabs | 02 | hebbia history/files/published | deal home, data room, mail filters | view switch | 10 |
| Sync status + refresh + search + filters | 02 | harvey files header | data room, deal folder, companies | table toolbar | 10 |
| Verdict chip (filled pastel) | 03 | harvey review table | diligence review, mail states, compliance verdicts | scannable judgment | 10 |
| Category tag (dot pill) | 03 | harvey files table | data room, deal folder | classification at a glance | 10 |
| Signal dot + label | 03 | hebbia matrix fit | buyers matrix, rail states | strength read | 10 |
| Context chip (scope) | 03 | harvey composer | chat composer, ask scope | names the perimeter | 10 |
| Removable scope chip | 03 | hebbia auto-source | chat composer | source policy control | 10 |
| Inline token | 03 | hebbia email drafts | outreach drafts, mail compose | variable in drafted copy | 10 |
| Harvey-pattern composer | 04 | harvey vault hero | /projects/[id]/chat | ask within scope | 10 |
| Floating composer + serif identity | 04 | hebbia project workspace | /projects/[id] deal home | the deal IS a workspace | 10 |
| Files table | 05 | harvey vault hero | /data-room, /deal-folder | browse + classification | 10 |
| Review table (numbered, verdicts) | 05 | harvey review table | diligence review (dataroom), acquirer screening | exception scan | 10 |
| Matrix knowledge grid | 05 | hebbia matrix | /acquirers (buyers) | entity × agent-job artifact | 10 |
| Create modal (filled inputs) | 06 | harvey knowledge controls | gate-0 wizard steps, invites, rooms | governed creation | 10 |
| Upload dropzone + connectors | 06 | harvey shared vault | data room upload, seller journey | first upload | 10 |
| Toolbar + breadcrumb + avatars + Invite | 06 | harvey/hebbia chrome | all authed screens | orientation + collaboration | 10 |

## Conductia-native components (Kit 08 — composed from the grammar above)
| Component | Kit | Screens | Journey moment | Score |
|---|---|---|---|---|
| Compliance instrument (idle/hold/blocked) | 08 | global top chrome, exactly one instance | ambient assurance → verdict | 10 |
| Rail station rows + run receipt | 08 | /projects/[id]/rail | morning scan → next decision → receipt | 10 |
| Held-message card (release gate) | 08 | /projects/[id]/mail | supervisor release (MD/CCO) | 10 |
| Citation chip + source card | 08 | /projects/[id]/chat | read → verify → open passage | 10 |
| History list | 08 | /projects/[id], /history | return to past work | 10 |
| Confirmation toast (receipt voice) | 08 | global | after every commit | 10 |

## Chrome & platform shells (Kit 09–12) — built this pass, score 10/10
| Component | Kit | Screens | Journey moment | Score |
|---|---|---|---|---|
| Global top nav (56px, light) | 09 | all authed routes | orientation; active = field-gray pill | 10 |
| Deal switcher menu | 09 | all | switch perimeter (URL state) | 10 |
| Command palette | 09 | global | jump anywhere (⌘K) | 10 |
| Score dial (warm register) | 10 | /insight, acquirer detail | fit read in one glance | 10 |
| Phase meter + deal context | 10 | every deal screen | where the deal stands | 10 |
| Loading shimmer + empty state | 10 | all async surfaces | honest waiting; one ink action | 10 |
| Audit register table (light) | 11 | /projects/[id]/audit | reconstruct → export | 10 |
| Team party columns | 12 | /projects/[id]/team | perimeter view by side | 10 |
| Gate-0 wizard shell | 12 | /projects/new | governed creation | 10 |
| Auth card (sign-in/MFA/invite) | 12 | unguarded routes | entry | 10 |

## Backlog
Not every mapped component is built yet (checked 2026-10-24): the command palette (⌘K), the confirmation toast and the loading shimmer / empty state have no component in `src/components` (`TopNav.tsx` notes that no command palette exists; the unmounted `CommandBar` intent bar was retired on 2026-10-25). Whether to build or drop them is on the design-system session agenda. Next: Step 2 — screen-by-screen restructure per the order below.

## Screen restructure order (Step 2, on approval)
1. Deal home (floating composer + history) — hebbia workspace pattern
2. Chat/Ask (harvey composer + citation/source cards)
3. Buyers matrix (knowledge grid)
4. Data room (files table + dropzone + review table)
5. Rail (station rows + receipts)
6. Mail (pipeline + held card)
7. Today/queue, Team, Audit, Auth, Wizard

## Overlays (src/components/overlay)
One system for everything that moves in and out of the screen. All overlays share one motion clock (`motion.ts`: 180ms, decelerating ease; a dialog rises 8px, a menu or popover drops 4px; reduced motion keeps the fade and drops the travel) and one scrim (`--scrim`, ink at 55%).

| Need | Use | Notes |
|---|---|---|
| Create, confirm, or a focused task | `Dialog` | Centered, portal to `document.body`, sizes sm 360 / md 440 / lg 640 / xl 880. Title, optional eyebrow and description, close button top-right, footer right-aligned with the primary action last. Keyboard and focus via `useModalDialog`. `open` is required: keep the Dialog mounted and toggle `open` so the exit plays; hold the record the body needs with `useRetainedWhileClosing(target)`. A parent that mounts a dialog conditionally wraps that condition in `<AnimatePresence>` with a `key`, and the exit still plays. Escape and the close button always close. |
| Actions on a record, or a short pick list | `Menu` | Radix DropdownMenu behind small props. Three-dot by default, or pass visible `trigger` content for a picker (items with `checked`). An item may carry a `description`, shown as a second line and exposed as its accessible description, never as part of its name (lead skills). Portals (into the open Dialog's panel, else the body) and flips to stay on screen, so rows, Disclosures and dialog bodies never clip it. Arrow keys, Home/End, typeahead; Escape and Tab close and return focus to the trigger. Destructive items confirm in a Dialog. |
| A panel that holds more than actions: a search field and list, links, approve and deny buttons, an identity header or a status line | `Popover` | Non-modal (`role="dialog"`, no `aria-modal`), named by `label`, rendered right after its trigger (`aria-expanded`, `aria-controls`, `aria-haspopup="dialog"`). No focus trap: Tab moves through it and out, and leaving it closes it. Escape closes and returns focus to the trigger; an outside press closes it where the user is. Enters on the overlay clock, closes at once. A choice inside that opens a Dialog first closes the Popover to its trigger (`triggerRef`), so the Dialog returns focus there. Used by the notifications bell, the profile panel and the three deal switchers. |
| Record detail | `Disclosure` (+ `DisclosureGroup single`) | Detail opens inline under the row the user pressed. `single` keeps one row open at a time. `meta` is text only (it sits inside the row button); controls and chips go in `actions`, beside the button. |
| Anything not saved yet | `PreviewChip` / `PreviewBanner` | Chip: "Preview", described as "Not saved yet. Engineers are wiring this." Banner: "Preview. Only you see this. Nothing here is saved to the deal." with an optional Reset. Never present unsaved state as saved; link the handoff entry in a code comment. |

Rules:
- Dialogs are named by their title. `ariaLabel` is an escape hatch for legacy names; new dialogs never set it.
- Scrim click closes by default, because there a click on the scrim means cancel. Set `dismissOnScrim={false}` when the dialog holds typed input (a stray click would throw it away) or is a destructive confirm (the user must choose Cancel or the action explicitly). Escape and the close button still close.
- No right-side drawers or slide-overs; close things where the user is (Escape, the close button, or the row that opened them).
- Popover or Menu: if every row is an action or a choice with a label (and at most a description line), use `Menu`, which gives arrow keys and typeahead. If the panel holds a text field, links mixed with buttons, a header, or a status line, use `Popover`; never put `role="menu"` around that content.
- Kept outside the Dialog component, with a reason in the S4b-2 overlay table: the skill builder (a fixed-height workspace whose every exit saves the draft first) and the output review (wider and taller than the largest Dialog). Both use the `--scrim` token and the shared enter and exit motion.
- Reference migrations: `atoms/ExternalLinkDialog.tsx` (kept mounted with `open`, so it exits with motion; scrim closes; Cancel takes first focus explicitly) and `rail/SkipModal.tsx` (typed reason, so the scrim does not close).
