import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InviteModal } from '@/components/team/InviteModal';
import type { LiveRoster } from '@/lib/team/roster';

/**
 * Parent-surface integration for the smart lookup (D8.5, D8.6).
 *
 * Rendering SmartLookupCard on its own would prove nothing about the behaviour
 * these criteria are actually about: whether a failed or superseded lookup
 * withdraws a pre-fill that has already been applied to a REAL form control,
 * and whether any of it can slip past the pre-send domain-confirmation gate
 * that shipped before this work. Both of those live in the parent, so the
 * parent is what gets rendered here.
 */

const ROSTER: LiveRoster = {
  bankCompanyId: 'bank-1',
  members: [
    {
      userId: 'md-1',
      displayName: 'Storm Duncan',
      fullName: 'Storm Duncan',
      email: 'md@bank.dev',
      dealRole: 'md',
      phase: 0,
      isExternal: false,
      companyId: 'bank-1',
      companyName: 'Advisory Bank',
      companyRole: 'director',
    },
  ],
  parties: [
    { companyId: 'seller-1', companyName: 'Target Co', partyRole: 'target' },
    { companyId: 'buyer-1', companyName: 'Vista Equity Partners', partyRole: 'acquirer_shortlist' },
  ],
};

const VIEWER = {
  id: 'md-1',
  isExternal: false,
  firmRole: null,
  companyId: 'bank-1',
  companyRole: 'director',
  isDealMd: true,
};

type Answer = { status: number; body: unknown };
/**
 * A handler may answer with a promise, which is what makes a DELIVERY ORDER
 * testable: a lookup can be left in flight across a click and resolved after
 * it, which is the shape of the race the confirmation gate has to survive.
 */
type Handler = (url: string, init?: RequestInit) => Answer | Promise<Answer>;

let handler: Handler;

function lookupBody(over: Record<string, unknown> = {}) {
  return {
    normalizedEmail: 'alex@target.dev',
    domain: 'target.dev',
    companyMatch: { companyId: 'seller-1', companyName: 'Target Co' },
    proposedCompany: null,
    warnings: [],
    recommendation: {
      dealRole: 'seller',
      companyRole: 'member',
      phase: 1,
      reasons: { dealRole: 'party_derived', phase: 'least_privilege_start' },
    },
    ...over,
  };
}

function bankLookupBody(
  dealRole: 'deal_team' | 'legal' | 'read_only' = 'legal',
  normalizedEmail = 'alex@bank.dev',
) {
  return lookupBody({
    normalizedEmail,
    domain: 'bank.dev',
    companyMatch: { companyId: 'bank-1', companyName: 'Advisory Bank' },
    recommendation: {
      dealRole,
      companyRole: 'member',
      phase: 0,
      reasons: { dealRole: 'employee_default', phase: 'phase_not_applicable_internal' },
    },
  });
}

beforeEach(() => {
  handler = (url) => {
    if (url.includes('/lookup')) return { status: 200, body: lookupBody() };
    if (url.includes('/perimeter-preview')) {
      return {
        status: 200,
        body: {
          dealContext: 'existing',
          perimeter: {
            destinations: ['mandate', 'rail', 'dataRoom', 'team'],
            documents: { total: 2, rooms: [{ room: 'deal', count: 2 }] },
            capabilities: { canUploadToDataRoom: true, canInviteTeammate: false },
            invariants: ['external_never_internal_room', 'external_never_mnpi'],
          },
        },
      };
    }
    if (url.includes('/preflight')) {
      return {
        status: 200,
        body: {
          confirmationRequired: true,
          confirmationId: 'conf-1',
          classification: 'mismatch',
          expiresAt: '2026-09-28T13:00:00Z',
        },
      };
    }
    return { status: 200, body: {} };
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const { status, body } = await handler(String(url), init);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function open() {
  return render(
    <InviteModal
      dealId="PROJECT-X"
      roster={ROSTER}
      viewer={VIEWER}
      onClose={() => {}}
      onCreated={() => {}}
      onResend={() => Promise.resolve({ ok: false })}
    />,
  );
}

function emailField() {
  return screen.getByLabelText(/email/i);
}

function lookupCalls() {
  return vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/lookup')).length;
}

/**
 * Wait until the lookup has stopped chasing itself.
 *
 * A recommendation that pre-fills the company changes one of the card's own
 * bound inputs, so the card immediately re-keys and looks up AGAIN. A test that
 * touches a bound input before that second cycle lands races it: the in-flight
 * delivery arrives after the change and re-applies what the change withdrew,
 * and the assertion fails against correct behaviour. The cascade has settled
 * when a full effect flush changes nothing: same status, same requests, same
 * form.
 */
async function lookupSettled() {
  const snapshot = () => {
    const dialog = screen.getByRole('dialog');
    // Control values, not just markup: React sets a select's value as a DOM
    // property, so a pre-filled company never shows up in innerHTML.
    const values = Array.from(dialog.querySelectorAll('input, select, textarea'))
      .map((el) => (el as HTMLInputElement).value)
      .join('\u0000');
    const status = screen.queryByTestId('smart-lookup-card')?.getAttribute('data-status') ?? null;
    return { status, key: `${lookupCalls()}|${values}|${dialog.innerHTML}` };
  };

  let last = snapshot();
  for (let i = 0; i < 50; i += 1) {
    // Each pass drains the pending passive effects, so a delivery that has not
    // reached the host yet cannot be mistaken for a settled cascade. Polling on
    // wall-clock time can observe the gap between the status flip and the
    // pre-fill, and read it as stability.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const now = snapshot();
    if (now.status === 'ready' && now.key === last.key && last.status === 'ready') return;
    last = now;
  }
  throw new Error(`lookup never settled (status ${last.status})`);
}

describe('lookup inside the Team invite modal', () => {
  it('closes on Escape and keeps Tab inside the dialog (#250)', () => {
    const onClose = vi.fn();
    render(
      <InviteModal
        dealId="PROJECT-X"
        roster={ROSTER}
        viewer={VIEWER}
        onClose={onClose}
        onCreated={() => {}}
        onResend={() => Promise.resolve({ ok: false })}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the actions visible while the form content scrolls within the viewport', () => {
    open();

    // No scope: the Mail recipient handoff, which may offer either side.
    const dialog = screen.getByRole('dialog', { name: 'Add recipient to deal' });
    const sendButton = screen.getByRole('button', { name: 'Check and send invite' });
    const form = dialog.querySelector('form') as HTMLFormElement;
    const scrollRegion = form.parentElement as HTMLElement;

    // The panel never outgrows the viewport; the form scrolls inside it and
    // the actions sit outside the scrolling region, so they stay on screen.
    expect(dialog.className).toContain('max-h-full');
    expect(scrollRegion.className).toContain('overflow-y-auto');
    expect(scrollRegion.contains(sendButton)).toBe(false);
    // The send button still submits this form from the actions row.
    expect(sendButton.getAttribute('form')).toBe(form.id);
  });

  it('shows the actionable director requirement returned by perimeter preview', async () => {
    handler = (url) => {
      if (url.includes('/lookup')) return { status: 503, body: {} };
      if (url.includes('/perimeter-preview')) {
        return {
          status: 409,
          body: {
            error:
              'This company needs its first active director. Invite this person as Company Director.',
            code: 'company_requires_director',
          },
        };
      }
      return { status: 200, body: {} };
    };
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    fireEvent.change(screen.getByLabelText(/^company$/i), {
      target: { value: 'seller-1' },
    });

    expect(
      await screen.findByText(
        'This company needs its first active director. Invite this person as Company Director.',
      ),
    ).toBeTruthy();
  });

  it('hides Member and selects Director when the company is unclaimed', async () => {
    handler = (url) =>
      url.includes('/lookup')
        ? {
            status: 200,
            body: lookupBody({
              companyRolePolicy: {
                companyId: 'seller-1',
                memberAllowed: false,
                directorAllowed: true,
                requiresDirector: true,
              },
            }),
          }
        : { status: 200, body: {} };
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });

    await lookupSettled();

    const role = screen.getByLabelText(/^role$/i) as HTMLSelectElement;
    expect(role.value).toBe('director');
    expect(screen.queryByRole('option', { name: 'Member' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Director' })).toBeTruthy();
    expect(
      screen.getAllByText(/first user must join as Company Director/i).length,
    ).toBeGreaterThan(0);
  });

  it('blocks the invitation when the company is unclaimed and the viewer cannot appoint its director', async () => {
    handler = (url) =>
      url.includes('/lookup')
        ? {
            status: 200,
            body: lookupBody({
              companyRolePolicy: {
                companyId: 'seller-1',
                memberAllowed: false,
                directorAllowed: false,
                requiresDirector: true,
              },
            }),
          }
        : { status: 200, body: {} };
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });

    await lookupSettled();

    expect(screen.queryByLabelText(/^role$/i)).toBeNull();
    expect(screen.getByRole('button', { name: /check and send/i })).toBeDisabled();
    expect(screen.getAllByText(/firm admin must send/i).length).toBeGreaterThan(0);
  });

  it('shows nothing until the address is plausible, and issues no request', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@' } });

    expect(screen.queryByTestId('smart-lookup-card')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/lookup'))).toHaveLength(0);
  });

  it('pre-fills the company control from the recommendation', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });

    await screen.findByText(/Target Co/);
    await waitFor(() => {
      const company = screen.getByLabelText(/company/i) as HTMLSelectElement;
      expect(company.value).toBe('seller-1');
    }, { timeout: 5000 });
  });

  it('withdraws the result when the address changes, and never shows it as current', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await screen.findByText(/Target Co/);

    // A slow response for the OLD address must not reappear as current.
    handler = (url) =>
      url.includes('/lookup')
        ? { status: 200, body: lookupBody({ normalizedEmail: 'sam@other.dev' }) }
        : { status: 200, body: {} };
    fireEvent.change(emailField(), { target: { value: 'sam@other.dev' } });

    const card = screen.getByTestId('smart-lookup-card');
    expect(['loading', 'stale']).toContain(card.getAttribute('data-status'));
  });

  it('renders a neutral unavailable state on failure, with no recommendation', async () => {
    handler = () => ({ status: 500, body: { error: 'boom' } });
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });

    await waitFor(() => {
      expect(screen.getByTestId('smart-lookup-card').getAttribute('data-status')).toBe('unavailable');
    }, { timeout: 5000 });
    expect(screen.queryByText(/proposed seat/i)).toBeNull();
    expect(screen.getByText(/Lookup is unavailable/i)).toBeTruthy();
  });

  it('still requires the pre-send domain confirmation after a lookup', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    // The company starts unset, so waiting for the name alone would match the
    // option in the list and click before the recommendation has selected it.
    // Wait for the selection itself.
    await waitFor(() =>
      expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('seller-1'),
    );

    fireEvent.click(screen.getByRole('button', { name: /check and send|confirm and send/i }));

    // First click reaches preflight and stops there: the gate that shipped
    // before this work is untouched by the recommendation.
    await waitFor(() => {
      const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/preflight'))).toBe(true);
      expect(urls.some((u) => u.endsWith('/api/v1/invites'))).toBe(false);
    }, { timeout: 5000 });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('applies an internal role recommendation to the untouched role select', async () => {
    handler = (url) =>
      url.includes('/lookup')
        ? { status: 200, body: bankLookupBody('legal') }
        : { status: 200, body: {} };
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@bank.dev' } });

    await waitFor(() => {
      expect((screen.getByLabelText(/^role$/i) as HTMLSelectElement).value).toBe('legal');
    }, { timeout: 5000 });
  });

  it('does not overwrite a role the inviter already chose', async () => {
    handler = (url) =>
      url.includes('/lookup')
        ? { status: 200, body: bankLookupBody('legal') }
        : { status: 200, body: {} };
    open();
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'bank-1' } });
    fireEvent.change(screen.getByLabelText(/^role$/i), { target: { value: 'read_only' } });
    fireEvent.change(emailField(), { target: { value: 'alex@bank.dev' } });

    await screen.findByText(/Proposed seat/i);
    expect((screen.getByLabelText(/^role$/i) as HTMLSelectElement).value).toBe('read_only');
  });

  it('retracts an applied role when the result goes stale', async () => {
    handler = (url) =>
      url.includes('/lookup')
        ? { status: 200, body: bankLookupBody('legal') }
        : { status: 200, body: {} };
    open();
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'bank-1' } });
    fireEvent.change(emailField(), { target: { value: 'alex@bank.dev' } });
    await waitFor(() => {
      expect((screen.getByLabelText(/^role$/i) as HTMLSelectElement).value).toBe('legal');
    }, { timeout: 5000 });

    handler = () => ({ status: 503, body: { error: 'Lookup is unavailable' } });
    fireEvent.change(emailField(), { target: { value: 'sam@bank.dev' } });
    await waitFor(() => {
      expect(screen.getByTestId('smart-lookup-card').getAttribute('data-status')).toBe(
        'unavailable',
      );
    }, { timeout: 5000 });
    expect((screen.getByLabelText(/^role$/i) as HTMLSelectElement).value).toBe('deal_team');
  });

  it('ignores an external role recommendation for the internal select', async () => {
    open();
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'bank-1' } });
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await screen.findByText(/Proposed seat/i);

    expect((screen.getByLabelText(/^role$/i) as HTMLSelectElement).value).toBe('deal_team');
  });
});

/**
 * The withdrawal half of A14.
 *
 * An earlier version of this file asserted only that the card entered a stale
 * state, and passed against a parent that kept the recommendation's values in
 * the form. The card's own status was never the risk: what gets SENT is.
 */
describe('withdrawing what the recommendation applied (A14)', () => {
  it('takes back the pre-filled company and phase when the lookup stops being current', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await screen.findByText(/Target Co/);

    await waitFor(() => {
      expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('seller-1');
    }, { timeout: 5000 });
    // The phase control exists because the recommended seat is external, and it
    // carries the recommended phase.
    expect((screen.getByLabelText(/^access up to$/i) as HTMLInputElement).value).toBe('1');

    // Now it fails. The card going quiet is not enough: the values it put in
    // the form have to come back out, or the inviter sends a seat with nothing
    // on screen recommending it.
    handler = () => ({ status: 503, body: { error: 'Lookup is unavailable' } });
    fireEvent.change(emailField(), { target: { value: 'alex@northgate-capital.com' } });

    await waitFor(() => {
      expect(screen.getByTestId('smart-lookup-card').getAttribute('data-status')).toBe(
        'unavailable',
      );
    }, { timeout: 5000 });
    await waitFor(() => {
      expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).not.toBe('seller-1');
    }, { timeout: 5000 });
    // With the recommended company withdrawn the seat is internal again, so the
    // external phase control is gone rather than sitting there holding a phase
    // nobody proposed. Either way, nothing recommended survives.
    const phaseField = screen.queryByLabelText(/^access up to$/i) as HTMLInputElement | null;
    expect(phaseField === null || phaseField.value === '0').toBe(true);
  });

  // D8.6: A14 binds EVERY bound input, not only the address. Company is one of
  // the four the card keys on, so changing it makes the standing recommendation
  // a statement about a company nobody is inviting into.
  //
  // The next lookup is held in flight rather than failed, on purpose. A failing
  // one would satisfy `status === 'unavailable'` as well as the key comparison,
  // and the test would pass with the key comparison deleted — proving nothing
  // about the input that actually changed. Pending isolates the key branch.
  it('takes back the recommended phase when the company changes, with no failure involved', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await screen.findByText(/Target Co/);
    await waitFor(() => {
      expect((screen.getByLabelText(/^access up to$/i) as HTMLInputElement).value).toBe('1');
    }, { timeout: 5000 });
    await lookupSettled();

    // Everything from here on stays pending: the card can only be stale, never
    // unavailable.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'buyer-1' } });

    await waitFor(() => {
      expect((screen.getByLabelText(/^access up to$/i) as HTMLInputElement).value).toBe('0');
    }, { timeout: 5000 });
    expect(screen.getByTestId('smart-lookup-card').getAttribute('data-status')).not.toBe(
      'unavailable',
    );
    // Their own company choice is untouched by the withdrawal.
    expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('buyer-1');
  });

  // D8.6: the other half of A9. A recommendation pre-fills; it does not decide.
  // A phase the inviter typed is theirs, and the NEXT recommendation must not
  // quietly take it back — the same delivery that legitimately moves the company
  // has to leave the phase alone.
  it('keeps a phase the inviter typed when a later recommendation arrives', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await screen.findByText(/Target Co/);
    await waitFor(() => {
      expect((screen.getByLabelText(/^access up to$/i) as HTMLInputElement).value).toBe('1');
    }, { timeout: 5000 });

    await lookupSettled();

    fireEvent.change(screen.getByLabelText(/^access up to$/i), { target: { value: '3' } });
    expect((screen.getByLabelText(/^access up to$/i) as HTMLInputElement).value).toBe('3');

    // A different address, a different real recommendation — one that succeeds.
    handler = (url) =>
      url.includes('/lookup')
        ? {
            status: 200,
            body: lookupBody({
              normalizedEmail: 'sam@vista.dev',
              domain: 'vista.dev',
              companyMatch: { companyId: 'buyer-1', companyName: 'Vista Equity Partners' },
              recommendation: {
                dealRole: 'buyer',
                companyRole: 'member',
                phase: 2,
                reasons: { dealRole: 'party_derived', phase: 'least_privilege_start' },
              },
            }),
          }
        : { status: 200, body: {} };
    fireEvent.change(emailField(), { target: { value: 'sam@vista.dev' } });

    // The new recommendation lands and is applied: the company moves.
    await screen.findByText(/Vista Equity Partners/);
    await waitFor(() => {
      expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('buyer-1');
    }, { timeout: 5000 });
    // The phase does not. Neither the withdrawal of the old result nor the
    // application of the new one overwrites what the inviter chose.
    expect((screen.getByLabelText(/^access up to$/i) as HTMLInputElement).value).toBe('3');
  });

  it('does not take back a company the inviter chose themselves', async () => {
    open();
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'buyer-1' } });
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await screen.findByText(/Target Co/);

    // Their choice stands against the recommendation.
    expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('buyer-1');

    handler = () => ({ status: 503, body: {} });
    fireEvent.change(emailField(), { target: { value: 'other@northgate-capital.com' } });
    await waitFor(() => {
      expect(screen.getByTestId('smart-lookup-card').getAttribute('data-status')).toBe(
        'unavailable',
      );
    }, { timeout: 5000 });
    // Withdrawal takes back the recommendation's values, not theirs.
    expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('buyer-1');
  });
});

/**
 * The company the form SHOWS is the company lookup is asked about (A5(b), A13).
 *
 * The select used to open on the advisory bank, so an inviter who touched
 * nothing still had a company on screen and in every request. Round four hid
 * that value from lookup alone, which made the visible selection and the
 * question disagree. The control now holds "unset" honestly, so these assert
 * the request body against the rendered value rather than trusting either.
 */
describe('binding lookup to the company the form shows', () => {
  function lookupBodies() {
    return vi
      .mocked(fetch)
      .mock.calls.filter(([u]) => String(u).includes('/lookup'))
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { companyId?: string | null });
  }
  const companyField = () => screen.getByLabelText(/company/i) as HTMLSelectElement;

  it('claims no company until one is actually selected', async () => {
    open();
    expect(companyField().value).toBe('');

    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await waitFor(() => expect(lookupBodies().length).toBeGreaterThan(0));
    // The first request necessarily precedes any pre-fill, so this is the
    // untouched state and nothing else.
    expect(lookupBodies()[0].companyId ?? null).toBeNull();

    await lookupSettled();
    expect(companyField().value).toBe('seller-1');
    expect(lookupBodies().at(-1)?.companyId).toBe('seller-1');
  });

  it('asks about the company the inviter picks, not the one it matched', async () => {
    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await lookupSettled();

    fireEvent.change(companyField(), { target: { value: 'bank-1' } });

    await waitFor(() => expect(lookupBodies().at(-1)?.companyId).toBe('bank-1'));
    expect(companyField().value).toBe('bank-1');
  });
});

/**
 * The confirmation gate against a lookup that is still in flight.
 *
 * The card re-keys whenever one of its bound inputs changes, so an inviter who
 * picks a company and then clicks can have a delivery land AFTER preflight has
 * already answered. That delivery reports the policy it always reported, and
 * the form is already showing the role it forces — nothing about the invitation
 * has changed — so it must not void the confirmation the inviter just obtained.
 * The browser journey caught this as a flake; the mechanism is deterministic
 * once the delivery order is controlled.
 */
describe('a lookup landing after preflight', () => {
  const DIRECTOR_ONLY = {
    companyId: 'buyer-1',
    memberAllowed: false,
    directorAllowed: true,
    requiresDirector: true,
  };

  function confirmButton() {
    return screen.getByRole('button', { name: /check and send|confirm and send/i });
  }

  function cardStatus() {
    return screen.getByTestId('smart-lookup-card').getAttribute('data-status');
  }

  it('keeps the confirmation when the late result forces the role already showing', async () => {
    let hold = false;
    let land: (() => void) | null = null;
    handler = (url) => {
      if (url.includes('/lookup')) {
        const answer = {
          status: 200,
          body: lookupBody({ companyRolePolicy: DIRECTOR_ONLY }),
        };
        if (!hold) return answer;
        return new Promise<Answer>((resolve) => {
          land = () => resolve(answer);
        });
      }
      if (url.includes('/preflight')) {
        return {
          status: 200,
          body: {
            confirmationRequired: true,
            confirmationId: 'conf-1',
            classification: 'unverified',
            expiresAt: '2026-09-28T13:00:00Z',
          },
        };
      }
      return { status: 200, body: {} };
    };

    open();
    fireEvent.change(emailField(), { target: { value: 'alex@target.dev' } });
    await lookupSettled();

    // From here every delivery is held, so the one the company change starts is
    // still in flight when the click below reaches preflight.
    hold = true;
    fireEvent.change(screen.getByLabelText(/company/i), { target: { value: 'buyer-1' } });
    fireEvent.change(screen.getByLabelText(/^role$/i), { target: { value: 'director' } });
    fireEvent.change(screen.getByLabelText(/^access up to$/i), {
      target: { value: '1' },
    });
    // The company change re-keyed the card, so it is showing the previous
    // result as stale while the delivery for the new key is held.
    await waitFor(() => expect(cardStatus()).not.toBe('ready'));

    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmButton().textContent).toBe('Confirm and send'));
    expect(screen.getByText(/no verified email domain/i)).toBeTruthy();

    // The held delivery lands now, reporting the same director-only policy the
    // form is already showing. Waiting for `ready` is the barrier: without it
    // the assertions below run before onResult has been applied and would pass
    // against the unfixed component.
    await waitFor(() => expect(land).not.toBeNull());
    land!();
    // Barrier on the delivery being APPLIED, not merely arrived: the Member
    // option disappears when setCompanyRolePolicy runs, which is the same
    // onResult call that used to clear the confirmation. Waiting on the card's
    // status instead would let these assertions run a commit too early and pass
    // against the unfixed component.
    await waitFor(() => expect(screen.queryByRole('option', { name: 'Member' })).toBeNull());
    expect(cardStatus()).toBe('ready');

    expect(confirmButton().textContent).toBe('Confirm and send');
    expect(screen.getByText(/no verified email domain/i)).toBeTruthy();
  });
});
