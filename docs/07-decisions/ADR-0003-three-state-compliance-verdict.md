# ADR-0003 — Compliance verdict shape: three-state with rewrite suggestions

- **Status:** Accepted (implemented in Phase B of the sandbox merge ledger, 2026-05-20)
- **Date:** 2026-05-20
- **Deciders:** Martin Casado (proposal + implementation; Lance acknowledgement pending)
- **Source:** `docs/archive/MERGE-REVIEW.md` §Merge plan Priority 1.1; `intelibank-sandbox/lib/compliance/screen.ts`; supersedes the prior `src/lib/compliance/rules.ts` contract (deleted in Phase B).

## Context

`intellibank` currently models compliance as a binary verdict: a message is either `clear` or `blocked`, decided by a five-word profanity wordlist in `src/lib/compliance/rules.ts`. The `ComplianceCheckResult` shape in `src/lib/api/types.ts` carries `passed: boolean` and `reasons: string[]`. The frozen `ComplianceRibbon` exposes four UI states via `[data-compliance-status]`: `idle | scanning | clear | blocked`.

The product's central claim is that compliance is the moat. Every reviewer of the current build asks the same question: "is that really all compliance does?" Today the answer is yes.

`intelibank-sandbox` ships a three-state verdict in `lib/compliance/screen.ts`:

- `compliant` — passes all checks.
- `hold · review` — matched at least one promissory pattern (forward-looking language: "guaranteed," "promise," "will return," etc.) OR contains MNPI keywords near a dollar figure; needs human review before sending.
- `blocked` — matched an unambiguous regulatory-domain violation pattern.

Each match also carries a `rewrite` suggestion — a concrete alternative phrasing the MD can drop in. The rewrite is the difference between "the system told me no" and "the system told me how to say this correctly."

This is the substantive content that turns "compliance is the moat" from a claim into a demonstration.

## Decision

Widen the compliance contract to three states. Replace the current `ComplianceCheckResult` shape in `src/lib/api/types.ts` with:

```ts
type ComplianceVerdict = 'compliant' | 'hold' | 'blocked';

interface ComplianceCheckResult {
  verdict: ComplianceVerdict;
  reasons: string[];   // existing; carries human-readable rule labels
  rewrite?: string;    // optional drop-in alternative phrasing
}
```

Port `screen.ts` into `src/lib/compliance/` (renaming and module shape adjusted to A's conventions). Port the corresponding test cases from B (`lib/compliance/screen.test.ts`) into `tests/compliance.test.ts` under vitest. The five-word profanity wordlist is retired.

The `ComplianceRibbon`'s `[data-compliance-status]` UI states gain `hold` as a fifth state: `idle | scanning | clear | hold | blocked`. `hold` is visually distinct from both `clear` and `blocked` — typically a warm amber against the surface, communicating "human attention required" without the finality of `blocked`.

The rewrite suggestion surfaces inline in the affected message UI (`MessageComposer`) with a single-click "use this rewrite" affordance.

## Alternatives considered

- **Two-state with a richer `reasons[]`.** Keep `passed: boolean` and let the reasons carry the nuance. Rejected: the UI surface cannot meaningfully distinguish "needs human review" from "blocked" without a structural cue; the difference is the entire point.
- **Three-state, no rewrite suggestions.** Adopt the verdict shape but skip the inline alternative phrasing. Rejected: rewrites are the demonstration. Without them, the system says "no" and stops; with them, the system shows the MD a path forward — which is what compliance-as-product looks like.
- **Five-state including `pending` and `escalated`.** Maximum nuance. Rejected: gold-plating; no current persona need; would balloon the ribbon surface.

## Consequences

- `src/lib/api/types.ts`: `ComplianceCheckResult` shape changes. Every consumer is touched. Discriminated-union narrowing replaces `result.passed` checks.
- `src/lib/compliance/rules.ts`: deleted (or kept as a thin re-export during a transition window — to be decided in Phase B).
- `src/components/compliance/ComplianceRibbon.tsx`: gains a `hold` visual state. Labels widened: `Compliance monitoring active` / `Checking compliance…` / `Compliant` / `Hold for review` / `Blocked — not compliant`.
- `tests/compliance.test.ts` and `tests/compliance-ribbon.test.tsx` are rewritten to cover three-state behavior. The golden-path lockstep policy in §4 of the front-end overhaul ledger applies: every binary assertion is reviewed and updated explicitly.
- `MessageComposer` surfaces the rewrite suggestion when `verdict === 'hold'` or `verdict === 'blocked'` and `rewrite` is present.
- The compliance "moat" claim in marketing/demo copy can now be substantiated by a live demonstration. The ribbon's `hold` state is the visible artifact of "I am reading what you wrote and thinking about it" — the precise gesture the persona is paying for.

## Open questions

1. Does the `hold` state count as "scanning complete" or as "scanning ongoing" for the ribbon's animation contract? Default proposal: `hold` is a *terminal* state for that message (scanning is done; the verdict is "needs review"). The ribbon settles into amber, does not loop.
2. Should `hold` block `Send`, or merely warn? Default proposal: `hold` warns and offers the rewrite; `Send` is enabled but disrecommended; `blocked` disables `Send` outright.
3. Do we keep B's exact `PROMISSORY_PATTERNS` and `MNPI_KEYWORDS` lists verbatim, or curate? Default proposal: keep verbatim for Phase B; curate based on demo feedback in a follow-up.
