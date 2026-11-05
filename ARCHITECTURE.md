# Conductia Architecture Guide

This is the practical architecture contract for engineers working with Claude and Cursor in this repository.

Use this file as the default operating guide before making any code changes.

## Why this guide exists

Conductia is a compliance-first M&A platform with strict UX and architectural constraints.  
The system works when developers **compose existing contracts** and avoid local one-off patterns.

This guide defines exactly how to work safely.

## System shape (high level)

- App framework: Next.js App Router + TypeScript + Tailwind token system.
- UX spine: authenticated shell with persistent rail + floating command surface.
- Product state model: active project comes from URL (`/projects/[projectId]`), not local mandate state.
- Data model:
  - Product content via typed seam (`ConductiaAPI`).
  - Platform/auth/deals/docs/audit via `/api/v1` (separate from seam).
- Compliance model: one live compliance status instrument in shell.

## Non-negotiable architecture contracts

### 1) API seam contract

- UI reads product domain data only via `src/lib/api/` (`ConductiaAPI` contract).
- Do not bypass seam from feature components for product data.
- `MockConductiaAPI` fixtures are allowed and expected in UI flows.

### 2) Platform API boundary

- `/api/v1` handles the platform: auth, deals, memberships, documents, mail, discovery, rails and audit.
- Feature UI calls `/api/v1` directly, through `apiV1` (`src/lib/api/v1Client.ts`): it throws `ApiV1Error` on any non-2xx response and sends a 401 to sign-in, so a refused write never passes as success. ESLint warns on a raw `fetch('/api/v1/…')` in `src/components` and `src/app`; existing calls move over when their file is touched.
- When several callers share one endpoint's parsing or error handling, add a feature client in `src/lib/<feature>/` on top of `apiV1`.
- Do not merge `/api/v1` transport concerns into `ConductiaAPI`.
- Keep product seam and platform API parallel, not mixed.

### 3) Project-as-URL contract

- Active project is route state: `/projects/[projectId]`.
- Do not reintroduce project selection as global mutable session source of truth.

### 4) Compliance placement contract

- Single live compliance status display belongs in the shell's top navigation (`TopBar`, or `TopNav` behind `workbench_top_nav`), inside a project.
- Route-level components dispatch compliance state, but do not self-render alternate compliance instruments.

### 5) UI architecture contract

- `src/components/atoms/` is the source of truth for base reusable UI.
- Build up through `molecules` and `organisms`; domain screens compose these.
- Do not create or reintroduce `primitives`-style parallel base layers.

### 6) Styling contract

- Use design tokens from `src/app/globals.css`.
- No ad-hoc raw color systems, spacing systems, or parallel radius scales.
- Keep semantic text/surface patterns aligned with existing tokenized classes.

## Repository usage map

- `ARCHITECTURE.md` (this file): working contract for implementation behavior.
- `README.md`: product status, runtime, and invariant overview.
- `docs/03-engineering/architecture.md`: deeper technical architecture context.
- `docs/03-engineering/reusable-components-guide.md`: component usage rules and Cursor prompt templates.
- `AGENTS.md`: repo-level guidance, invariants and working rules for AI-assisted work (`CLAUDE.md` imports it).

## How coworkers should work with Claude/Cursor

### Start every task with this decision flow

1. Identify if the task is UI-only, seam/API, or platform `/api/v1`.
2. Confirm target layer before coding:
   - Base UI -> `atoms`
   - Composite UI -> `molecules` / `organisms`
   - Domain behavior -> domain components/pages
   - Data transport -> seam or `/api/v1` (not both mixed)
3. Reuse existing component/token contracts first.
4. Make smallest correct change.
5. Run type-check/lint/tests relevant to touched files.

### Claude/Cursor prompt constraints (copy-paste)

```text
Implement [task] following Conductia architecture.

Constraints:
- Keep src/components/atoms as single base UI source of truth.
- Reuse existing molecules/organisms before creating new components.
- Do not modify shell/compliance architecture placement.
- Do not introduce raw color/spacing/radius systems; use globals.css tokens.
- Keep product data through ConductiaAPI seam.
- Keep platform transport in /api/v1; do not mix seam and /api/v1 responsibilities.
- Keep project context URL-driven (/projects/[projectId]).
- Return list of files changed and why each changed.
```

### Prompt for refactors (copy-paste)

```text
Refactor [area] to align with Conductia architecture contracts.

Required outcomes:
- Remove duplicate/parallel abstractions.
- Preserve behavior and visual language.
- Keep atoms/molecules/organisms hierarchy clear.
- Keep compliance and shell contracts untouched.
- Keep seam and /api/v1 boundaries intact.
```

## Do / Don’t

- Do compose from `atoms`, `molecules`, `organisms`.
- Do centralize reusable behavior in the right layer.
- Do keep route behavior aligned with URL-driven project context.
- Do preserve contract boundaries even during fast UI iteration.

- Don’t add parallel base component layers.
- Don’t fetch M&A content around the `ConductiaAPI` seam, and don’t call `/api/v1` with a raw `fetch` that ignores a failed status (use `apiV1`).
- Don’t move or duplicate compliance status instruments.
- Don’t break tokenized styling by introducing local design systems.

## PR acceptance checklist

- Architecture contracts above are preserved.
- New UI components are in correct layer and exported clearly.
- No parallel component systems were introduced.
- No seam/platform boundary violations.
- Type-check passes and changed flows are validated.

If any item fails, revise before merging.
