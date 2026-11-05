'use client';

import * as React from 'react';
import type { Skill } from '../../lib/api/types';
import { Button, Badge } from '@/components/atoms';
import { Dialog, useRetainedWhileClosing } from '@/components/overlay';

export type PaywallLockProps = {
  skill: Skill | null;
  onClose: () => void;
};

/*
 * Paywall beat (docs/02-product/experience-spine.md § Step 5): "Drag it to
 * the canvas → an elegant lock modal appears: '{Skill Name} is a Pro skill.
 * Upgrade to Pro.' The upgrade button is present but inert in the demo. No
 * panel is added to the canvas." A locked skill makes visible that skill
 * access is the value metric, not analyst seats
 * (docs/01-business/monetization-and-skills-economy.md § 1).
 *
 * Built on the shared Dialog: one scrim, one enter and exit motion (fade only
 * under reduced motion), named by its title "{name} is a Pro skill". Kept
 * mounted and toggled, so the exit plays; the skill is held through it.
 * Upgrade is inert and says so in a status line. Close, Escape and a scrim
 * click close it.
 */
export function PaywallLock({ skill, onClose }: PaywallLockProps) {
  const shown = useRetainedWhileClosing(skill);
  const [noticeForSkillId, setNoticeForSkillId] = React.useState<string | null>(
    null,
  );
  const notice = shown != null && noticeForSkillId === shown.id;

  return (
    <Dialog
      open={skill != null}
      onClose={onClose}
      title={shown ? `${shown.name} is a Pro skill` : ''}
    >
      {shown ? (
        <div className="flex flex-col gap-[var(--space-4)]">
          <div className="flex items-center gap-[var(--space-3)]">
            <span
              aria-hidden="true"
              className="inline-flex h-11 w-11 items-center justify-center rounded-[var(--radius-card)] bg-[var(--surface-subtle)] text-[var(--ink-secondary)]"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="4" y="10.5" width="16" height="10" rx="2" />
                <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                <circle cx="12" cy="15.5" r="1.25" />
              </svg>
            </span>
            <Badge tone="accent">Pro skill</Badge>
          </div>
          <p className="font-sans text-[length:var(--text-base)] leading-relaxed text-[var(--ink-secondary)]">
            No feature is hidden. It is one skill away. Skill access is the
            value metric. The rest of the canvas stays on your current plan.
          </p>
          <div className="flex flex-col gap-[var(--space-3)]">
            <Button
              variant="primary"
              size="md"
              onClick={() => setNoticeForSkillId(shown.id)}
            >
              Upgrade to Pro
            </Button>
            {notice ? (
              <p
                role="status"
                className="font-sans text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
              >
                Plan management ships with the next release.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export default PaywallLock;
