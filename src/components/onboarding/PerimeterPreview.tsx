'use client';

import type { DestinationId } from '@/lib/perspective/access';
import { DESTINATION_TITLES } from '@/lib/perspective/destinationTitles';

import { boundKeyOf, useBoundRequest } from './useBoundRequest';

/**
 * "What they can see": the live, server-authoritative access perimeter
 * (criteria B1-B13). Code keeps the word perimeter; the screen never shows it.
 *
 * The client renders; it never computes. Nothing here recomputes access from
 * role names or caches a verdict, because a second implementation is exactly
 * how a preview starts lying. Counts arrive already filtered by the same
 * predicates that gate real reads.
 *
 * Opening this grants nothing (B9). It is a read.
 */

export type Perimeter = {
  destinations: DestinationId[];
  documents: { total: number; rooms: { room: string; count: number }[] };
  capabilities: { canUploadToDataRoom: boolean; canInviteTeammate: boolean };
  invariants: string[];
};

export type PerimeterResponse =
  | { dealContext: 'existing' | 'proposed'; perimeter: Perimeter }
  | { code: 'company_requires_director' | 'refused'; error: string };

// A refusal is a known answer, not an uncomputed perimeter, so it is named
// rather than folded into "could not be computed" (#397). 403 stays opaque on
// the server, so its copy is written here, per mode: a member preview changes
// an existing seat's phase and sends nothing.
const FORBIDDEN_COPY = {
  proposal: 'Your seat cannot send this invitation, so there is nothing to show.',
  member: "Your seat cannot change this person's access, so there is nothing to show.",
} as const;
const SESSION_EXPIRED_COPY = 'Your session expired. Sign in again.';

const INVARIANT_COPY: Record<string, string> = {
  external_never_internal_room: 'Never sees the Internal room, at any phase.',
  external_never_mnpi: 'Never sees documents marked MNPI, at any phase.',
};

type PerimeterPreviewHeading = {
  /** The visible heading. Default "What they can see". */
  heading?: string;
};

export type PerimeterPreviewProps = PerimeterPreviewHeading &
  (
  | {
      mode: 'proposal';
      email: string;
      companyId: string | null;
      companyRole: string;
      dealId: string | null;
      dealRole: string | null;
      phase: number;
    }
  | { mode: 'member'; dealId: string; userId: string; phase: number }
  );

export function PerimeterPreview(props: PerimeterPreviewProps) {
  const heading = props.heading ?? 'What they can see';
  // The key carries `mode`, so a proposal result can never be shown for a
  // member request even if the other fields happen to coincide.
  const key =
    props.mode === 'member'
      ? boundKeyOf({
          mode: 'member',
          dealId: props.dealId,
          userId: props.userId,
          phase: props.phase,
        })
      : props.companyId
        ? boundKeyOf({
            mode: 'proposal',
            email: props.email.trim().toLowerCase(),
            companyId: props.companyId,
            companyRole: props.companyRole,
            dealId: props.dealId,
            dealRole: props.dealRole,
            phase: props.phase,
          })
        : null;

  const body =
    props.mode === 'member'
      ? { member: { dealId: props.dealId, userId: props.userId, phase: props.phase } }
      : {
          proposal: {
            email: props.email.trim().toLowerCase(),
            companyId: props.companyId,
            companyRole: props.companyRole,
            dealId: props.dealId,
            dealRole: props.dealRole,
            phase: props.phase,
          },
        };

  const { status, result } = useBoundRequest<PerimeterResponse>(key, async (signal) => {
    const res = await fetch('/api/v1/invites/perimeter-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) return { code: 'refused', error: SESSION_EXPIRED_COPY };
    if (res.status === 403) return { code: 'refused', error: FORBIDDEN_COPY[props.mode] };
    if (res.status >= 400 && res.status < 500) {
      const refusal = (await res.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
      if (typeof refusal.error === 'string') {
        return {
          code: refusal.code === 'company_requires_director' ? 'company_requires_director' : 'refused',
          error: refusal.error,
        };
      }
    }
    if (!res.ok) throw new Error(`preview_failed_${res.status}`);
    const payload = (await res.json()) as Partial<{
      dealContext: 'existing' | 'proposed';
      perimeter: Perimeter;
    }>;
    // An unrecognized shape is an uncomputed perimeter. Reporting it as a
    // perimeter with zero documents would be a lie in the dangerous direction
    // (B10).
    if (
      !payload?.perimeter ||
      typeof payload.perimeter.documents?.total !== 'number' ||
      !Array.isArray(payload.perimeter.destinations) ||
      // Every member must be a destination we can name. An id we cannot title
      // would otherwise reach the reader as raw camelCase. `hasOwnProperty`
      // rather than `in`, so a value like "toString" cannot pass on the
      // prototype chain.
      !payload.perimeter.destinations.every(
        (id) =>
          typeof id === 'string' &&
          Object.prototype.hasOwnProperty.call(DESTINATION_TITLES, id),
      )
    ) {
      throw new Error('preview_malformed');
    }
    return payload as PerimeterResponse;
  });

  if (!key) return null;

  const perimeter =
    status === 'ready' && result && 'perimeter' in result ? result.perimeter : null;
  const refusal =
    status === 'ready' && result && 'code' in result ? result.error : null;

  return (
    <section
      data-testid="perimeter-preview"
      data-status={status}
      aria-live="polite"
      aria-label={heading}
      style={{
        border: '1px solid var(--stroke)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--space-3)',
        marginTop: 'var(--space-3)',
        background: 'var(--surface)',
        fontSize: 'var(--text-sm)',
      }}
    >
      <h3
        style={{
          fontSize: 'var(--text-xs)',
          fontWeight: 600,
          color: 'var(--ink-secondary)',
        }}
      >
        {heading}
      </h3>

      {status === 'loading' && <p style={{ color: 'var(--ink-secondary)' }}>Checking what they can see.</p>}
      {status === 'stale' && <p style={{ color: 'var(--ink-secondary)' }}>The details changed. Checking again.</p>}
      {status === 'unavailable' && (
        <p role="status" style={{ color: 'var(--ink-secondary)' }}>
          What they can see could not be checked. No access is implied either way.
        </p>
      )}
      {refusal && (
        <p role="alert" style={{ color: 'var(--hold-deep)' }}>
          {refusal}
        </p>
      )}

      {perimeter && (
        <>
          <p style={{ marginTop: 'var(--space-2)' }}>
            Pages:{' '}
            {perimeter.destinations.map((id) => DESTINATION_TITLES[id]).join(', ')}.
          </p>

          {perimeter.documents.total === 0 ? (
            // B13: an explicit zero, with no hint of volume behind the wall.
            <p style={{ marginTop: 'var(--space-2)' }}>
              No documents are released to them yet.
            </p>
          ) : (
            <p style={{ marginTop: 'var(--space-2)' }}>
              {perimeter.documents.total} document{perimeter.documents.total === 1 ? '' : 's'}{' '}
              available
              {perimeter.documents.rooms.length > 0 && (
                <>
                  {' ('}
                  {perimeter.documents.rooms
                    .map((entry) => `${entry.count} in ${entry.room}`)
                    .join(', ')}
                  {')'}
                </>
              )}
              .
            </p>
          )}

          <ul style={{ marginTop: 'var(--space-2)', paddingLeft: 'var(--space-3)' }}>
            <li>
              {perimeter.capabilities.canUploadToDataRoom ? 'Can upload' : 'Cannot upload'} to the
              data room.
            </li>
            <li>
              {perimeter.capabilities.canInviteTeammate ? 'Can invite' : 'Cannot invite'} teammates
              at their own company.
            </li>
          </ul>

          {perimeter.invariants.length > 0 && (
            <ul
              style={{
                marginTop: 'var(--space-2)',
                paddingLeft: 'var(--space-3)',
                color: 'var(--ink-secondary)',
              }}
            >
              {perimeter.invariants.map((id) => (
                <li key={id}>{INVARIANT_COPY[id] ?? id}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export default PerimeterPreview;
