import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemberDetail } from '@/components/team/MemberDetail';
import type { LiveMember } from '@/lib/team/roster';

/**
 * The access-change preview (B11) and its bound-input behaviour (D8.9, D8.11),
 * in the inline person detail under a Team row.
 *
 * The bound key for this surface carries the deal, the TARGET USER and the
 * proposed phase. Without the user in the key, a late response for person A
 * could render under person B. An API test cannot prove a stale response never
 * renders, so the assertion lives here, at the parent.
 */

function member(over: Partial<LiveMember> = {}): LiveMember {
  return {
    userId: 'u-1',
    displayName: 'Alex Rivera',
    fullName: 'Alex Rivera',
    email: 'alex@target.dev',
    dealRole: 'seller',
    phase: 1,
    isExternal: true,
    companyId: 'seller-1',
    companyName: 'Target Co',
    companyRole: 'member',
    ...over,
  };
}

function perimeter(total: number) {
  return {
    dealContext: 'existing',
    perimeter: {
      destinations: ['mandate', 'rail', 'dataRoom', 'team'],
      documents: { total, rooms: total ? [{ room: 'deal', count: total }] : [] },
      capabilities: { canUploadToDataRoom: true, canInviteTeammate: false },
      invariants: ['external_never_internal_room', 'external_never_mnpi'],
    },
  };
}

let respond: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown };

beforeEach(() => {
  respond = () => ({ ok: true, status: 200, body: perimeter(5) });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const { ok, status, body } = respond(String(url), init);
      return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function open(over: Partial<LiveMember> = {}, viewerIsMd = true) {
  return render(
    <MemberDetail
      dealId="PROJECT-X"
      member={member(over)}
      companyMembers={[member(over)]}
      viewerIsMd={viewerIsMd}
      onChanged={() => {}}
    />,
  );
}

function previewCalls() {
  return vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/perimeter-preview'));
}

describe('access-change preview in the person detail', () => {
  it('previews what the change would give, before committing it', async () => {
    open();

    const preview = await screen.findByTestId('perimeter-preview');
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('ready'));

    // The control starts on the person's current phase (Preparation, 1), so
    // the preview first shows what they see now; Update access waits for a
    // different choice.
    expect((screen.getByLabelText('Access up to') as HTMLSelectElement).value).toBe('1');
    expect(screen.getByRole('button', { name: 'Update access' })).toBeDisabled();
    const [, init] = previewCalls()[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      member: { dealId: 'PROJECT-X', userId: 'u-1', phase: 1 },
    });
    expect(preview.textContent).toMatch(/Up to Preparation, they can see/);
    expect(preview.textContent).toMatch(/5 document/);

    fireEvent.change(screen.getByLabelText('Access up to'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Update access' })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('perimeter-preview').textContent).toMatch(/Up to Marketing, they can see/));
  });

  it('offers phase names from the current phase upward only', () => {
    open();
    const options = Array.from(
      (screen.getByLabelText('Access up to') as HTMLSelectElement).options,
    ).map((o) => o.textContent);
    expect(options).toEqual(['Preparation', 'Marketing', 'Diligence', 'Signing']);
  });

  it('rebinds when the chosen phase changes', async () => {
    open();
    await waitFor(() =>
      expect(screen.getByTestId('perimeter-preview').getAttribute('data-status')).toBe('ready'),
    );

    respond = () => ({ ok: true, status: 200, body: perimeter(9) });
    fireEvent.change(screen.getByLabelText('Access up to'), { target: { value: '3' } });

    await waitFor(() => expect(screen.getByTestId('perimeter-preview').textContent).toMatch(/9 document/));
    const last = previewCalls().at(-1) as [string, RequestInit];
    expect(JSON.parse(String(last[1].body)).member.phase).toBe(3);
  });

  it('does not show one person access under another', async () => {
    const { rerender } = open();
    await waitFor(() =>
      expect(screen.getByTestId('perimeter-preview').textContent).toMatch(/5 document/),
    );

    respond = () => ({ ok: true, status: 200, body: perimeter(1) });
    const other = member({ userId: 'u-2', displayName: 'Sam Okafor', phase: 0 });
    rerender(
      <MemberDetail
        dealId="PROJECT-X"
        member={other}
        companyMembers={[other]}
        viewerIsMd
        onChanged={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('perimeter-preview').textContent).not.toMatch(/5 document/));
    await waitFor(() => expect(screen.getByTestId('perimeter-preview').textContent).toMatch(/1 document/));
    const last = previewCalls().at(-1) as [string, RequestInit];
    expect(JSON.parse(String(last[1].body)).member.userId).toBe('u-2');
  });

  it('reports an uncheckable preview as unavailable, never as zero access', async () => {
    respond = () => ({ ok: false, status: 503, body: {} });
    open();

    const preview = await screen.findByTestId('perimeter-preview');
    await waitFor(() => expect(preview.getAttribute('data-status')).toBe('unavailable'));
    expect(preview.textContent).toMatch(/could not be checked/i);
    expect(preview.textContent).not.toMatch(/no documents are released/i);
  });

  it('sends the phase number and says so when the change lands', async () => {
    respond = (url, init) =>
      init?.method === 'PATCH'
        ? { ok: true, status: 200, body: {} }
        : { ok: true, status: 200, body: perimeter(5) };
    open();
    fireEvent.change(screen.getByLabelText('Access up to'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update access' }));
    expect(await screen.findByText('Access updated.')).toBeInTheDocument();
    const patch = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH') as [
      string,
      RequestInit,
    ];
    expect(patch[0]).toBe('/api/v1/deals/PROJECT-X/members/u-1');
    expect(JSON.parse(String(patch[1].body))).toEqual({ phase: 2 });
  });

  it('labels the everyone-at-the-firm results in words', async () => {
    respond = (url, init) =>
      init?.method === 'PATCH'
        ? { ok: false, status: 409, body: { error: 'Phase cannot go down.' } }
        : { ok: true, status: 200, body: perimeter(5) };
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Update everyone' }));
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry failed' })).toBeInTheDocument();
  });

  it('shows no access control for your own firm, where phase never gates', () => {
    open({ isExternal: false, dealRole: 'deal_team', companyName: 'Advisory Bank' });
    expect(screen.getByText('Every phase')).toBeInTheDocument();
    expect(screen.queryByLabelText('Access up to')).not.toBeInTheDocument();
    expect(screen.queryByTestId('perimeter-preview')).not.toBeInTheDocument();
  });

  it('shows no control to a viewer without the MD seat', () => {
    open({}, false);
    expect(screen.getByText('Up to Preparation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update access' })).not.toBeInTheDocument();
  });

  it('keeps both access selects on an offered value after the person is raised', async () => {
    const view = open({ phase: 1 });
    // The person's select starts on their current phase; the firm's one past it.
    expect((screen.getByLabelText('Access up to') as HTMLSelectElement).value).toBe('1');
    expect((screen.getByLabelText(/Access up to, everyone at Target Co/) as HTMLSelectElement).value).toBe('2');
    fireEvent.change(screen.getByLabelText('Access up to'), { target: { value: '2' } });
    // The roster reloads after a raise to Diligence: 2 is no longer offered.
    view.rerender(
      <MemberDetail
        dealId="PROJECT-X"
        member={member({ phase: 3 })}
        companyMembers={[member({ phase: 3 })]}
        viewerIsMd
        onChanged={() => {}}
      />,
    );
    const own = screen.getByLabelText('Access up to') as HTMLSelectElement;
    expect(own.value).toBe('3');
    expect(screen.getByRole('button', { name: 'Update access' })).toBeDisabled();
    const firmSelect = screen.getByLabelText(/Access up to, everyone at Target Co/) as HTMLSelectElement;
    expect(firmSelect.value).toBe('3');

    // What is on screen is what is sent.
    fireEvent.click(screen.getByRole('button', { name: 'Update everyone' }));
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'),
      ).toBe(true),
    );
    const patch = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH') as [string, RequestInit];
    expect(JSON.parse(String(patch[1].body))).toEqual({ phase: 3 });
  });

  it('offers no "Everyone at" change for a person with no company', () => {
    open({ companyId: null, companyName: null });
    expect(screen.getByRole('button', { name: 'Update access' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update everyone' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Everyone at/)).not.toBeInTheDocument();
  });

  it("keeps each refused person's reason under their Failed chip, and says how many were updated", async () => {
    const firm = ['u-1', 'u-2', 'u-3', 'u-4', 'u-5'].map((userId, i) =>
      member({ userId, displayName: `Person ${i + 1}`, fullName: `Person ${i + 1}` }),
    );
    respond = (url, init) =>
      init?.method === 'PATCH'
        ? url.endsWith('/u-3')
          ? { ok: false, status: 409, body: { error: 'Phase cannot go down.' } }
          : { ok: true, status: 200, body: {} }
        : { ok: true, status: 200, body: perimeter(5) };
    render(
      <MemberDetail dealId="PROJECT-X" member={firm[0]} companyMembers={firm} viewerIsMd onChanged={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Update everyone' }));
    expect(await screen.findByText(/Updated 4 of 5/)).toBeInTheDocument();
    const failed = screen.getByText('Failed').closest('li')!;
    expect(failed).toHaveTextContent('Person 3');
    expect(failed).toHaveTextContent('Phase cannot go down.');
  });
});
