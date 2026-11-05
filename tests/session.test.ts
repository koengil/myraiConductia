import { describe, it, expect } from 'vitest';
import { sessionReducer, initialSession, STAGE_ORDER } from '../src/lib/session/store';

const cultureFactors = {
  dataKind: 'cultureFactors' as const,
  factors: { vision:1, mission:1, founder:1, headcount:1, industry:1, product:1, culture:1 },
};
const compositeScore = {
  dataKind: 'compositeScore' as const,
  score: { total: 87, financialSub: 84, cultureSub: 91, breakdown: [], compliancePassed: true },
};

describe('sessionReducer', () => {
  it('advances through STAGE_ORDER and never past the end', () => {
    let s = initialSession;
    for (let i = 0; i < STAGE_ORDER.length; i++) s = sessionReducer(s, { type:'NEXT' });
    expect(s.stage).toBe(STAGE_ORDER[STAGE_ORDER.length-1]);
  });
  it('adds canvas panels and sets compliance status', () => {
    // ADD_PANEL tags each panel with its source skill (id + name) so the
    // canvas can dedupe by skillId, expose a per-panel remove affordance,
    // and render skills that share a dataShape distinctly. The wire
    // contract `SkillRunData` is untouched — the source-skill tag is
    // session-store-only metadata.
    let s = sessionReducer(initialSession, {
      type: 'ADD_PANEL', skillId: 'culture-signal', skillName: 'Culture Signal', panel: cultureFactors,
    });
    expect(s.panels).toHaveLength(1);
    expect(s.panels[0].skillId).toBe('culture-signal');
    expect(s.panels[0].skillName).toBe('Culture Signal');
    expect(s.panels[0].data).toEqual(cultureFactors);
    s = sessionReducer(s, { type: 'SET_COMPLIANCE', status: 'scanning' });
    expect(s.complianceStatus).toBe('scanning');
  });
  it('dedupes ADD_PANEL by skillId — dropping the same skill twice is a no-op', () => {
    const once = sessionReducer(initialSession, {
      type: 'ADD_PANEL', skillId: 'acquirer-fit', skillName: 'Acquirer Fit', panel: compositeScore,
    });
    const twice = sessionReducer(once, {
      type: 'ADD_PANEL', skillId: 'acquirer-fit', skillName: 'Acquirer Fit', panel: compositeScore,
    });
    expect(twice.panels).toHaveLength(1);
    // Reference equality — the duplicate dispatch must return the same state.
    expect(twice).toBe(once);
  });
  it('keeps acquirer-fit and deal-readiness as distinct panels', () => {
    // The bug this guards: both skills share `dataShape: 'compositeScore'`.
    // Tagging panels by skillId is what keeps them addressable separately.
    let s = sessionReducer(initialSession, {
      type: 'ADD_PANEL', skillId: 'acquirer-fit', skillName: 'Acquirer Fit', panel: compositeScore,
    });
    s = sessionReducer(s, {
      type: 'ADD_PANEL', skillId: 'deal-readiness', skillName: 'Deal Readiness', panel: compositeScore,
    });
    expect(s.panels.map((p) => p.skillId)).toEqual(['acquirer-fit', 'deal-readiness']);
  });
  it('REMOVE_PANEL drops the matching skillId and leaves the rest', () => {
    let s = sessionReducer(initialSession, {
      type: 'ADD_PANEL', skillId: 'acquirer-fit', skillName: 'Acquirer Fit', panel: compositeScore,
    });
    s = sessionReducer(s, {
      type: 'ADD_PANEL', skillId: 'culture-signal', skillName: 'Culture Signal', panel: cultureFactors,
    });
    s = sessionReducer(s, { type: 'REMOVE_PANEL', skillId: 'acquirer-fit' });
    expect(s.panels.map((p) => p.skillId)).toEqual(['culture-signal']);
  });
});
