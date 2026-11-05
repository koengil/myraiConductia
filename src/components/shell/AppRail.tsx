'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';

import { Wordmark } from '../brand/Wordmark';
import { AppNav } from './AppNav';
import { ProfileMenu } from '@/components/organisms/profile';
import {
  initialsFor,
  initialsFromEmail,
  roleLabelFor,
  useCurrentUser,
} from '../../lib/auth/useCurrentUser';
import {
  SHELL_COLLAPSE_DURATION_S,
  SHELL_COLLAPSE_EASE,
  SHELL_FADE_DURATION_S,
  shellTransition,
} from '@/components/_shared/motion';

/**
 * AppRail — the persistent, collapsible left navigation rail (2026-05-24
 * AI-native shell). It is the ONLY chrome: wordmark + collapse toggle at the
 * top, the vertical destination nav in the middle, and the profile + an
 * ambient compliance anchor at the bottom. The top header is retired; content
 * runs full-screen to the right.
 *
 * Collapse: when `collapsed`, the rail narrows to an icon-only strip (wordmark
 * → shield mark, nav → icons, profile → avatar) so the workspace reads as a
 * full-screen native app. State is owned by the parent (AppShell).
 *
 * The live compliance instrument is the top bar's ComplianceRibbon (TopBar, or
 * TopNav behind its flag), not here: the rail's dot is decorative.
 *
 * Desktop only — hidden below md, where AppNav layout="bottom-bar" takes over.
 */

export function AppRail({
  collapsed,
  onToggle,
  className,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const { state } = useCurrentUser();
  const reduceMotion = useReducedMotion() ?? false;

  const profile =
    state.status === 'ready'
      ? {
          name: state.data.user.display_name || state.data.user.full_name,
          roleLabel: roleLabelFor(state.data.user),
          initials: initialsFor(state.data.user),
        }
      : state.status === 'error'
        ? {
            name: state.email ?? 'Account',
            roleLabel: 'Profile unavailable',
            initials: state.email ? initialsFromEmail(state.email) : '?',
          }
        : null;

  return (
    <motion.aside
      data-shell-tone="dark"
      className={[
        'sticky top-0 z-40 flex h-dvh shrink-0 flex-col',
        'border-r border-[var(--shell-rail-border)] bg-[var(--shell-rail-bg)]',
        'text-[var(--shell-ink)] px-(--space-3) py-(--space-5)',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      initial={false}
      animate={{ width: collapsed ? 72 : 224 }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : { duration: SHELL_COLLAPSE_DURATION_S, ease: SHELL_COLLAPSE_EASE }
      }
    >
      {/* Top: wordmark + collapse toggle. */}
      <motion.div
        className={[
          'mb-(--space-8) flex items-center',
          collapsed ? 'flex-col gap-(--space-3)' : 'justify-between',
        ].join(' ')}
        initial={false}
        animate={{ opacity: 1 }}
        transition={shellTransition(reduceMotion, SHELL_FADE_DURATION_S)}
      >
        <Link
          href="/projects"
          aria-label="Conductia: go to projects"
          className="inline-flex shrink-0 items-center rounded-[var(--radius-input)] px-(--space-1) outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--shell-rail-bg)]"
          style={{ color: 'var(--shell-ink)' }}
        >
          <Wordmark
            variant={collapsed ? 'mark' : 'full'}
            size={collapsed ? 24 : 21}
            tone="on-dark"
            title="Conductia"
          />
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-pressed={collapsed}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-button border border-(--shell-rail-border) bg-(--shell-panel-bg) text-(--shell-ink-muted) outline-none transition-colors hover:bg-(--shell-hover-bg) hover:text-(--shell-ink) focus-visible:ring-2 focus-visible:ring-accent"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ transform: collapsed ? 'rotate(180deg)' : undefined }}
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
      </motion.div>

      {/* Destinations. */}
      <AppNav layout="rail" collapsed={collapsed} className="flex-1" />

      {/* Company members (internal staff with a company only). */}
      {state.status === 'ready' &&
      !state.data.user.is_external &&
      state.data.user.company_id ? (
        <Link
          href={`/companies/${state.data.user.company_id}/members`}
          title="Company members"
          className={[
            'mb-(--space-2) flex items-center gap-(--space-2) rounded-button px-(--space-2) py-(--space-2)',
            'text-(--text-xs) font-medium text-(--shell-ink-muted) outline-none transition-colors',
            'hover:bg-(--shell-hover-bg) hover:text-(--shell-ink) focus-visible:ring-2 focus-visible:ring-accent',
            collapsed ? 'justify-center' : '',
          ].join(' ')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          {collapsed ? null : <span>Company</span>}
        </Link>
      ) : null}

      {/* Bottom: profile + ambient compliance anchor. */}
      <div className="mt-(--space-6) flex flex-col gap-(--space-3) border-t border-[var(--shell-rail-border)] pt-(--space-4)">
        {profile ? (
          <div className={collapsed ? 'flex justify-center' : ''}>
            <ProfileMenu
              name={profile.name}
              roleLabel={profile.roleLabel}
              initials={profile.initials}
              tone="on-dark"
              compact={collapsed}
              placement="above-start"
            />
          </div>
        ) : null}

        <div
          className={[
            'flex items-center gap-[var(--space-2)]',
            collapsed ? 'justify-center' : '',
          ].join(' ')}
          title="Compliance monitoring active"
        >
          <span
            aria-hidden="true"
            className="compliance-idle-dot inline-block h-[6px] w-[6px] shrink-0 rounded-full"
          />
          {collapsed ? null : (
            <span className="text-(--text-xxs) tracking-tight text-[var(--shell-ink-tertiary)]">
              Compliance · Always on
            </span>
          )}
        </div>
      </div>
    </motion.aside>
  );
}

export default AppRail;
