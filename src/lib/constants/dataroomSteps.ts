// Rail step_ids that receive a Box-backed dataroom folder. These align with the
// canonical census in src/lib/rail/dealRail.ts (not a second step table).

export const DATAROOM_STEP_DEFS: ReadonlyArray<{
  stepId: string;
  label: string;
  requiresUpload: boolean;
  minPhase: number;
}> = [
  {
    stepId: 'p1-s9',
    label: 'MD Briefing',
    requiresUpload: true,
    minPhase: 0,
  },
  {
    stepId: 'p2-s31',
    label: 'Data room index',
    requiresUpload: true,
    minPhase: 2,
  },
  {
    stepId: 'p2-s32',
    label: 'Document intake',
    requiresUpload: true,
    minPhase: 0,
  },
  {
    stepId: 'p3-s43',
    label: 'Buyer VDR access',
    requiresUpload: false,
    minPhase: 2,
  },
  {
    stepId: 'p3-s45',
    label: 'Diligence Q&A',
    requiresUpload: true,
    minPhase: 3,
  },
];
