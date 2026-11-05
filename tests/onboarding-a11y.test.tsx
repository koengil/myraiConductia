import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PerimeterPreview } from '@/components/onboarding/PerimeterPreview';
import { WelcomeBrief } from '@/components/onboarding/WelcomeBrief';

/**
 * Criterion D5: the primary path is operable by keyboard alone and announces
 * its state changes to assistive technology.
 *
 * Both new cards change content asynchronously without the user acting, which
 * is precisely the case a sighted user notices and a screen-reader user does
 * not, unless the region announces itself.
 */
describe('onboarding surfaces announce and are operable (D5)', () => {
  it('the perimeter preview is a live region with a name', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);

    const preview = screen.getByTestId('perimeter-preview');
    expect(preview.getAttribute('aria-live')).toBe('polite');
    expect(preview.getAttribute('aria-label')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('the welcome brief offers real links, so it is reachable by keyboard alone', () => {
    render(
      <WelcomeBrief
        projectId="PROJECT-X"
        deal={{ code: 'PROJECT-X', codename: 'Atlas', status: 'active' }}
        companyName="Target Co"
        dealRole="seller"
        phase={1}
        perimeter={{
          destinations: ['mandate', 'rail', 'dataRoom', 'team'],
          documents: { total: 2, rooms: [{ room: 'deal', count: 2 }] },
          capabilities: { canUploadToDataRoom: true, canInviteTeammate: false },
          invariants: [],
        }}
      />,
    );

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThan(0);
    // Anchors with a real href are focusable and activatable without a pointer;
    // a div with an onClick would not be.
    for (const link of links) {
      expect(link.tagName).toBe('A');
      expect(link.getAttribute('href')).toMatch(/^\/projects\//);
    }
  });

  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response)),
    );
  const proposal = {
    mode: 'proposal' as const,
    email: 'new.person@canva.com',
    companyId: 'c-1',
    companyRole: 'member',
    dealId: 'PROJECT-X',
    dealRole: 'advisor',
    phase: 2,
  };

  it('a refused invitation says why rather than "could not be checked" (#397)', async () => {
    respond(403, { error: 'Forbidden' });
    render(<PerimeterPreview {...proposal} />);

    expect(await screen.findByText(/cannot send this invitation/i)).toBeTruthy();
    expect(screen.queryByText(/could not be checked/i)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('a refused phase change names the phase change, not an invitation (#397)', async () => {
    respond(403, { error: 'Forbidden' });
    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);

    expect(await screen.findByText(/cannot change this person's access/i)).toBeTruthy();
    expect(screen.queryByText(/cannot send this invitation/i)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('an expired session asks the MD to sign in again (#397)', async () => {
    respond(401, { error: 'Unauthorized' });
    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);

    expect(await screen.findByText('Your session expired. Sign in again.')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('another 4xx passes the server reason through (#397)', async () => {
    respond(404, { error: 'Deal not found' });
    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);

    expect(await screen.findByText('Deal not found')).toBeTruthy();
    expect(screen.queryByText(/could not be checked/i)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('a 409 keeps the company_requires_director refusal (#397)', async () => {
    respond(409, { code: 'company_requires_director', error: 'This company needs a director first.' });
    render(<PerimeterPreview {...proposal} />);

    expect(await screen.findByText('This company needs a director first.')).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('an unavailable perimeter is announced, not silently blank', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)),
    );
    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);

    expect(await screen.findByText(/could not be checked/i)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
