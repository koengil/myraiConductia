'use client';

import * as React from 'react';
import { Users } from 'lucide-react';

import {
  outsideViewerAccessText,
  parseAccessMembers,
  whoHasAccessText,
  type AccessKind,
  type AccessMember,
} from '@/lib/dataroom/whoHasAccess';

/**
 * The "Who has access" line under the Deal Folder and Data Room headers. Reads
 * the existing deal roster; a failed read keeps the line honest ("could not be
 * loaded") instead of guessing.
 *
 * Bank side only, failing closed like the Deal Folder note: an
 * outside viewer, or one whose profile has not loaded, reads only their own
 * firm and the bank's deal team, and the roster is not read for them. The
 * roster API itself still returns every seat to outside parties (handoff E25).
 */
export function WhoHasAccess({
  dealId,
  kind,
  bankSide,
  ownFirm,
}: {
  dealId: string;
  kind: AccessKind;
  /** True only once the profile has loaded and says the viewer is bank-side. */
  bankSide: boolean;
  /** An outside viewer's own firm name, when the profile carries it. */
  ownFirm?: string | null;
}) {
  const [state, setState] = React.useState<{
    dealId: string;
    members: AccessMember[] | null;
    failed: boolean;
  }>({ dealId, members: null, failed: false });

  React.useEffect(() => {
    if (!bankSide) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/v1/deals/${dealId}/members`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error('roster');
        const members = parseAccessMembers(await res.json());
        if (cancelled) return;
        setState({ dealId, members, failed: members === null });
      } catch {
        if (!cancelled) setState({ dealId, members: null, failed: true });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [dealId, bankSide]);

  const current = state.dealId === dealId ? state : { dealId, members: null, failed: false };
  const text = !bankSide
    ? outsideViewerAccessText(ownFirm)
    : current.failed
      ? 'Who has access on this deal: the deal team could not be loaded.'
      : whoHasAccessText(kind, current.members);

  return (
    <p
      data-testid="who-has-access"
      className="flex items-start gap-[6px] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
    >
      <Users size={14} aria-hidden className="mt-[3px] shrink-0 text-[var(--ink-tertiary)]" />
      <span>{text}</span>
    </p>
  );
}
