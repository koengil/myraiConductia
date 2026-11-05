'use client';

import { ComplianceRibbon } from '@/components/compliance/ComplianceRibbon';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { DealContextBar } from '@/components/shell/DealContextBar';
import type { PerspectiveId } from '@/lib/perspective/access';

/**
 * TopBar — a slim workspace bar. The demo scaffolding (perspective switcher
 * SD/MC/DC, and the palette + light/dark switchers) was removed in the 2026-07-09
 * product pass: this is a single, real product for the managing director, not a
 * showroom. Per-conversation chrome (title) lives on the chat surface.
 *
 * The compliance instrument rides INLINE on the right of this bar (Lance
 * 2026-07-09) — the standalone strip below the bar was removed to reclaim the
 * space. This is the single [data-compliance-status] ComplianceRibbon; routes
 * dispatch SET_COMPLIANCE and it projects here on project routes, beside the
 * notifications bell.
 */
export interface TopBarProps {
  inProject: boolean;
  workspaceLabel?: string;
  perspective?: PerspectiveId;
}

export function TopBar({ inProject, workspaceLabel = 'Workspace' }: TopBarProps) {
  return (
    <header
      className="sticky top-0 z-30 flex min-h-[56px] shrink-0 items-center justify-between gap-[var(--space-4)] border-b border-[var(--stroke)] px-6 py-1.5"
      style={{ background: 'var(--surface-warm)' }}
    >
      {/* Left — inside a deal: the single deal-context bar (which deal + switch +
          progress + spend). Off-deal: a plain workspace label. */}
      {inProject ? (
        <DealContextBar />
      ) : (
        <p
          className="text-[11px] font-medium"
          style={{ color: 'var(--ink-tertiary)' }}
        >
          {workspaceLabel}
        </p>
      )}
      {/* Right — notifications (all authed surfaces) + the single live
          [data-compliance-status] ComplianceRibbon as the workbench pill
          (project routes only; kit §08 — white idle pill, pastel verdicts). */}
      <div className="flex shrink-0 items-center gap-[var(--space-3)]">
        {inProject ? <ComplianceRibbon /> : null}
        <NotificationsBell />
      </div>
    </header>
  );
}

export default TopBar;
