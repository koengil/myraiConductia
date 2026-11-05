import type {
  TemplateChangeDecision,
  TemplateChangeSet,
} from '@/lib/railTemplates/changeReview';

export const TEMPLATE_CHANGE_SET: TemplateChangeSet = {
  template: { id: 'template-1', name: 'Standard sell-side' },
  baseRevision: { id: 'revision-3', label: 'v3', savedAt: '2026-09-02T15:00:00.000Z' },
  currentRevision: {
    id: 'revision-4',
    label: 'v4',
    savedAt: '2026-09-30T15:00:00.000Z',
    savedBy: { id: 'user-storm', name: 'Storm Duncan' },
  },
  changes: [
    {
      id: 'added:custom-fairness',
      kind: 'added',
      title: 'Fairness opinion',
      summary: 'Independent fairness opinion from a qualified adviser before board approval.',
      phaseIndex: 4,
      anchor: { position: 'after', stepId: 'p4-s50' },
      decision: null,
    },
    {
      id: 'added:custom-sanctions',
      kind: 'added',
      title: 'Sanctions re-screen before signing',
      summary: 'Re-run KYC and sanctions screening on the counterparty within 10 days of signing.',
      phaseIndex: 5,
      anchor: null,
      decision: null,
    },
    {
      id: 'removed:p5-s53',
      kind: 'removed',
      stepId: 'p5-s53',
      title: 'LinkedIn Post',
      phaseIndex: 5,
      decision: null,
    },
  ],
};

export function decided(
  changeSet: TemplateChangeSet,
  decisions: Record<string, TemplateChangeDecision | null>,
): TemplateChangeSet {
  return {
    ...changeSet,
    changes: changeSet.changes.map((change) =>
      change.id in decisions ? { ...change, decision: decisions[change.id] } : change,
    ),
  };
}
