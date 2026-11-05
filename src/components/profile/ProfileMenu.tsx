'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { createSupabaseBrowserClient } from '../../lib/supabase/client';
import { clearLocalStores } from '@/lib/session/clearLocalStores';
import { abortAllReads } from '@/lib/api/inflightRead';
import { ProfileIdentity } from '@/components/molecules';
import { Popover } from '@/components/overlay';
import { useFlag } from '@/lib/flags/FlagsContext';
import { PROFILE_CONNECT_DESTINATION, WORK_CONNECT_LABEL, workConnectHref } from '@/lib/auth/workConnect';
import { isWorkIdentityProvider } from '@/lib/constants/workIdentity';
import { organizationSettingsHref } from '@/lib/settings/href';

const MENU_ITEM_CLASS = [
  'inline-flex h-11 w-full items-center justify-start',
  'rounded-[var(--radius-button)] px-3',
  'font-sans text-(--text-sm) font-medium',
  'transition-[background-color] duration-150 ease-out',
  'focus-visible:outline-none focus-visible:ring-2',
  'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2',
  'disabled:opacity-60',
].join(' ');

/**
 * ProfileMenu — the signed-in user's credential, made interactive (design spec
 * §10.3 user-profile model). Lives at the foot of the rail (AppRail): an
 * avatar disc + (uncollapsed) the name/role lines act as a trigger. Clicking
 * it opens the shared Popover with the identity, Settings (profile,
 * organization and the rest), and a working sign-out: plain links and
 * buttons, not a menu, because the panel also holds the identity and the
 * sign-out status. Deal-seat titles and the active mandate stay off this
 * menu — those belong on the deal, not the account chrome.
 *
 * Voice (brand-foundations §Voice — precise, senior, decisive): no "we"/"you";
 * no exclamation marks.
 *
 * Tone duality: 'on-light' over the warm working surface, 'on-dark' over the
 * navy rail (its current home). The caller passes the right value.
 *
 * Identity comes from the authenticated session (via useCurrentUser → the
 * caller), not the product seam. Sign-out clears the Supabase session and
 * routes back to /sign-in.
 */

export interface ProfileMenuProps {
  /** Display name of the signed-in user. */
  name: string;
  /** Organization role label (e.g. "Administrator", "Member"). */
  roleLabel: string;
  /** Avatar initials. */
  initials: string;
  /**
   * Tone hint for the trigger button. The navy rail uses 'on-dark'; a warm
   * working surface uses 'on-light'. Default 'on-light'. The caller passes
   * the right value.
   */
  tone?: 'on-light' | 'on-dark';
  /** Avatar-only trigger (the collapsed rail). Hides the name/role lines. */
  compact?: boolean;
  /**
   * Adds an Organization link to Settings › Organization, for firm admins and
   * company directors (showOrganizationMenuLink). Default false.
   */
  showOrganization?: boolean;
  /**
   * Where the popover opens relative to the trigger. 'below-end' (default)
   * suits a top-nav trigger at the right edge of the chrome; 'above-start'
   * suits a trigger at the foot of the left rail.
   */
  placement?: ProfileMenuPlacement;
  className?: string;
}

export type ProfileMenuPlacement = 'below-end' | 'above-start';

const PLACEMENT_ANCHOR: Record<ProfileMenuPlacement, string> = {
  'below-end': 'top-[calc(100%+var(--space-2))] right-0',
  'above-start': 'bottom-[calc(100%+var(--space-2))] left-0',
};

const PROVIDER_READ_DEADLINE_MS = 5000;

export function ProfileMenu({
  name,
  roleLabel,
  initials,
  tone = 'on-light',
  compact = false,
  showOrganization = false,
  placement = 'below-end',
  className,
}: ProfileMenuProps) {
  const router = useRouter();
  const onDark = tone === 'on-dark';
  const workIdentityEnabled = useFlag('work_identity_onboarding');

  const [open, setOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [signOutError, setSignOutError] = React.useState<string | null>(null);

  // Offer only the provider the caller can still connect; begin_work_identity_connect
  // rejects any other. Read on every open, so a provider configured or a connect
  // completed mid-session shows up without a reload; aborted on close, sign-out and
  // unmount (#162). The answer is dropped on close, so a reopen never offers a
  // stale provider while it re-reads, and a failed read offers nothing.
  // ponytail: one request per open; cache it if menu opens ever show up in load.
  // `settled` reserves the Connect row until the read answers, so the item never
  // appears under a pointer already headed for Sign out.
  const [lookup, setLookup] = React.useState<{ provider: string | null; settled: boolean }>({
    provider: null,
    settled: false,
  });
  const providerRead = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    if (!open || !workIdentityEnabled) return;
    const controller = new AbortController();
    providerRead.current = controller;
    // A hung read must not hold the reserved row open: past the deadline it settles empty.
    const deadline = setTimeout(() => {
      controller.abort();
      setLookup({ provider: null, settled: true });
    }, PROVIDER_READ_DEADLINE_MS);
    fetch('/api/v1/work-identity/provider', { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ provider?: string | null }>) : null))
      .then((body) => {
        if (!controller.signal.aborted) setLookup({ provider: body?.provider ?? null, settled: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLookup({ provider: null, settled: true });
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      clearTimeout(deadline);
      controller.abort();
      setLookup({ provider: null, settled: false });
    };
  }, [open, workIdentityEnabled]);
  const connect =
    workIdentityEnabled && isWorkIdentityProvider(lookup.provider)
      ? {
          href: workConnectHref(lookup.provider, PROFILE_CONNECT_DESTINATION),
          label: WORK_CONNECT_LABEL[lookup.provider],
        }
      : null;
  const connectPending = workIdentityEnabled && open && !lookup.settled;

  const signOut = React.useCallback(async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      const supabase = createSupabaseBrowserClient();
      // No read started as this user may deliver after the sign-out (#162).
      abortAllReads();
      providerRead.current?.abort();
      // A refused sign-out resolves with { error }: keep everything, say so.
      const { error: refused } = await supabase.auth.signOut();
      if (refused) throw refused;
      clearLocalStores();
      router.replace('/sign-in');
      router.refresh();
    } catch {
      setSigningOut(false);
      setSignOutError('Could not sign out. Try again.');
    }
  }, [router]);

  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const profileLinkRef = React.useRef<HTMLAnchorElement | null>(null);
  const signOutRef = React.useRef<HTMLButtonElement | null>(null);

  // Escape, an outside press and focus leaving the panel close it (shared
  // Popover); Escape returns focus to the trigger.

  // When the panel opens, move focus into it (the Settings link is the first
  // actionable item). When it closes, the inert-CTA notice resets so
  // reopening starts quiet. The close-time reset is scheduled in the cleanup
  // so the lint rule that forbids calling setState() directly inside an
  // effect body is honored (the reset is conceptually "on close," not "on
  // every effect run").
  React.useEffect(() => {
    if (!open) return undefined;
    const id = window.requestAnimationFrame(() => {
      profileLinkRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(id);
      setSignOutError(null);
    };
  }, [open]);

  const triggerLabel = `${name}, open profile menu`;

  // Surface colors per tone. Avatar disc carries an inset-stroke ring +
  // font-mono initials.
  const triggerHoverBg = onDark
    ? 'var(--shell-hover-bg)'
    : 'var(--surface-subtle)';
  const focusRingOffset = onDark
    ? 'var(--shell-rail-bg)'
    : 'var(--surface-warm)';

  const secondaryColor = onDark
    ? 'var(--shell-ink-muted)'
    : 'var(--ink-secondary)';

  // Popover surface: light or dark — modal-grade elevation, card radius,
  // generous padding. Always pinned to the trigger's right edge so it never
  // bleeds off the chrome on narrow viewports.
  const popoverBg = onDark
    ? 'var(--shell-popover-bg)'
    : 'var(--surface)';
  const popoverText = onDark ? 'var(--shell-ink)' : 'var(--ink)';
  const popoverShadow = onDark ? 'var(--shell-elev-2)' : 'var(--shadow-ambient)';
  const dividerColor = onDark
    ? 'var(--shell-panel-border)'
    : 'var(--stroke)';
  const captionColor = onDark
    ? 'var(--ink-on-dark-tertiary)'
    : 'var(--ink-tertiary)';

  // Sign-out button — quiet ghost on either surface. Real, visible focus ring.
  const signOutBg = onDark
    ? 'var(--shell-hover-bg)'
    : 'var(--surface-subtle)';
  const signOutHoverBg = onDark
    ? 'var(--shell-active-bg)'
    : 'color-mix(in srgb, var(--ink) 6%, transparent)';
  // Shared by every menu item (Settings, Organization, Connect, Sign out) so they cannot drift.
  const menuItem = {
    className: MENU_ITEM_CLASS,
    style: {
      background: signOutBg,
      color: popoverText,
      ['--tw-ring-offset-color' as string]: popoverBg,
    } as React.CSSProperties,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.backgroundColor = signOutHoverBg;
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.backgroundColor = signOutBg;
    },
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Profile"
      side={placement === 'above-start' ? 'above' : 'below'}
      className={['inline-flex', className].filter(Boolean).join(' ')}
      triggerRef={triggerRef}
      panelClassName={[
        PLACEMENT_ANCHOR[placement],
        'w-[280px] max-w-[calc(100vw-var(--space-6))]',
        'rounded-[var(--radius-card)] border',
        'p-(--space-6)',
        'flex flex-col gap-(--space-4)',
      ].join(' ')}
      panelStyle={{
        background: popoverBg,
        color: popoverText,
        borderColor: dividerColor,
        boxShadow: popoverShadow,
      }}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          aria-label={triggerLabel}
          className={[
            'group inline-flex items-center gap-[var(--space-3)]',
            compact ? 'justify-center' : 'w-full justify-start',
            'rounded-[var(--radius-button)] p-[var(--space-2)]',
            'transition-[background-color,box-shadow,color] duration-150 ease-out',
            'focus-visible:outline-none focus-visible:ring-2',
            'focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2',
          ].join(' ')}
          style={
            {
              // Inline hover/focus offset colors — token-driven, surface-aware.
              // The hover background only paints under hover; CSS variables
              // here just hand the tokens to the className above.
              ['--profile-trigger-hover-bg' as string]: triggerHoverBg,
              ['--tw-ring-offset-color' as string]: focusRingOffset,
            } as React.CSSProperties
          }
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
              triggerHoverBg;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor =
              'transparent';
          }}
        >
          <ProfileIdentity
            name={name}
            roleLabel={roleLabel}
            initials={initials}
            tone={tone}
            compact={compact}
          />
        </button>
      )}
    >
      {/* Identity — name and organization role on one line. */}
      <h3
        className="font-sans text-(--text-md) font-medium leading-tight tracking-tight"
        style={{ color: popoverText }}
      >
        {name}
        {roleLabel ? (
          <span
            className="font-normal"
            style={{ color: secondaryColor }}
          >
            {', '}
            {roleLabel}
          </span>
        ) : null}
      </h3>

      {/* Hairline divider — token stroke on light, soft luminous on dark. */}
      <div
        aria-hidden="true"
        className="h-px w-full"
        style={{ background: dividerColor }}
      />

      <div className="flex flex-col gap-(--space-2)">
        <Link
          ref={profileLinkRef}
          href="/settings"
          onClick={() => setOpen(false)}
          {...menuItem}
        >
          Settings
        </Link>
        {showOrganization ? (
          <Link href={organizationSettingsHref()} onClick={() => setOpen(false)} {...menuItem}>
            Organization
          </Link>
        ) : null}
        {connectPending ? (
          <div aria-hidden="true" data-testid="connect-placeholder" className="h-11 w-full" />
        ) : connect ? (
          // A route handler that redirects to the provider: full navigation, not <Link>.
          <a
            href={connect.href}
            {...menuItem}
          >
            {connect.label}
          </a>
        ) : null}
        <button
          ref={signOutRef}
          type="button"
          disabled={signingOut}
          onClick={() => void signOut()}
          {...menuItem}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
        {signOutError ? (
          <p
            role="status"
            className="font-sans text-(--text-sm) leading-snug"
            style={{ color: captionColor }}
          >
            {signOutError}
          </p>
        ) : null}
      </div>
    </Popover>
  );
}

export default ProfileMenu;
