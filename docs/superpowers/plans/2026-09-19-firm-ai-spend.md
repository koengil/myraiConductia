# Firm AI spend UI — first slice of #155

Status: implemented and locally validated, awaiting PR integration.
Selected by Marcelo after #161 on September 19. Base: develop `e1d97376`.
Scope: expose the existing tenant summary on Book, preserve per-deal behavior,
and label agent runs with missing model metadata honestly. Governing sources:
issue #155 and its September 17 comment, Workbench/D48, existing AI spend API
and `firmMailAccess`. UI placement is within existing Book rollout (`book_view`).

## Implementation

Reuse `AiSpendPanel` and the existing authorized endpoint, adding firm scope,
By deal grouping, explicit incomplete-capture/window disclosures and separate
unavailable/empty behavior. Never read denied payloads. Keep per-deal requests
and endpoint-keyed state so scope transitions cannot show stale totals.
Unknown agent-run models use a source label; other unknown models remain separate.
No migration, access-policy change or new provider call.

## Validation

Focused tests first failed in four new cases, then all 25 passed. Full suite:
1,841 passed, 9 skipped. Typecheck, lint and production build passed. Independent
review found no material issues. Chrome inspection used actual component HTML
with mocked data and the application's compiled CSS: at 500/768/1440px all four
tables fit without document overflow; Tab and Enter focused/opened the panel.
This was component-level validation, not full live or hermetic E2E. Required
Supabase integration and hermetic E2E remain CI gates; no shared database used.

## Remaining #155 work

The issue remains open: skill-bench/twin stream cost capture, SQL aggregation
beyond the existing 2,000-record window, orchestration TokenMeter replacement,
and actual backend model metadata are separate follow-ups. Current UI explicitly
identifies uncaptured chat spend, unpriced calls and bounded aggregation.
