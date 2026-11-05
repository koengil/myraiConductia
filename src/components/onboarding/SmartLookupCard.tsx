'use client';

import { useEffect, useRef } from 'react';

import { DEAL_ROLE_LABELS, type DealRole } from '@/lib/constants/roles';
import { boundKeyOf, useBoundRequest, type BoundStatus } from './useBoundRequest';

/**
 * The intelligence card behind the invitation email field (criteria A1-A19).
 *
 * Everything shown here is a PROPOSAL. The card pre-fills nothing on its own:
 * it hands the recommendation up to the host surface, which applies it to real
 * controls the inviter can still change, and the existing pre-send confirmation
 * gate remains exactly where it was.
 */

export type LookupWarning = { id: string };

export type LookupResult = {
  normalizedEmail: string;
  domain: string;
  companyMatch: { companyId: string; companyName: string } | null;
  proposedCompany: { label: string } | null;
  warnings: LookupWarning[];
  recommendation: {
    dealRole: string;
    companyRole: string;
    phase: number;
    reasons: { dealRole: string; phase: string };
  } | null;
  companyRolePolicy: {
    companyId: string;
    memberAllowed: boolean;
    directorAllowed: boolean;
    requiresDirector: boolean;
  } | null;
};

/** Copy lives here, not in the API. The server returns stable ids so that no
 *  prose — and no metadata smuggled inside prose — ships from the endpoint. */
const WARNING_COPY: Record<string, string> = {
  personal_domain: 'This is a personal email address, not a company address.',
  domain_mismatch: 'This domain does not match the company record.',
  unverified_domain: 'This company has no verified email domain.',
  existing_platform_user: 'This person already has a platform account.',
  existing_deal_seat: 'This person already holds a seat on this deal.',
  pending_invitation: 'An invitation for this address is already pending.',
};

const REASON_COPY: Record<string, string> = {
  party_derived: 'Derived from this company’s role on the deal.',
  bank_internal_seat: 'Internal seat at the advisory bank.',
  least_privilege_start: 'Least-privilege start. Raise the phase when disclosure warrants it.',
  phase_not_applicable_internal: 'Phase gates external users only.',
};

export type SmartLookupCardProps = {
  /** Raw email as typed. The card decides for itself when it is worth asking. */
  email: string;
  /** Deal code or id when composing on a deal; null in Gate 0 before creation. */
  dealId: string | null;
  /**
   * The company currently selected on the form. Part of the binding, not
   * decoration: "this domain does not match the company record" is a claim
   * about the SELECTED company, so a result computed against a different one
   * must not survive the change (criteria A5(b), A13, A14).
   */
  companyId?: string | null;
  /** Which invitation surface is composing. Also a bound input. */
  surface?: 'gate0' | 'team';
  /**
   * Called when the current result changes. `status` is passed because "no
   * result" has two very different meanings: a lookup in flight, and a lookup
   * that failed. A host that treats them alike can revert a control while its
   * own revert re-triggers the request that cleared it.
   */
  onResult?: (result: LookupResult | null, status: BoundStatus) => void;
};

export const LOOKS_LIKE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function SmartLookupCard({
  email,
  dealId,
  companyId = null,
  surface = 'team',
  onResult,
}: SmartLookupCardProps) {
  const trimmed = email.trim().toLowerCase();
  // Criterion A12: a malformed or incomplete address issues no request at all.
  const ready = LOOKS_LIKE_EMAIL.test(trimmed);
  const key = ready ? boundKeyOf({ email: trimmed, dealId, companyId, surface }) : null;

  const { status, result } = useBoundRequest<LookupResult>(key, async (signal) => {
    const res = await fetch('/api/v1/invites/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: trimmed, dealId, companyId }),
      signal,
    });
    if (!res.ok) throw new Error(`lookup_failed_${res.status}`);
    const body = (await res.json()) as Partial<LookupResult>;
    // A body that is not a lookup result is a failed lookup, not a lookup with
    // missing fields. Rendering half of an unrecognized shape would be worse
    // than saying nothing (A16).
    if (typeof body?.normalizedEmail !== 'string' || !Array.isArray(body.warnings)) {
      throw new Error('lookup_malformed');
    }
    return body as LookupResult;
  });

  // Hand the result up only while it is genuinely current. On stale, loading or
  // unavailable the host is told null, which withdraws any pre-fill it applied
  // (A14) — the withdrawal matters as much as the delivery.
  const current = status === 'ready' ? result : null;
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  });
  useEffect(() => {
    onResultRef.current?.(current, status);
  }, [current, status]);

  if (!ready) return null;

  return (
    <div
      data-testid="smart-lookup-card"
      data-status={status}
      aria-live="polite"
      style={{
        border: '1px solid var(--stroke)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--space-3)',
        marginTop: 'var(--space-2)',
        background: 'var(--surface)',
        fontSize: 'var(--text-sm)',
      }}
    >
      {status === 'loading' && <p style={{ color: 'var(--ink-secondary)' }}>Checking this address.</p>}

      {status === 'unavailable' && (
        <p role="status" style={{ color: 'var(--ink-secondary)' }}>
          Lookup is unavailable. Enter the company and seat yourself.
        </p>
      )}

      {status === 'stale' && (
        <p style={{ color: 'var(--ink-secondary)' }}>Inputs changed. Rechecking.</p>
      )}

      {status === 'ready' && result && (
        <>
          {result.companyMatch ? (
            <p style={{ fontWeight: 600 }}>
              {result.companyMatch.companyName}
              <span style={{ color: 'var(--ink-secondary)', fontWeight: 400 }}>
                {' '}
                matches {result.domain}.
              </span>
            </p>
          ) : (
            <p>
              <span style={{ color: 'var(--ink-secondary)' }}>No company matches {result.domain}.</span>{' '}
              {result.proposedCompany && (
                <>
                  Proposed label: <strong>{result.proposedCompany.label}</strong>. Confirm it before
                  sending.
                </>
              )}
            </p>
          )}

          {result.warnings.length > 0 && (
            <ul style={{ marginTop: 'var(--space-2)', paddingLeft: 'var(--space-3)' }}>
              {result.warnings.map((warning) => (
                <li key={warning.id} style={{ color: 'var(--hold-deep)' }}>
                  {WARNING_COPY[warning.id] ?? 'Review this address before sending.'}
                </li>
              ))}
            </ul>
          )}

          {result.recommendation && (
            <dl style={{ marginTop: 'var(--space-2)', color: 'var(--ink-secondary)' }}>
              <div>
                <dt style={{ display: 'inline', fontWeight: 600 }}>Proposed seat: </dt>
                <dd style={{ display: 'inline' }}>
                  {DEAL_ROLE_LABELS[result.recommendation.dealRole as DealRole] ?? result.recommendation.dealRole}, phase {result.recommendation.phase}.
                </dd>
              </div>
              <p style={{ marginTop: 'var(--space-1)' }}>
                {REASON_COPY[result.recommendation.reasons.dealRole]}{' '}
                {REASON_COPY[result.recommendation.reasons.phase]}
              </p>
            </dl>
          )}

          {result.companyRolePolicy?.requiresDirector && (
            <p
              role="status"
              style={{ marginTop: 'var(--space-2)', color: 'var(--hold-deep)' }}
            >
              {result.companyRolePolicy.directorAllowed
                ? 'This company has no active director. Its first user must join as Company Director.'
                : 'This company has no active director. A firm admin must send its first Company Director invitation.'}
            </p>
          )}

          <p style={{ marginTop: 'var(--space-2)', color: 'var(--ink-secondary)' }}>
            Every value above is a proposal. Confirm company and role before sending.
          </p>
        </>
      )}
    </div>
  );
}

export default SmartLookupCard;
