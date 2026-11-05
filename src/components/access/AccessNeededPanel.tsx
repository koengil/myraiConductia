'use client';

import * as React from 'react';

import { ACCESS_DESTINATION_DEFS, type AccessDestination } from '@/lib/constants/accessRequests';
import { useRequestAccess } from '@/lib/access/useRequestAccess';

/**
 * Shown when the caller opened a sidebar destination they cannot use yet.
 * They can ask an organization administrator for the matching permission.
 */
export function AccessNeededPanel({
  destination,
  headingLevel = 1,
}: {
  destination: AccessDestination;
  /** 2 where the page already carries its own h1 (the panel sits inside it). */
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h1';
  const dest = ACCESS_DESTINATION_DEFS[destination];
  const { pending, busy, error, requestAccess } = useRequestAccess(destination);

  return (
    <section
      aria-label={`Access needed for ${dest.label}`}
      className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)] shadow-[var(--elev-1)]"
    >
      <Heading className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">{dest.label}</Heading>
      <p className="mt-[var(--space-2)] max-w-xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        You need permission from an organization administrator to use {dest.label}. Send a
        request and they can approve or deny it.
      </p>
      {error ? (
        <p role="alert" className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}
      {pending ? (
        <p role="status" className="mt-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink)]">
          Your request is waiting for an administrator.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => void requestAccess()}
          disabled={busy}
          className="mt-[var(--space-4)] inline-flex items-center rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[6px] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-60"
        >
          {busy ? 'Sending…' : 'Request access'}
        </button>
      )}
    </section>
  );
}
