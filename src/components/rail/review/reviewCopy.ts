import { plural } from '@/lib/skillRun/revisionView';

import type { ReviewStatus } from './useRunRevisions';

export const REVIEW_COPY = {
  open: 'Review output',
  title: 'Review output',
  document: 'Output',
  applying: 'Applying. This can take a minute.',
  readOnly: 'This is an earlier version. It is read-only.',
  restore: 'Restore this version',
  earlier: 'Earlier version',
  later: 'Later version',
  composer: 'Edit this passage',
  comment: 'Comment',
  editText: 'Edit text',
  commentLabel: 'What should change in this passage',
  textLabel: 'Passage text, in Markdown',
  addComment: 'Add comment',
  updateComment: 'Update comment',
  saveEdit: 'Save edit',
  updateEdit: 'Update edit',
  cancel: 'Cancel',
  remove: 'Remove',
  edit: 'Edit',
  pending: 'Pending',
  changed: 'Changed in this version',
  editedByHand: 'Edited by hand',
  rewritten: 'Rewritten from a comment',
  notApplied: 'Not applied',
  teach: 'Teach the skill',
  teachHelp: 'For rules everyone on this project should get, not fixes to this document.',
  teachesSkill: 'Teaches skill',
  showBefore: 'Show before',
  hideBefore: 'Hide before',
  discard: 'Discard pending edits',
  close: 'Close',
  applyNone: 'Apply edits',
  emptyPending: 'Select a passage to comment on it or edit it.',
  firstOutput: "This is the run's first output.",
  loadingVersion: 'Loading this version.',
  versionUnavailable: 'This version could not be loaded.',
  skillNotMounted:
    'The skill version this run used was not available, so these edits were made without it.',
  reviseLabel: 'What should change?',
  reviseEmpty: 'This draft has no text to change.',
  reviseHint:
    'Type it in your own words. For example: "Cut the opening to two sentences." "Lead with the strategic fit for buyers." "Drop the paragraph on valuation."',
  keyboardHint:
    'Use the arrow keys to move between passages. Press Enter to comment on a passage or edit it.',
} as const;

export function teachNote(count: number, canTeach: boolean): string {
  const verb = count === 1 ? 'is' : 'are';
  const next = canTeach
    ? "use Teach the skill to update this step's skill for everyone on this project"
    : "someone who may improve this step's skill can use Teach the skill to update it for everyone on this project";
  return `${plural(count, 'comment')} ${verb} marked to teach the skill. After applying, ${next}. Leave a comment unticked when it only fixes this document.`;
}

/** The free-text revise button says what it does: it records the next version. */
export function reviseButton(nextVersion: number): string {
  return `Create version ${String(nextVersion)}`;
}

export function teachButton(count: number): string {
  return `${REVIEW_COPY.teach} · ${plural(count, 'comment')}`;
}

export function statusLine(status: ReviewStatus): string | null {
  if (status.kind === 'idle') return null;
  return status.kind === 'applying' ? REVIEW_COPY.applying : status.message;
}
