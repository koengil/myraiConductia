# Conductia Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Read `master.md` in this directory FIRST.**

**Goal:** Build a guided, clickable, deployable Conductia sandbox demo (Atlassian sell-side) plus the distilled `/docs` foundation library.

**Architecture:** Next.js 16 App Router, client-driven guided flow. UI depends ONLY on a typed `ConductiaAPI`; `MockConductiaAPI` returns fixtures. Composite scoring and compliance checks are pure deterministic modules. Approach C: guided spine + one real hero canvas (the acquirer deep-dive).

**Tech Stack:** Next.js 16, TypeScript (strict), Tailwind, Framer Motion, Vitest + @testing-library/react, hand-rolled shadcn-style primitives.

---

## Rigor convention (read before executing)

This is a UI/animation-heavy demo on a deadline. Apply rigor where it has teeth:

- **Logic tasks (Phase 1) — STRICT TDD.** Full failing test → run-fail → minimal impl → run-pass → commit. Code shown in full. These are the contract; correctness is non-negotiable (the 87/67 must be exact).
- **UI tasks (Phases 2–6) — CONTRACT + SMOKE.** Each task gives exact file path, fully-typed props/interface, the precise `ConductiaAPI` call it consumes, enumerated visual states, animation beats, and a concrete acceptance check (what you must see / a render test where cheap). No vague verbs ("add appropriate X") — those are plan failures. The executing subagent writes the JSX to the stated contract; it does not invent the contract.
- **DRY / YAGNI:** build only what the golden path (spec §5) needs. Graceful stub = a captioned "not in this demo" state, never a crash.
- **Commits:** one per task. Conventional commits. No remote push (D3 — Lance's checkpoint).

---

## File structure

```
intellibank/
  package.json  tsconfig.json  next.config.ts  tailwind.config.ts  vitest.config.ts
  src/
    app/
      layout.tsx                 # root: fonts, theme, <ComplianceRibbon/>, <SessionProvider/>
      page.tsx                   # stage orchestrator: renders stage from useSession()
      globals.css                # tailwind + brand tokens
    lib/
      api/
        types.ts                 # ALL domain types + ConductiaAPI interface (THE contract)
        fixtures.ts              # atlassian, acquirers, peers, team, skills (exact numbers)
        mock.ts                  # MockConductiaAPI (delegates scoring/compliance to pure modules)
        index.ts                 # getApi(): ConductiaAPI  — the single swap point
      scoring/composite.ts       # pure: computeCompositeScore(fitInputs) -> CompositeScore
      compliance/rules.ts        # pure: checkMessage(body) -> ComplianceCheckResult
      session/store.ts           # zustand-free React context: stage machine + canvas panels
    components/
      primitives/                # Button, Card, Badge, Pill, ScoreDial (branded shadcn-style)
      compliance/ComplianceRibbon.tsx
      acquirers/{AcquirerCard,AcquirerLandscape,PeerStrip}.tsx
      skills/{SkillShelf,SkillCard,Canvas}.tsx
      panels/{FinancialMatrixPanel,CultureRadarPanel,ScoreBreakdownPanel}.tsx
      team/{TeamDrawer,MessageComposer,PaywallLock}.tsx
      stages/{ColdOpen,Intent,Landscape,DeepDive,ComplianceTheatre,PitchCta}.tsx
    test/setup.ts
  tests/                         # Vitest specs mirror src/lib
```

**Type contract (defined once in Task 1.2, referenced everywhere — names are exact and final):**

- `CompanyKind = 'seller' | 'acquirer' | 'peer'`
- `Financials = { valuationUsd:number; revenueUsd:number; revenueGrowthPct:number; ebitdaUsd:number; ebitdaMarginPct:number; cashUsd:number; headcount:number }`
- `FinancialFactors = { valuationCoverage:number; cashCapacity:number; growth:number; margin:number }` // each 0–100
- `CultureFactors = { vision:number; mission:number; founder:number; headcount:number; industry:number; product:number; culture:number }` // each 0–100
- `FitInputs = { financial: FinancialFactors; culture: CultureFactors }`
- `CompositeScore = { total:number; financialSub:number; cultureSub:number; breakdown: { label:string; value:number }[]; compliancePassed:boolean }`
- `Company = { id:string; name:string; kind:CompanyKind; tagline:string; financials:Financials }`
- `Acquirer = Company & { kind:'acquirer'; fitInputs:FitInputs }`
- `Skill = { id:string; name:string; description:string; category:string; premium:boolean; panel:'financialMatrix'|'cultureRadar'|'scoreBreakdown' }`
- `TeamMember = { id:string; name:string; role:'MD'|'CFO'|'M&A Advisor'; initials:string }`
- `ComplianceStatus = 'idle' | 'scanning' | 'clear' | 'blocked'`
- `ComplianceCheckResult = { status:'clear'|'blocked'; reasons:string[]; ruleIds:string[] }`
- `Stage = 'coldOpen' | 'intent' | 'landscape' | 'deepDive' | 'complianceTheatre' | 'pitchCta'`
- `PanelData = { kind:'financialMatrix'; company:Company } | { kind:'cultureRadar'; factors:CultureFactors } | { kind:'scoreBreakdown'; score:CompositeScore }`
- `ConductiaAPI = { getSeller():Promise<Company>; getAcquirers():Promise<Acquirer[]>; getPeers():Promise<Company[]>; getSkills():Promise<Skill[]>; getTeam():Promise<TeamMember[]>; getAcquirerScore(id:string):Promise<CompositeScore>; runSkill(skillId:string, acquirerId:string):Promise<{ locked:true } | { locked:false; panel:PanelData }>; checkMessageCompliance(body:string):Promise<ComplianceCheckResult>; sendMessage(input:{fromId:string;toId:string;body:string}):Promise<{ delivered:boolean; compliance:ComplianceCheckResult }> }`

---

## Phase 0 — Foundation docs distillation

Parallelizable: one subagent per doc. Each subagent gets the spec + `master.md` + the source file(s). Rule: distill (accurate, concise, structured); cite `99-source/`; never paste transcript.

### Task 0.1: Vision docs

**Files:** Create `docs/00-vision/north-star.md`, `docs/00-vision/strategy-and-moat.md`

- [ ] Write `north-star.md`: the 5–10yr automated-investment-bank vision, compliance-first thesis, the skills-marketplace endgame. Source: `99-source/01-founder-call-storm.md`. Each major claim cites the source line/section.
- [ ] Write `strategy-and-moat.md`: why compliance-first is the moat; the explicit anti-Rogo positioning; competitive notes (Rogo $2B, the SLM player). Source: `99-source/01` + `03`.
- [ ] Verify: every section has a `Source:` cite; no transcript paste; `docs/README.md` 00-vision status → Distilled. Commit `docs: distil vision`.

### Task 0.2: Business docs

**Files:** Create `docs/01-business/{market-and-opportunity,competitive-landscape,monetization-and-skills-economy,stakeholders-and-gtm}.md`

- [ ] `market-and-opportunity.md` — TAM framing (IB market), the wedge. Source `99-source/01`.
- [ ] `competitive-landscape.md` — Rogo (per-analyst pricing, PowerPoint, no compliance), the SLM player; Conductia's differentiation. Source `99-source/01`+`03`.
- [ ] `monetization-and-skills-economy.md` — paid plans gated by skills, premium skill, future skill marketplace/rev-share. Source `99-source/02`+`03`.
- [ ] `stakeholders-and-gtm.md` — Storm, FINRA advisors, BofA/Citi outreach, Action Partners (June). Source `99-source/01`.
- [ ] Verify + commit `docs: distil business`.

### Task 0.3: Product docs

**Files:** Create `docs/02-product/{product-principles,personas-and-jobs,experience-spine,skills-catalog,matrices}.md`

- [ ] `product-principles.md` — MD-not-analyst; decisions-not-data; compliance omnipresent; sell-side; pre-onboarded.
- [ ] `personas-and-jobs.md` — the MD persona (Mike Cannon-Brookes archetype) + jobs-to-be-done in sell-side M&A.
- [ ] `experience-spine.md` — the 7-step golden path expanded (mirror spec §5; this is the build + demo contract).
- [ ] `skills-catalog.md` — provisional 4 working + 1 premium skill (table: id, name, panel, premium). Marked "provisional pending `06-research/`". Must match `fixtures.ts` skill ids (cross-check in Phase 1).
- [ ] `matrices.md` — compliance/financial/culture definitions + the composite formula (mirror Phase 1 Task 1.4 exactly: weights 0.55/0.45, sub = mean of factors).
- [ ] Verify + commit `docs: distil product`.

### Task 0.4: Engineering docs

**Files:** Create `docs/03-engineering/{architecture,data-contracts,conventions,sandbox-vs-production}.md`

- [ ] `architecture.md` — Next.js client-driven flow; component layers; state model.
- [ ] `data-contracts.md` — the `ConductiaAPI` interface verbatim from `plan.md` type contract = the future backend contract. This file and `types.ts` must stay in sync (note it).
- [ ] `conventions.md` — TS strict, file-size discipline, commit style, no-remote rule (D3).
- [ ] `sandbox-vs-production.md` — what is mocked, where the seam is, the swap procedure (`lib/api/index.ts`).
- [ ] Verify + commit `docs: distil engineering`.

### Task 0.5: Brand + growth docs

**Files:** Create `docs/04-brand/{brand-foundations,visual-language,motion-language}.md`, `docs/05-growth/{narrative-and-positioning,demo-script}.md`

- [ ] `brand-foundations.md` — name, positioning line, voice (precise/senior/decisive/anti-data-dump).
- [ ] `visual-language.md` — palette/type/spacing as a rogo.ai-derived STARTING skin, documented as Conductia's own evolvable system (D11). Capture concrete tokens (hex, font stack) extracted from rogo.ai.
- [ ] `motion-language.md` — the three named motions: compliance pulse, skill-transform stream, score reveal (durations, easings).
- [ ] `narrative-and-positioning.md` — the anti-Rogo story for go-to-market.
- [ ] `demo-script.md` — the exact Sunday walkthrough narration, beat by beat, mapped to stages.
- [ ] Verify + commit `docs: distil brand+growth`; flip all `docs/README.md` statuses.

---

## Phase 1 — Scaffold + design system + the seam (STRICT TDD)

### Task 1.1: Scaffold Next.js + tooling

**Files:** Create `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `src/test/setup.ts`

- [ ] Init: `npx create-next-app@latest . --typescript --tailwind --app --no-src-dir --use-npm --eslint` then move to `src/` layout; add deps: `framer-motion`, `vitest`, `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`.
- [ ] `vitest.config.ts` with jsdom env + setup file; `src/test/setup.ts` imports `@testing-library/jest-dom`.
- [ ] Add `"test": "vitest run"`, `"test:watch": "vitest"` to package.json scripts.
- [ ] Step — verify: `npm run build` succeeds; `npm test` runs (0 tests OK).
- [ ] Commit `chore: scaffold next.js + vitest`.

### Task 1.2: Domain types (the contract)

**Files:** Create `src/lib/api/types.ts`

- [ ] Write `types.ts` containing exactly the **Type contract** block from the File Structure section above (all aliases + `ConductiaAPI`). No logic.
- [ ] Step — verify: `npx tsc --noEmit` passes.
- [ ] Commit `feat: domain type contract`.

### Task 1.3: Fixtures with exact numbers

**Files:** Create `src/lib/api/fixtures.ts`, `tests/fixtures.test.ts`

- [ ] **Write failing test** `tests/fixtures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { acquirers, seller, peers, team, skills } from '../src/lib/api/fixtures';

describe('fixtures', () => {
  it('Anthropic fit inputs average to sub-scores 84 / 91', () => {
    const a = acquirers.find(x => x.id === 'anthropic')!;
    const f = a.fitInputs.financial; const c = a.fitInputs.culture;
    const fin = Math.round((f.valuationCoverage+f.cashCapacity+f.growth+f.margin)/4);
    const cul = Math.round((c.vision+c.mission+c.founder+c.headcount+c.industry+c.product+c.culture)/7);
    expect(fin).toBe(84); expect(cul).toBe(91);
  });
  it('Salesforce fit inputs average to sub-scores 71 / 62', () => {
    const a = acquirers.find(x => x.id === 'salesforce')!;
    const f = a.fitInputs.financial; const c = a.fitInputs.culture;
    const fin = Math.round((f.valuationCoverage+f.cashCapacity+f.growth+f.margin)/4);
    const cul = Math.round((c.vision+c.mission+c.founder+c.headcount+c.industry+c.product+c.culture)/7);
    expect(fin).toBe(71); expect(cul).toBe(62);
  });
  it('has seller Atlassian, ≥5 acquirers, peers, 3 team, 5 skills incl 1 premium', () => {
    expect(seller.id).toBe('atlassian');
    expect(acquirers.length).toBeGreaterThanOrEqual(5);
    expect(peers.length).toBeGreaterThanOrEqual(2);
    expect(team).toHaveLength(3);
    expect(skills).toHaveLength(5);
    expect(skills.filter(s => s.premium)).toHaveLength(1);
  });
});
```

- [ ] **Run → expect FAIL** (`Cannot find module fixtures`). `npx vitest run tests/fixtures.test.ts`.
- [ ] **Implement** `src/lib/api/fixtures.ts` (typed by `types.ts`). Exact required numbers:
  - `anthropic.fitInputs.financial = { valuationCoverage:88, cashCapacity:80, growth:86, margin:82 }` (avg 84)
  - `anthropic.fitInputs.culture = { vision:95, mission:94, founder:92, headcount:90, industry:88, product:90, culture:88 }` (avg 91)
  - `salesforce.fitInputs.financial = { valuationCoverage:74, cashCapacity:68, growth:70, margin:72 }` (avg 71)
  - `salesforce.fitInputs.culture = { vision:60, mission:58, founder:64, headcount:66, industry:62, product:61, culture:63 }` (avg 62)
  - 3 more acquirers (e.g. microsoft, adobe, servicenow) with any internally-consistent inputs.
  - `seller` = Atlassian with plausible `Financials`; `peers` = Figma, Canva (+Monday optional) with `Financials`; `team` = MD "Mike Cannon-Brookes", CFO, M&A Advisor; `skills` = 5 entries, ids: `financial-performance`, `acquirer-fit`, `culture-signal`, `deal-readiness`, `synergy-engine` (premium:true, the others false), each with a `panel` value.
- [ ] **Run → expect PASS.**
- [ ] Commit `feat: fixtures with deterministic fit inputs`.

### Task 1.4: Composite scoring (pure, deterministic)

**Files:** Create `src/lib/scoring/composite.ts`, `tests/composite.test.ts`

- [ ] **Write failing test** `tests/composite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeCompositeScore } from '../src/lib/scoring/composite';
import { acquirers } from '../src/lib/api/fixtures';

const score = (id:string) =>
  computeCompositeScore(acquirers.find(a => a.id === id)!.fitInputs);

describe('computeCompositeScore', () => {
  it('Anthropic totals 87 (financialSub 84, cultureSub 91)', () => {
    const s = score('anthropic');
    expect(s.financialSub).toBe(84);
    expect(s.cultureSub).toBe(91);
    expect(s.total).toBe(87);
    expect(s.compliancePassed).toBe(true);
    expect(s.breakdown.length).toBeGreaterThanOrEqual(2);
  });
  it('Salesforce totals 67 (financialSub 71, cultureSub 62)', () => {
    const s = score('salesforce');
    expect(s.financialSub).toBe(71);
    expect(s.cultureSub).toBe(62);
    expect(s.total).toBe(67);
  });
});
```

- [ ] **Run → expect FAIL.**
- [ ] **Implement** `src/lib/scoring/composite.ts`:

```ts
import type { FitInputs, CompositeScore } from '../api/types';

export function computeCompositeScore(fit: FitInputs): CompositeScore {
  const f = fit.financial;
  const c = fit.culture;
  const financialSub = Math.round((f.valuationCoverage + f.cashCapacity + f.growth + f.margin) / 4);
  const cultureSub = Math.round(
    (c.vision + c.mission + c.founder + c.headcount + c.industry + c.product + c.culture) / 7,
  );
  const total = Math.round(0.55 * financialSub + 0.45 * cultureSub);
  return {
    total,
    financialSub,
    cultureSub,
    compliancePassed: true,
    breakdown: [
      { label: 'Financial fit', value: financialSub },
      { label: 'Culture & strategic fit', value: cultureSub },
    ],
  };
}
```

- [ ] **Run → expect PASS** (Anthropic 87, Salesforce 67 exact).
- [ ] Commit `feat: deterministic composite scoring`.

### Task 1.5: Compliance rules (pure, deterministic)

**Files:** Create `src/lib/compliance/rules.ts`, `tests/compliance.test.ts`

- [ ] **Write failing test** `tests/compliance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { checkMessage } from '../src/lib/compliance/rules';

describe('checkMessage', () => {
  it('clears a professional message', () => {
    const r = checkMessage('Here are the financial statements for review.');
    expect(r.status).toBe('clear');
    expect(r.reasons).toHaveLength(0);
  });
  it('blocks profanity with a FINRA-style reason and rule id', () => {
    const r = checkMessage('here are the financials, and honestly, fuck you');
    expect(r.status).toBe('blocked');
    expect(r.ruleIds).toContain('FINRA-2210-LANGUAGE');
    expect(r.reasons[0]).toMatch(/communication/i);
  });
});
```

- [ ] **Run → expect FAIL.**
- [ ] **Implement** `src/lib/compliance/rules.ts`:

```ts
import type { ComplianceCheckResult } from '../api/types';

const PROFANITY = ['fuck', 'shit', 'asshole', 'bastard', 'dickhead'];

export function checkMessage(body: string): ComplianceCheckResult {
  const text = body.toLowerCase();
  const hit = PROFANITY.some(w => text.includes(w));
  if (hit) {
    return {
      status: 'blocked',
      ruleIds: ['FINRA-2210-LANGUAGE'],
      reasons: [
        'Blocked: inappropriate language violates communications standards (FINRA Rule 2210). Message not sent.',
      ],
    };
  }
  return { status: 'clear', ruleIds: ['FINRA-2210-LANGUAGE'], reasons: [] };
}
```

- [ ] **Run → expect PASS.**
- [ ] Commit `feat: deterministic compliance rules`.

### Task 1.6: MockConductiaAPI + provider seam

**Files:** Create `src/lib/api/mock.ts`, `src/lib/api/index.ts`, `tests/mock-api.test.ts`

- [ ] **Write failing test** `tests/mock-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getApi } from '../src/lib/api';

describe('MockConductiaAPI (contract)', () => {
  const api = getApi();
  it('getAcquirerScore is deterministic 87/67', async () => {
    expect((await api.getAcquirerScore('anthropic')).total).toBe(87);
    expect((await api.getAcquirerScore('salesforce')).total).toBe(67);
  });
  it('runSkill returns locked for the premium skill', async () => {
    const r = await api.runSkill('synergy-engine', 'anthropic');
    expect(r.locked).toBe(true);
  });
  it('runSkill returns a panel for a free skill', async () => {
    const r = await api.runSkill('acquirer-fit', 'anthropic');
    expect(r.locked).toBe(false);
    if (!r.locked) expect(r.panel.kind).toBe('scoreBreakdown');
  });
  it('sendMessage blocks profanity, delivers clean', async () => {
    const bad = await api.sendMessage({ fromId:'md', toId:'advisor', body:'fuck you' });
    expect(bad.delivered).toBe(false);
    const ok = await api.sendMessage({ fromId:'md', toId:'cfo', body:'financials attached' });
    expect(ok.delivered).toBe(true);
  });
});
```

- [ ] **Run → expect FAIL.**
- [ ] **Implement** `src/lib/api/mock.ts`: a class implementing `ConductiaAPI`. `getAcquirerScore` looks up the acquirer in `fixtures` and returns `computeCompositeScore(fitInputs)`. `runSkill` returns `{locked:true}` if `skills.find(...).premium`, else `{locked:false, panel}` where panel kind = the skill's `panel` field (financialMatrix→`{kind:'financialMatrix',company}`, cultureRadar→`{kind:'cultureRadar',factors}`, scoreBreakdown→`{kind:'scoreBreakdown',score}`). `checkMessageCompliance`/`sendMessage` delegate to `checkMessage`; `delivered = result.status==='clear'`. Add a tiny `await delay(450)` in `runSkill` and `sendMessage` to make the compliance animation legible.
- [ ] **Implement** `src/lib/api/index.ts`: `import { MockConductiaAPI } from './mock'; let _api:ConductiaAPI|null=null; export function getApi(){ return _api ??= new MockConductiaAPI(); }` — **the single swap point**.
- [ ] **Run → expect PASS.**
- [ ] Commit `feat: mock ConductiaAPI + provider seam`.

### Task 1.7: Session store (stage machine)

**Files:** Create `src/lib/session/store.ts`, `tests/session.test.ts`

- [ ] **Write failing test** `tests/session.test.ts` asserting a pure reducer:

```ts
import { describe, it, expect } from 'vitest';
import { sessionReducer, initialSession, STAGE_ORDER } from '../src/lib/session/store';

describe('sessionReducer', () => {
  it('advances through STAGE_ORDER and never past the end', () => {
    let s = initialSession;
    for (const _ of STAGE_ORDER) s = sessionReducer(s, { type:'NEXT' });
    expect(s.stage).toBe(STAGE_ORDER[STAGE_ORDER.length-1]);
  });
  it('adds canvas panels and sets compliance status', () => {
    let s = sessionReducer(initialSession, { type:'ADD_PANEL', panel:{ kind:'cultureRadar', factors:{vision:1,mission:1,founder:1,headcount:1,industry:1,product:1,culture:1} } });
    expect(s.panels).toHaveLength(1);
    s = sessionReducer(s, { type:'SET_COMPLIANCE', status:'scanning' });
    expect(s.complianceStatus).toBe('scanning');
  });
});
```

- [ ] **Run → expect FAIL.** Then implement `store.ts`: `STAGE_ORDER:Stage[] = ['coldOpen','intent','landscape','deepDive','complianceTheatre','pitchCta']`; `initialSession = { stage:'coldOpen', complianceStatus:'idle', panels:[] as PanelData[] }`; pure `sessionReducer`; plus a thin React context `SessionProvider` + `useSession()` wrapping `useReducer`.
- [ ] **Run → expect PASS.**
- [ ] Commit `feat: session stage machine + context`.

### Phase 1 verification gate
- [ ] `npm test` → all green; `npx tsc --noEmit` clean; `npm run build` OK.
- [ ] Update `master.md`: Phase 1 ☑ + change-log entry w/ commit hash. Commit `chore(ledger): phase 1 verified`.

---

## Phase 2 — Compliance ribbon + orchestrator shell

### Task 2.1: Brand primitives

**Files:** Create `src/components/primitives/{Button,Card,Badge,Pill,ScoreDial}.tsx`, extend `src/app/globals.css` with brand tokens from `docs/04-brand/visual-language.md`.

- [ ] Implement 5 primitives. `ScoreDial` props: `{ value:number; size?:number; label?:string }` → circular dial 0–100, animated sweep (Framer Motion) on mount.
- [ ] Acceptance: a throwaway `/__primitives` route renders all 5; `ScoreDial value={87}` shows 87 with full sweep. Render test: `ScoreDial` shows the number.
- [ ] Commit `feat: brand primitives`.

### Task 2.2: ComplianceRibbon

**Files:** Create `src/components/compliance/ComplianceRibbon.tsx`; mount in `src/app/layout.tsx`.

- [ ] Props: none — reads `useSession().complianceStatus`. Renders fixed top ribbon with 4 visual states: `idle` (calm, "Compliance monitoring active"), `scanning` (animated scanline + "Checking…"), `clear` (green ✓ pulse), `blocked` (red ✕ + reason text from session). Transitions ≤400ms (motion-language doc).
- [ ] Acceptance: render test mounts provider, dispatches each status, asserts the status label text present. Visually: scanline animates in `scanning`.
- [ ] Commit `feat: compliance ribbon`.

### Task 2.3: Stage orchestrator + guided controls

**Files:** Modify `src/app/page.tsx`, `src/app/layout.tsx`; create `src/components/shell/GuidedControls.tsx`.

- [ ] `layout.tsx`: wrap children in `<SessionProvider>`, mount `<ComplianceRibbon/>`.
- [ ] `page.tsx`: `switch(useSession().stage)` → render the matching `stages/*` component (stub each as a labeled placeholder for now). `GuidedControls`: fixed "Next ▸ / ◂ Back" that dispatch `NEXT`/`BACK` (present for the guided run; hideable via `?present=1`).
- [ ] Acceptance: clicking Next walks coldOpen→…→pitchCta; ribbon persists; render test drives the walk.
- [ ] Commit `feat: stage orchestrator + guided controls`.

### Phase 2 gate
- [ ] tsc clean, build OK, walk works. Update `master.md` Phase 2 ☑. Commit ledger.

---

## Phase 3 — Spine screens (parallel subagents)

Each task is an independent stage component consuming `getApi()` + `useSession()`. Dispatch one subagent each, fed `master.md` + spec §5 + the task.

### Task 3.1: ColdOpen stage

**Files:** Create `src/components/stages/ColdOpen.tsx`

- [ ] Contract: full-bleed "logged in as **Mike Cannon-Brookes — Atlassian**" identity card (data via `getApi().getSeller()`), pre-onboarded framing, no onboarding UI. Ribbon already `idle`. A single primary CTA dispatches `NEXT`.
- [ ] Acceptance: shows seller name + tagline from fixtures; CTA advances to `intent`. Render test asserts "Atlassian" present.
- [ ] Commit `feat: stage cold open`.

### Task 3.2: Intent stage

**Files:** Create `src/components/stages/Intent.tsx`

- [ ] Contract: command bar pre-filled *"I'm exploring a sale of Atlassian."* On submit: dispatch `SET_COMPLIANCE 'scanning'`, await an 1100ms scripted compliance-boot sequence (cascading checklist: KYC ✓, FINRA 2210 ✓, MNPI guard ✓), then `SET_COMPLIANCE 'clear'` and `NEXT` to `landscape`.
- [ ] Acceptance: submit triggers ribbon scanning→clear then lands on landscape; render test asserts the three checklist items render.
- [ ] Commit `feat: stage intent + compliance boot`.

### Task 3.3: Landscape stage + AcquirerCard + PeerStrip

**Files:** Create `src/components/stages/Landscape.tsx`, `src/components/acquirers/{AcquirerCard,AcquirerLandscape,PeerStrip}.tsx`

- [ ] `AcquirerCard` props `{ acquirer:Acquirer; score:CompositeScore; onSelect:()=>void }` → name, one-line "why", `ScoreDial value={score.total}`. `PeerStrip` props `{ peers:Company[] }` → compact revenue/headcount/growth row (Figma/Canva). `Landscape` loads `getAcquirers()` + `getAcquirerScore(id)` for each, renders ranked (desc by total) grid + `PeerStrip` from `getPeers()`. Anthropic shows **87**, Salesforce **67** (from the module — assert in test). Selecting an acquirer sets `selectedAcquirerId` in session and dispatches `NEXT` → `deepDive`.
- [ ] Acceptance: render test asserts a card with "87" and one with "67" and ≥5 cards, sorted desc.
- [ ] Commit `feat: stage acquirer landscape + peer strip`.

### Phase 3 gate
- [ ] Integrate inline: walk steps 1→3 clean. Update `master.md` Phase 3 ☑. Commit ledger.

---

## Phase 4 — Hero canvas (the wow beat)

### Task 4.1: SkillShelf + SkillCard

**Files:** Create `src/components/skills/{SkillShelf,SkillCard}.tsx`

- [ ] `SkillCard` props `{ skill:Skill; draggable:boolean }` — draggable via HTML5 DnD (`dataTransfer.setData('skillId', id)`); premium skill shows a lock glyph. `SkillShelf` loads `getApi().getSkills()`, renders the 5 as a side rail.
- [ ] Acceptance: render test shows 5 skills, one with lock. Commit `feat: skill shelf`.

### Task 4.2: Canvas drop + transform→compliance→panel

**Files:** Create `src/components/skills/Canvas.tsx`

- [ ] Contract: drop target. On drop of `skillId`: (1) `SET_COMPLIANCE 'scanning'`; (2) show a "transform stream" animation ~700ms (motion-language); (3) `await getApi().runSkill(skillId, selectedAcquirerId)`; (4) if `locked` → emit `onLocked(skill)` (Task 4.4) and `SET_COMPLIANCE 'idle'`, render nothing; (5) else `SET_COMPLIANCE 'clear'`, `ADD_PANEL(panel)`. Panels render stacked in drop order.
- [ ] Acceptance: dropping `acquirer-fit` adds a scoreBreakdown panel after ribbon scanning→clear; render/integration test simulates a drop and asserts a panel appears.
- [ ] Commit `feat: canvas drop + compliance-gated skill run`.

### Task 4.3: The three panels

**Files:** Create `src/components/panels/{FinancialMatrixPanel,CultureRadarPanel,ScoreBreakdownPanel}.tsx`

- [ ] `FinancialMatrixPanel` props `{ company:Company }` — valuation/revenue/growth/EBITDA/cash/headcount tiles. `CultureRadarPanel` props `{ factors:CultureFactors }` — 7-axis radar (SVG, animated draw). `ScoreBreakdownPanel` props `{ score:CompositeScore }` — `ScoreDial` + the `breakdown[]` bars + compliance ✓ stamp.
- [ ] Acceptance: render tests with sample props show the key numbers; radar renders 7 axes. Commit `feat: analysis panels`.

### Task 4.4: PaywallLock beat

**Files:** Create `src/components/team/PaywallLock.tsx`; wire into Canvas `onLocked`.

- [ ] Contract: on `onLocked(skill)` show an elegant modal: "{skill.name} is a Pro skill" + "Upgrade to Pro" (inert button) + tasteful lock motion. Dismiss returns to canvas.
- [ ] Acceptance: dropping `synergy-engine` opens the paywall, no panel added; render test asserts modal copy. Commit `feat: premium paywall beat`.

### Task 4.5: DeepDive stage assembly

**Files:** Create `src/components/stages/DeepDive.tsx`

- [ ] Compose: header (selected acquirer + live `ScoreDial`), `SkillShelf` rail, `Canvas`. A "Continue ▸" CTA dispatches `NEXT` → `complianceTheatre`.
- [ ] Acceptance: full step-4/5 flow works end to end (drop free skill → panel; drop premium → paywall). Commit `feat: stage acquirer deep-dive`.

### Phase 4 gate
- [ ] Polish pass (subagent): motion timing, empty canvas hint. Update `master.md` Phase 4 ☑. Commit ledger.

---

## Phase 5 — Compliance theatre

### Task 5.1: TeamDrawer + MessageComposer

**Files:** Create `src/components/team/{TeamDrawer,MessageComposer}.tsx`, `src/components/stages/ComplianceTheatre.tsx`

- [ ] `TeamDrawer` loads `getApi().getTeam()` → 3 profiles (MD/CFO/Advisor). `MessageComposer` props `{ toId:string }`: textarea + Send. On Send: `SET_COMPLIANCE 'scanning'`, `await getApi().sendMessage({fromId:'md',toId,body})`, then if `delivered` → `SET_COMPLIANCE 'clear'` + show message in thread; else `SET_COMPLIANCE 'blocked'` + show inline "Blocked" card with `compliance.reasons[0]`, message NOT added to thread.
- [ ] Two scripted prefill buttons: "Clean message" → `Financials attached for your review.`; "Risky message" → `here are the financials, and honestly, fuck you`.
- [ ] `ComplianceTheatre` stage composes drawer + composer; "Continue ▸" → `NEXT` → `pitchCta`.
- [ ] Acceptance: integration test — clean message delivers + appears; risky message blocked + reason shown + absent from thread; ribbon hits `blocked`.
- [ ] Commit `feat: stage compliance theatre`.

### Phase 5 gate
- [ ] Update `master.md` Phase 5 ☑. Commit ledger.

---

## Phase 6 — Motion polish, CTA, deploy

### Task 6.1: PitchCta stage (inert)

**Files:** Create `src/components/stages/PitchCta.tsx`

- [ ] Contract: summary of the journey + a prominent **"Begin Pitch Preparation"** button that is visibly inert with caption "Next session". Clicking shows a subtle "Coming next week" toast. No navigation.
- [ ] Acceptance: button present, does not advance/crash. Commit `feat: stage pitch-prep CTA (inert)`.

### Task 6.2: Motion + graceful-stub pass

**Files:** Modify stage/panel components per `docs/04-brand/motion-language.md`.

- [ ] Apply the three named motions consistently (compliance pulse, transform stream, score reveal). Any non-golden-path control renders a captioned "Not in this demo" stub (never a crash). `?present=1` hides `GuidedControls`.
- [ ] Acceptance: a single manual run of the full golden path shows no jank, no dead clicks, no console errors. Record the run in `master.md` change log.
- [ ] Commit `polish: motion language + graceful stubs`.

### Task 6.3: Deploy config

**Files:** Create `vercel.json` (if needed); verify `npm run build`.

- [ ] Ensure production build is clean and static-friendly. Document deploy steps in `docs/03-engineering/sandbox-vs-production.md`. **Do NOT deploy or create remote** — that is Lance's checkpoint (D3); Phase 7 hands off commands.
- [ ] Commit `chore: production build config`.

### Phase 6 gate
- [ ] Update `master.md` Phase 6 ☑. Commit ledger.

---

## Phase 7 — Verification swarm + hand-off

### Task 7.1: Spec-coverage swarm

- [ ] Dispatch parallel reviewers (one per spec §3 success criterion + one per wow beat). Each returns PASS/FAIL + evidence. Aggregate into `docs/superpowers/plans/2026-05-19-intellibank-sandbox/verification-round-1.md`.
- [ ] Surgical fix pass on any FAIL (smallest correct change; re-verify). Commit fixes individually.

### Task 7.2: Golden-path dry-run

- [ ] Full scripted run following `docs/05-growth/demo-script.md`; confirm each of the 7 steps + 3 wow beats. Log result in `master.md`.

### Task 7.3: Lance hand-off

- [ ] Append to `master.md` the exact remote commands for Lance to run himself (do not execute):

```bash
gh repo create Lance-fp/intellibank --private --source=. --remote=origin --push=false
git -C <repo> remote set-url origin git@github.com-fp:Lance-fp/intellibank.git
git -C <repo> push -u origin main
gh repo edit Lance-fp/intellibank --add-collaborator <martin-username>   # when received
```

- [ ] Update `master.md`: all phases ☑, final change-log entry. Commit `chore(ledger): build complete, awaiting Lance remote checkpoint`.

---

## Self-review (run by author)

**Spec coverage** — every spec §3 IN item maps to a task: golden path 1–7 → Tasks 3.1/3.2/3.3/4.5/5.1/6.1; hero canvas 3–4 skills + 1 premium → 4.1–4.5; instrumented compliance ribbon → 2.2 + every stage's `SET_COMPLIANCE`; team drawer + block beat → 5.1; deterministic 87/67 → 1.3/1.4/1.6 (asserted); deployed URL → 6.3 + 7.3 hand-off; full `/docs` foundation → Phase 0; repo + CLAUDE.md → already committed (foundation); durable ledger + verification + anti-context-loss (spec §12) → `master.md` + every phase gate. Deferred/out items have NO tasks (correct). No gaps.

**Placeholder scan** — logic tasks contain full code; UI tasks contain exact props, the precise `ConductiaAPI` call, enumerated states, and concrete acceptance checks. No "TBD/TODO/handle edge cases". The only "provisional" item (skills catalog, Task 0.3) is explicitly bound to `fixtures.ts` ids in Task 1.3 — consistent, not vague.

**Type consistency** — names are fixed in the Type contract block and reused verbatim: `FitInputs/CompositeScore/computeCompositeScore/checkMessage/getApi/sessionReducer/STAGE_ORDER/PanelData` kinds (`financialMatrix|cultureRadar|scoreBreakdown`), `ComplianceStatus` values (`idle|scanning|clear|blocked`), `Stage` order. Tasks 1.4/1.6 use the same sub-score formula as Task 0.3 `matrices.md`. Consistent.

No issues requiring a re-review. Plan is execution-ready.
