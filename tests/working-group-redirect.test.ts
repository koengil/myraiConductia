import { describe, expect, it, vi } from 'vitest';

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  }),
}));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));

import WorkingGroupRedirect from '@/app/(authed)/projects/[projectId]/working-group/page';

describe('legacy Working Group route', () => {
  it('redirects to the canonical Team destination', async () => {
    await expect(
      WorkingGroupRedirect({ params: Promise.resolve({ projectId: 'rangers' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/projects/rangers/team');
    expect(redirectMock).toHaveBeenCalledWith('/projects/rangers/team');
  });
});
