# Reusable Components Guide

This guide is for engineers building UI in Conductia using the reusable components and styling system defined by Design.

Goal: add new UI safely without changing the visual language, spacing rhythm, or app shell structure.

## Why this exists

Design owns the reusable components and styling contract. Engineering should compose those pieces, not redesign them in feature code.

Use this guide when you add any new UI element.

## Fast start checklist

Before coding:

1. Find the right component layer (atom, molecule, organism, feature block).
2. Reuse existing components before creating new ones.
3. Use existing design tokens from `src/app/globals.css`.
4. Avoid raw colors, custom spacing scales, and ad-hoc layout structures.
5. Keep shell and compliance architecture intact.

## Component architecture in this repo

### 1) Foundation atoms

Location: `src/components/atoms/`

Core building blocks include:

- `Button`
- `Badge`
- `Pill`
- `Card`
- `SegmentedControl`
- `ScoreDial`

These are the first choice for interactions and surfaces. `atoms` is the
single source of truth for base UI.

### 2) Atoms

Location: `src/components/atoms/`

Current entrypoint:

- `src/components/atoms/index.ts`

Includes:

- `AvatarInitials`
- `Button`, `Badge`, `Pill`, `Card`, `ScoreDial`, `SegmentedControl`

### 3) Molecules

Location: `src/components/molecules/`

Entrypoint:

- `src/components/molecules/index.ts`

Includes:

- `ProfileIdentity`
- `PaletteSwitcher`
- `StyleModeSwitcher`

### 4) Organisms

Locations:

- `src/components/organisms/navigation/`
- `src/components/organisms/profile/`
- `src/components/organisms/home/`

Entrypoints:

- `src/components/organisms/navigation/index.ts`
- `src/components/organisms/profile/index.ts`
- `src/components/organisms/home/index.ts`

Examples:

- `TopBar`, `Sidebar`, `TopNav`
- `ProfileMenu`
- `HomeHero`

### 5) Shell and domain feature components

Shell location: `src/components/shell/`

- `AppShell`, `AppRail`, `AppNav`, `StageStatus`

Domain feature locations:

- `src/components/mandate/`
- `src/components/acquirers/`
- `src/components/panels/`
- `src/components/team/`
- `src/components/skills/`
- `src/components/compliance/`

## Import rules

Prefer layer entrypoints when available:

```ts
import { AvatarInitials, Button } from '@/components/atoms';
import { ProfileIdentity } from '@/components/molecules';
import { Sidebar } from '@/components/organisms/navigation';
```

If there is no barrel export yet, import from the component file and add a typed export to that folder `index.ts` when appropriate.

## Styling and structure guardrails

These are non-negotiable:

1. Do not hardcode raw hex colors in feature/page code.
2. Do not invent new spacing or radius scales in component code.
3. Do not move compliance status rendering outside the existing shell contract.
4. Do not duplicate shell layout patterns per page when `AppShell` or shell components already solve it.
5. Do not replace semantic typography classes with random one-off styles.

Always use the design token contract in `src/app/globals.css`, including:

- Color tokens (`--ink`, `--surface`, `--accent`, `--ink-on-dark`, etc.)
- Spacing tokens (`--space-*`)
- Radius tokens (`--radius-*`)
- Semantic text classes (`.bank-heading`, `.bank-body`, `.bank-label`, etc.)
- Surface helpers (`.surface-cinematic`, `.surface-canvas-stage`, etc.)

## How to add a new UI element safely

1. Check if an existing primitive, atom, molecule, or organism already covers the need.
2. Compose from existing components first.
3. If missing, add the smallest new reusable component at the correct layer.
4. Reuse tokenized classes and semantic type classes.
5. Export the new component through the local layer `index.ts`.
6. Verify in existing routes or a local dev surface.
7. Run lint/tests for touched files.

## Adding a new reusable component

When creating a new component:

- Place it in the correct layer folder.
- Keep props typed and narrow.
- Keep style token-driven.
- Add an export in that layer `index.ts` so others can discover and reuse it.
- Prefer composition over deep conditional styling branches.

Recommended file pattern:

- `src/components/<layer>/<ComponentName>.tsx`
- `src/components/<layer>/index.ts` export

## Cursor prompt guide for engineers

Use prompts like these to reduce styling regressions.

### Prompt template 1: add UI using existing components only

```text
Add [feature/section] to [route/file].

Constraints:
- Reuse existing components from src/components first.
- Do not modify src/app/globals.css tokens or shell structure.
- Do not hardcode colors, spacing, or radius values.
- Keep compliance rendering behavior unchanged.
- If no reusable component exists, create one in the correct layer and export it in that layer index.ts.
- Return a short summary of which components were reused or created.
```

### Prompt template 2: create a new reusable component safely

```text
Create a reusable [atom/molecule/organism] named [ComponentName].

Constraints:
- Place it under src/components/[layer]/.
- Use existing design tokens and semantic classes only.
- Keep TypeScript props explicit and minimal.
- Add exports in src/components/[layer]/index.ts.
- Update consuming screen(s) to use the new component without changing overall layout structure.
```

### Prompt template 3: refactor page UI into reusable pieces

```text
Refactor [page/file] to use reusable components.

Constraints:
- Preserve current behavior and information hierarchy.
- Move repeated UI into reusable components in the correct layer.
- Do not alter shell, compliance architecture, or token definitions.
- Keep styling consistent with existing components and globals.css contract.
```

## PR review checklist for UI changes

Use this checklist in every UI PR:

- Reused existing components before creating new ones.
- New components are placed in the correct layer.
- New components are exported from the layer `index.ts`.
- No raw color/spacing/radius literals were introduced in feature code.
- Shell structure and compliance rendering contract remain unchanged.
- Theme, palette, and light/dark modes still behave correctly.

## Repository clarity expectation

To keep this repository clear for all developers:

- Treat `src/components/*` as the source of reusable UI truth.
- Keep layer boundaries explicit.
- Keep token usage centralized in `src/app/globals.css`.
- Document any newly introduced reusable component by exporting it from its layer index.

If a developer cannot discover or reuse a component quickly, improve exports first, then add code.
