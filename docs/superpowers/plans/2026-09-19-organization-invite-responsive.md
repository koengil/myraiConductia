# Organization invitation control — issue #161

Status: implemented and locally validated, awaiting PR integration.
Scope approved by Marcelo on September 19: #161 first, then the firm-wide
spend UI slice of #155. Base: develop `e1d97376`.

## Requirements

Keep the existing permission-controlled invitation action visible at supported
widths down to approximately 500px. Retain its handler and accessible name.
Use the Workbench control size and focus treatment. Source: issue #161,
D48, Workbench HANDOVER.md and ICON-GUIDE.md. No authorization or API change.

## Implementation and evidence

The action was already outside the roster table. The search input's 18rem
minimum width and `sm:flex-none` prevented it from yielding space. It now
uses `min-w-0 flex-1`, retaining its desktop maximum width. The action retains
`shrink-0`, has a 44px target, a visible keyboard focus ring and a title.

A temporary browser harness rendered the actual React page with mocked data,
compiled the real Tailwind stylesheet and measured the action in Chrome.
At viewport 500px with a 236px navigation reservation, before the change the
button's left edge was 556px; afterwards it was 436px with width 44px.
All ten combinations of viewport 500/640/768/1023/1440 and navigation reservation
0/236 kept the full action inside the viewport after the fix. This is a component
layout check, not a production-session or complete-shell E2E reproduction.
The original reported zoom condition was not independently reproduced.

Validation: existing 1,834 tests passed (9 skipped), TypeScript passed, lint
passed with 32 existing warnings, production build passed. Independent agent
review found no material issue. Local Supabase integration and full hermetic
E2E were not run locally; required CI gates remain responsible for those.
No database, invitation delivery or production account was touched.
