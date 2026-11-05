import type { Metadata } from 'next';
import Link from 'next/link';
import { TOS_VERSION } from '@/lib/constants/legal';

export const metadata: Metadata = {
  title: 'Terms of Service · Conductia',
};

/**
 * Tier 1 (unguarded) route: invitees read this before accepting, so it must
 * be reachable without a session (excluded from the middleware matcher).
 *
 * PLACEHOLDER. The sections below outline the intended coverage and carry no
 * legal force. Replace with counsel-approved copy and bump TOS_VERSION. The
 * privacy policy is its own page, /privacy (#490 S5).
 */
export default function TermsPage() {
  return (
    <main className="mx-auto max-w-[640px] px-[var(--space-5)] py-[var(--space-8)]">
      <p className="font-mono text-[length:var(--text-xxs)] tracking-[0.06em] text-[var(--ink-tertiary)]">
        Conductia · Version {TOS_VERSION}
      </p>
      <h1 className="mt-[var(--space-2)] text-[length:var(--text-xl)] font-semibold text-[var(--ink)]">
        Terms of Service
      </h1>
      <p className="mt-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Draft. This document is a placeholder pending counsel review and has no
        legal force. It outlines the coverage the published terms will carry.
      </p>
      <div className="mt-[var(--space-5)] space-y-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        <section>
          <h2 className="font-semibold text-[var(--ink)]">1. The platform</h2>
          <p className="mt-[var(--space-1)]">
            Conductia provides compliance-first deal workspace software to
            invited members of participating firms. Access is personal,
            non-transferable, and scoped by the inviting firm.
          </p>
        </section>
        <section>
          <h2 className="font-semibold text-[var(--ink)]">2. Confidentiality and MNPI</h2>
          <p className="mt-[var(--space-1)]">
            Material in the platform can constitute material non-public
            information. Members handle all deal material under their firm
            obligations and applicable securities regulation.
          </p>
        </section>
        <section>
          <h2 className="font-semibold text-[var(--ink)]">3. Audit</h2>
          <p className="mt-[var(--space-1)]">
            Actions on the platform are recorded in an audit trail retained for
            regulatory purposes, including after a member leaves a deal or firm.
          </p>
        </section>
        <section>
          <h2 className="font-semibold text-[var(--ink)]">4. Data processing</h2>
          <p className="mt-[var(--space-1)]">
            Account and usage data are processed to operate the platform and to
            meet compliance obligations. The{' '}
            <Link href="/privacy" className="text-[var(--ink)] underline underline-offset-2">
              Privacy Policy
            </Link>{' '}
            sets out how Conductia handles personal data, including data
            received from Google when you connect your Gmail for sending.
          </p>
        </section>
      </div>
    </main>
  );
}
