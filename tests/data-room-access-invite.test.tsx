import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { DataRoomAccessInvite } from '@/components/dataroom/DataRoomAccessInvite';
import { clearRecipientAddition, peekRecipientAddition, queueRecipientAddition } from '@/lib/team/recipientAddition';

/** The Data Room slot is the shared invite in data-room mode; Mail's "Give {email} data room access" fills the email. */

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response);

const posts: Array<Record<string, unknown>> = [];

const health = { membersStatus: 200, external: false };
const requested: string[] = [];

function stub(invitesStatus = 200) {
  posts.length = 0;
  requested.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/api/v1/invites/preflight')) return json({ confirmationRequired: false, normalizedEmail: 'out@outside.test' });
      if (url.endsWith('/api/v1/invites') && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json({ invite: { id: 'i1', email: 'out@outside.test', deliveryStatus: 'sent' } }, 201);
      }
      if (url.endsWith('/api/v1/me')) {
        return json({
          user: { id: 'md-1', is_external: health.external, firm_role: null, company_id: 'bank-1', company_role: 'director' },
          memberships: [{ deal_id: 'ZZ-A', deal_role: health.external ? 'seller' : 'md', deal_code: 'ZZ-A' }],
        });
      }
      if (url.endsWith('/members')) {
        if (health.membersStatus !== 200) return json({ error: 'down' }, health.membersStatus);
        return json({
          bankCompanyId: 'bank-1',
          members: [],
          parties: [{ companyId: 'seller-1', companyName: 'Target Co', partyRole: 'target' }],
        });
      }
      if (url.includes('/api/v1/invites?')) return json({ invites: [] }, invitesStatus);
      return json({}, 503);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearRecipientAddition();
  health.membersStatus = 200;
  health.external = false;
});

it('shows the invite button and opens nothing by itself', async () => {
  stub();
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  expect(await screen.findByRole('button', { name: 'Give data room access' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('opens with the address Mail handed over, then forgets it', async () => {
  stub();
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  const dialog = await screen.findByRole('dialog', { name: 'Give data room access' });
  expect(within(dialog).getByLabelText('Email')).toHaveValue('out@outside.test');
  expect(peekRecipientAddition('ZZ-A', 'data-room')).toBeNull();

  // Recipient mode: the deal relationship is required and travels as recipientAffiliation.
  fireEvent.change(within(dialog).getByLabelText('Company'), { target: { value: 'seller-1' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check and send invite' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose the recipient’s deal relationship');
  expect(posts).toHaveLength(0);
  fireEvent.change(within(dialog).getByLabelText('Deal relationship'), { target: { value: 'client' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check and send invite' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ email: 'out@outside.test', companyId: 'seller-1', recipientAffiliation: 'client', representedCompanyId: null });
});

it('refuses an advisor relationship with no represented party, and sends nothing', async () => {
  stub();
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  const dialog = await screen.findByRole('dialog', { name: 'Give data room access' });
  fireEvent.change(within(dialog).getByLabelText('Company'), { target: { value: 'seller-1' } });
  fireEvent.change(within(dialog).getByLabelText('Deal relationship'), { target: { value: 'client_advisor' } });
  expect(within(dialog).getByLabelText('Represented deal party')).toHaveValue('');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check and send invite' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Choose the recipient’s deal relationship and represented party.',
  );
  expect(posts).toHaveLength(0);
  expect(requested.some((url) => url.endsWith('/api/v1/invites/preflight'))).toBe(false);
});

it('ignores the address Mail queued for Team', async () => {
  stub();
  queueRecipientAddition('ZZ-A', 'col@firm.test', 'team');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  await screen.findByRole('button', { name: 'Give data room access' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(peekRecipientAddition('ZZ-A', 'team')).toBe('col@firm.test');
});

it('says a deal manager must add the recipient when the viewer may not invite', async () => {
  stub(403);
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  expect(await screen.findByRole('status')).toHaveTextContent('A deal manager must add this recipient to the deal.');
  expect(screen.queryByRole('button', { name: 'Give data room access' })).toBeNull();
});

it('shows nothing extra to a viewer who may not invite and arrived without a Mail address', async () => {
  stub(403);
  const { container } = render(<DataRoomAccessInvite dealId="ZZ-A" />);
  await new Promise((r) => setTimeout(r, 20));
  expect(container).toBeEmptyDOMElement();
});

// A failed read never drops the Mail handoff silently.
it('says the invite form could not be loaded when the members read fails on a handoff, and keeps the handoff', async () => {
  health.membersStatus = 500;
  stub();
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('The invite form could not be loaded.');
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(peekRecipientAddition('ZZ-A', 'data-room')).toBe('out@outside.test');
});

it('Try again after the members read recovers opens the form with the address and the relationship required', async () => {
  health.membersStatus = 500;
  stub();
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  const retry = await screen.findByRole('button', { name: 'Try again' });
  health.membersStatus = 200;
  fireEvent.click(retry);
  const dialog = await screen.findByRole('dialog', { name: 'Give data room access' });
  expect(within(dialog).getByLabelText('Email')).toHaveValue('out@outside.test');
  expect(peekRecipientAddition('ZZ-A', 'data-room')).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('Company'), { target: { value: 'seller-1' } });
  expect(within(dialog).getByLabelText('Deal relationship')).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check and send invite' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Choose the recipient’s deal relationship');
  expect(posts).toHaveLength(0);
});

it('a failed read without a handoff still renders nothing (no button to offer)', async () => {
  health.membersStatus = 500;
  stub();
  const { container } = render(<DataRoomAccessInvite dealId="ZZ-A" />);
  await new Promise((r) => setTimeout(r, 20));
  expect(container).toBeEmptyDOMElement();
});

// An outside viewer's Data Room never reads the roster; the
// reads wait for /me, so nothing is fetched before the viewer is known.
it('makes no roster or invite-list request for an outside viewer', async () => {
  health.external = true;
  stub();
  const { container } = render(<DataRoomAccessInvite dealId="ZZ-A" />);
  await waitFor(() => expect(requested.some((u) => u.endsWith('/api/v1/me'))).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(requested.some((u) => u.endsWith('/members'))).toBe(false);
  expect(requested.some((u) => u.includes('/api/v1/invites?'))).toBe(false);
  expect(container).toBeEmptyDOMElement();
});

it('reads the roster only after /me answers for a bank viewer', async () => {
  stub();
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  await screen.findByRole('button', { name: 'Give data room access' });
  const me = requested.findIndex((u) => u.endsWith('/api/v1/me'));
  const members = requested.findIndex((u) => u.endsWith('/members'));
  expect(me).toBeGreaterThanOrEqual(0);
  expect(members).toBeGreaterThan(me);
});

// A handoff the viewer cannot use is spent once the line says so.
it('consumes the handoff when the deal manager line renders', async () => {
  stub(403);
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  expect(await screen.findByRole('status')).toHaveTextContent('A deal manager must add this recipient to the deal.');
  await waitFor(() => expect(peekRecipientAddition('ZZ-A', 'data-room')).toBeNull());
});

it('an outside viewer with a handoff reads the deal manager line, the handoff is spent, and no roster is read', async () => {
  health.external = true;
  stub();
  queueRecipientAddition('ZZ-A', 'out@outside.test', 'data-room');
  render(<DataRoomAccessInvite dealId="ZZ-A" />);
  expect(await screen.findByRole('status')).toHaveTextContent('A deal manager must add this recipient to the deal.');
  await waitFor(() => expect(peekRecipientAddition('ZZ-A', 'data-room')).toBeNull());
  expect(requested.some((u) => u.endsWith('/members'))).toBe(false);
});
