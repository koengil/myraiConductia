/**
 * /projects/[projectId] routing (cr-prr-124 1.2): externals get a real Deal
 * destination — no redirect cycle against the AppShell guard — while internal
 * users keep the rail redirect. Direct navigation to a deal the external has
 * no seat on falls back to the picker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock('@/lib/flags/isEnabled', () => ({ isEnabled: vi.fn(() => Promise.resolve(true)) }));
vi.mock('@/lib/flags/supabaseSource', () => ({ supabaseFlagSource: {} }));
vi.mock('@/lib/perspective/serverIdentity', () => ({ getShellIdentity: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseAdminClient: vi.fn() }));

import { redirect } from 'next/navigation';
import { isEnabled } from '@/lib/flags/isEnabled';
import { getShellIdentity } from '@/lib/perspective/serverIdentity';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import ProjectHomePage from '@/app/(authed)/projects/[projectId]/page';

function makeAdmin(rows: Record<string, unknown>) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }),
          maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        }),
      }),
    }),
  } as never;
}

const params = Promise.resolve({ projectId: 'd1' });

afterEach(() => vi.clearAllMocks());

describe('/projects/[projectId] external routing', () => {
  // Since PR #123 the internal home is the ProjectDashboard, not a /rail
  // redirect — the page resolves to an element instead of throwing.
  it('internal users get the project dashboard (no redirect)', async () => {
    vi.mocked(getShellIdentity).mockResolvedValue({
      userId: 'u1',
      perspective: 'storm',
      isExternal: false,
      isInvited: false,
    });
    await expect(ProjectHomePage({ params })).resolves.toBeTruthy();
  });

  it('flag off keeps the internal dashboard untouched', async () => {
    vi.mocked(isEnabled).mockResolvedValueOnce(false);
    await expect(ProjectHomePage({ params })).resolves.toBeTruthy();
    expect(getShellIdentity).not.toHaveBeenCalled();
  });

  it('a seated external user gets the Deal home — no redirect cycle', async () => {
    vi.mocked(getShellIdentity).mockResolvedValue({
      userId: 'ext-1',
      perspective: 'external',
      isExternal: true,
      isInvited: false,
    });
    vi.mocked(createSupabaseAdminClient).mockReturnValue(
      makeAdmin({
        deal_memberships: { deal_role: 'buyer', phase: 1 },
        deals: { id: 'd1', code: 'PRJRA-2026-001', codename: 'Project Rangers', status: 'active' },
      }),
    );

    render(await ProjectHomePage({ params }));
    expect(redirect).not.toHaveBeenCalled();
    expect(screen.getByText('Project Rangers')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Data Room/i })).toHaveAttribute(
      'href',
      '/projects/d1/data-room',
    );
    expect(screen.getByRole('link', { name: /^Team/i })).toHaveAttribute(
      'href',
      '/projects/d1/team',
    );
  });

  it('an external with no seat on the deal is sent back to the picker', async () => {
    vi.mocked(getShellIdentity).mockResolvedValue({
      userId: 'ext-1',
      perspective: 'external',
      isExternal: true,
      isInvited: false,
    });
    vi.mocked(createSupabaseAdminClient).mockReturnValue(makeAdmin({}));
    await expect(ProjectHomePage({ params })).rejects.toThrow('NEXT_REDIRECT:/projects');
  });
});
