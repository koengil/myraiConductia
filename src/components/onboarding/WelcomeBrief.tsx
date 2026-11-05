import Link from 'next/link';
import { DEAL_ROLE_LABELS } from '@/lib/constants/roles';
import { accessPhaseName } from '@/lib/team/accessPhase';
import type { Perimeter } from '@/lib/perimeter/perimeter';

/**
 * The personalized welcome brief on the scoped external deal home
 * (criteria C1-C11).
 *
 * A live reading, not a snapshot. The SHAPE is stable across visits so the page
 * stays recognisable; every VALUE is recomputed from current server data on each
 * render, so a phase raise or a new release shows up on the next visit without
 * anything being invalidated (C1, C3).
 *
 * Every offered action is one this viewer may actually take. An action they
 * cannot complete is worse than no action: it teaches them the platform is
 * guessing.
 */

export type WelcomeBriefProps = {
  /** URL segment used for links, which may be the deal code rather than the id. */
  projectId: string;
  deal: { code: string; codename: string; status: string };
  companyName: string;
  dealRole: string | null;
  phase: number;
  /**
   * Already computed by the host page, which has the admin client and has
   * already proven membership. `null` means the read failed — rendered as an
   * honest unavailable line, never as "no documents".
   */
  perimeter: Perimeter | null;
};

/**
 * Synchronous and presentational on purpose. The page awaits the perimeter and
 * passes it in, which keeps the data reads where the membership wall already
 * lives and leaves this component directly renderable in a test.
 */
export function WelcomeBrief({
  projectId,
  deal,
  companyName,
  dealRole,
  phase,
  perimeter,
}: WelcomeBriefProps) {
  const roleLabel = dealRole
    ? (DEAL_ROLE_LABELS[dealRole as keyof typeof DEAL_ROLE_LABELS] ?? dealRole)
    : 'Observer';

  // Ordered, and filtered to what this seat actually carries (C6-C8).
  //
  // Data Room and Team are unconditional: they are destinations this seat holds,
  // and an empty room is still a room. Hiding the link when the count is zero
  // would tell the invitee they lack access they actually have. Only the
  // CAPABILITY actions below are gated.
  const actions: { href: string; label: string; hint: string }[] = [];
  actions.push({
    href: `/projects/${projectId}/data-room`,
    label: 'Data Room',
    hint:
      perimeter === null
        ? 'Documents shared with your side, gated by phase.'
        : perimeter.documents.total === 0
          ? 'Nothing released to your phase yet.'
          : `${perimeter.documents.total} document${perimeter.documents.total === 1 ? '' : 's'} available to you.`,
  });
  if (perimeter?.capabilities.canUploadToDataRoom) {
    actions.push({
      href: `/projects/${projectId}/data-room`,
      label: 'Upload a document',
      hint: 'Your seat carries upload rights on this deal.',
    });
  }
  actions.push({
    href: `/projects/${projectId}/team`,
    label: 'Team',
    hint: 'The deal team and your firm’s seats.',
  });
  if (perimeter?.capabilities.canInviteTeammate) {
    actions.push({
      href: `/projects/${projectId}/team`,
      label: 'Invite a teammate',
      hint: 'You can add people at your own company.',
    });
  }

  return (
    <section data-testid="welcome-brief" style={{ marginTop: 'var(--space-4)' }}>
      {/* What this seat can see, by phase name as Team shows it. No deal code,
          no raw status and no phase number. */}
      <p
        style={{
          fontSize: 'var(--text-xs)',
          color: 'var(--ink-secondary)',
        }}
      >
        Access up to {accessPhaseName(phase)}
      </p>

      {/* The deal codename IS deal identity — the one sanctioned serif moment
          on this screen (workbench kit §01). Styling only; copy frozen. */}
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(20px, 2.2vw, 24px)',
          fontWeight: 400,
          lineHeight: 1.2,
          marginTop: 'var(--space-1)',
          color: 'var(--ink)',
        }}
      >
        {deal.codename}
      </h2>

      <p style={{ marginTop: 'var(--space-2)', color: 'var(--ink-secondary)' }}>
        You are seated for {companyName} as {roleLabel}. Every document action is logged.
      </p>

      {perimeter ? (
        <p style={{ marginTop: 'var(--space-2)' }}>
          {perimeter.documents.total === 0
            ? // C11: honest empty. No fabricated count, no invented task.
              'No documents have been released to your seat yet. This page will show them when they are.'
            : `${perimeter.documents.total} document${perimeter.documents.total === 1 ? '' : 's'} ${
                perimeter.documents.total === 1 ? 'is' : 'are'
              } available to you right now.`}
        </p>
      ) : (
        <p role="status" style={{ marginTop: 'var(--space-2)', color: 'var(--ink-secondary)' }}>
          Your document access could not be read just now. Nothing has changed about your seat.
        </p>
      )}

      <ul
        style={{
          marginTop: 'var(--space-3)',
          display: 'grid',
          gap: 'var(--space-2)',
          listStyle: 'none',
          padding: 0,
        }}
      >
        {actions.map((action) => (
          <li key={`${action.label}-${action.href}`}>
            <Link
              href={action.href}
              className="border border-[var(--stroke)] bg-[var(--surface)] transition-colors duration-150 hover:border-[var(--stroke-strong)] hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
              style={{
                display: 'block',
                borderRadius: 'var(--radius-card)',
                padding: 'var(--space-3)',
                textDecoration: 'none',
                color: 'var(--ink)',
              }}
            >
              <span style={{ fontWeight: 600 }}>{action.label}</span>
              <span style={{ display: 'block', color: 'var(--ink-secondary)', fontSize: 'var(--text-sm)' }}>
                {action.hint}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default WelcomeBrief;
