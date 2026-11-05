import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { CandidateActions } from '@/components/discovery/CandidateActions';
import { PREFILL_PROMOTION_FROM_CANDIDATE, PromoteDialog } from '@/components/discovery/PromoteDialog';
import { takeGate0Receipt } from '@/lib/deals/gate0Receipt';
import { setStoreOwner } from '@/lib/session/storeOwner';

const PARTIES = [{ name: 'Northwind Robotics', domain: 'northwind-robotics.example' }];

let fetchMock: ReturnType<typeof vi.fn>;
let status = 201;
let payload: unknown = {
  deal: { id: 'deal-1', code: 'KESTR-2026-412' },
  notified: [{ userId: 'cco-1', at: '2026-10-09T10:00:00Z' }],
  screening: { verdict: 'compliant', reasons: [] },
};

beforeEach(() => {
  status = 201;
  payload = {
    deal: { id: 'deal-1', code: 'KESTR-2026-412' },
    notified: [{ userId: 'cco-1', at: '2026-10-09T10:00:00Z' }],
    screening: { verdict: 'compliant', reasons: [] },
  };
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(payload), { status })));
  vi.stubGlobal('fetch', fetchMock);
  // The signed-in banker, as the shell's auth listener knows them: the Gate 0
  // receipt is stamped with, and only handed back to, this user (#162).
  setStoreOwner('user-md');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  push.mockReset();
  setStoreOwner(null);
});

const renderDialog = (overrides: Partial<React.ComponentProps<typeof PromoteDialog>> = {}) => {
  const onClose = vi.fn();
  render(
    <PromoteDialog
      candidateId="c-kestrel"
      guessedName="Project Kestrel"
      guessedCodename="Project Kestrel"
      parties={PARTIES}
      defaultStepId="p4-s48"
      origin="rules"
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onClose };
};

const fill = () => {
  fireEvent.change(screen.getByLabelText('Code name'), { target: { value: ' Project Kestrel ' } });
  fireEvent.change(screen.getByLabelText('Target name'), { target: { value: ' Northwind Robotics ' } });
  fireEvent.change(screen.getByLabelText('Conflicts approved by'), { target: { value: ' Avery Lindqvist ' } });
};

describe('PromoteDialog', () => {
  it('ships the pre-filled default (T11 b, owner 2026-10-22)', () => {
    expect(PREFILL_PROMOTION_FROM_CANDIDATE).toBe(true);
  });

  it('pre-fills the code name and target from what discovery suggests, and both stay editable', () => {
    renderDialog();
    expect(screen.getByText(/Discovery suggests Project Kestrel, Northwind Robotics/)).toBeInTheDocument();
    expect(screen.getByLabelText('Code name')).toHaveValue('Project Kestrel');
    expect(screen.getByLabelText('Target name')).toHaveValue('Northwind Robotics');
    fireEvent.change(screen.getByLabelText('Code name'), { target: { value: 'Project Osprey' } });
    expect(screen.getByLabelText('Code name')).toHaveValue('Project Osprey');
  });

  it('starts the entry step at the MD\'s override or the suggestion, and lists no Gate 0 notice step', () => {
    renderDialog();
    const select = screen.getByLabelText('Starting step') as HTMLSelectElement;
    expect(select.value).toBe('48');
    expect(within(select).getByRole('option', { name: '44 · LOI Review' })).toBeInTheDocument();
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('0');
  });

  it('keeps Open mandate disabled until the code name, target and conflicts approver are typed', () => {
    renderDialog();
    const submit = screen.getByRole('button', { name: 'Open mandate' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Code name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Conflicts approved by'), { target: { value: ' Avery Lindqvist ' } });
    expect(submit).toBeDisabled();
    fill();
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Approved on'), { target: { value: '2999-01-01' } });
    expect(submit).toBeDisabled();
  });

  it('posts the Gate 0 fields, stashes the discovery receipt and lands on the rail', async () => {
    renderDialog();
    fill();
    fireEvent.change(screen.getByLabelText('Starting step'), { target: { value: '51' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open mandate' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/KESTR-2026-412/rail?new=1'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/deals/from-discovery');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      candidateId: 'c-kestrel',
      codename: 'Project Kestrel',
      targetName: 'Northwind Robotics',
      entryStepSeq: 51,
      conflictsAttestation: { approvedBy: 'Avery Lindqvist' },
    });
    expect(body.conflictsAttestation.approvedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(body).sort()).toEqual(['candidateId', 'codename', 'conflictsAttestation', 'entryStepSeq', 'targetName']);

    expect(takeGate0Receipt('KESTR-2026-412')).toEqual({
      verdict: 'compliant',
      recipients: 1,
      at: '2026-10-09T10:00:00Z',
      origin: 'discovery',
    });
  });

  it('never hands the discovery receipt to another user (#162)', async () => {
    renderDialog();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Open mandate' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/KESTR-2026-412/rail?new=1'));

    setStoreOwner('user-other');
    expect(takeGate0Receipt('KESTR-2026-412')).toBeNull();
    // Read as foreign, it is dropped: not even its banker gets it back later.
    setStoreOwner('user-md');
    expect(takeGate0Receipt('KESTR-2026-412')).toBeNull();
  });

  it('shows the server\'s message and stays put when the mandate cannot be opened', async () => {
    status = 409;
    payload = { error: 'This proposed deal is already a mandate' };
    renderDialog();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Open mandate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This proposed deal is already a mandate');
    expect(push).not.toHaveBeenCalled();
    expect(takeGate0Receipt('KESTR-2026-412')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open mandate' })).toBeEnabled();
  });

  it('closes on Cancel', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CandidateActions promote', () => {
  const actions = (canAct: React.ComponentProps<typeof CandidateActions>['canAct']) =>
    render(
      <CandidateActions
        candidateId="c-kestrel"
        name="Project Kestrel"
        placedStepId="p4-s48"
        origin="rules"
        canAct={canAct}
        codename="Project Kestrel"
        parties={PARTIES}
        onChanged={vi.fn()}
      />,
    );

  it('offers Promote to mandate and opens the dialog', async () => {
    actions({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: 'Promote to mandate' }));
    expect(await screen.findByRole('dialog', { name: 'Open the mandate' })).toBeInTheDocument();
  });

  it('disables it with the reason when the viewer cannot act', () => {
    actions({ ok: false, reason: 'no_authority' });
    expect(screen.getByRole('button', { name: 'Promote to mandate' })).toBeDisabled();
    expect(screen.getByText('Needs deal-create authority')).toBeInTheDocument();
  });
});

// THE PIN (G-02b design R10, threads TH-1 and TH-9). On a deal the model found, the Promote dialog starts unpicked, or at
// the MD's own override, and never at a station a machine chose. G-07 and every later change to the Promote default
// must keep these passing: "preferredAssessment" driving the default is exactly what they forbid on model-origin.
describe('PromoteDialog on a model-origin deal (pin)', () => {
  const entry = () => screen.getByLabelText('Starting step') as HTMLSelectElement;
  /** The model's proposed station for the deal, and the evidence's own suggestion: both are machines. */
  const MODEL_STEP = 'p2-s26';
  const EVIDENCE_STEP = 'p4-s48';

  it('starts unpicked when the MD set no station, and says "Choose a step"', () => {
    renderDialog({ origin: 'model_proposal', defaultStepId: null });
    expect(entry().value).toBe('');
    expect(within(entry()).getByRole('option', { name: 'Choose a step' })).toBeInTheDocument();
  });

  it('starts at the MD\'s own override', () => {
    renderDialog({ origin: 'model_proposal', defaultStepId: EVIDENCE_STEP });
    expect(entry().value).toBe('48');
  });

  it('keeps Open mandate disabled until the MD picks a station, then posts that pick', async () => {
    renderDialog({ origin: 'model_proposal', defaultStepId: null });
    fill();
    const submit = screen.getByRole('button', { name: 'Open mandate' });
    expect(submit).toBeDisabled();
    fireEvent.change(entry(), { target: { value: '51' } });
    expect(submit).toBeEnabled();
    expect(within(entry()).queryByRole('option', { name: 'Choose a step' })).not.toBeInTheDocument();
    fireEvent.click(submit);
    await waitFor(() => expect(push).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).entryStepSeq).toBe(51);
  });

  it('is unchanged on a rules-found deal: with no station given it still starts on the first station', () => {
    renderDialog({ origin: 'rules', defaultStepId: null });
    expect(entry().value).not.toBe('');
    expect(within(entry()).queryByRole('option', { name: 'Choose a step' })).not.toBeInTheDocument();
  });

  it('fails closed with no origin: it starts unpicked, never on a machine station', () => {
    renderDialog({ origin: undefined, defaultStepId: null });
    expect(entry().value).toBe('');
    expect(within(entry()).getByRole('option', { name: 'Choose a step' })).toBeInTheDocument();
  });

  it('fails closed with no origin from the deal page: the evidence suggestion is not carried into Promote', async () => {
    render(
      <CandidateActions
        candidateId="c-falcon"
        name="Falcon"
        placedStepId={EVIDENCE_STEP}
        origin={undefined}
        canAct={{ ok: true }}
        codename="Falcon"
        parties={PARTIES}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Promote to mandate' }));
    await screen.findByRole('dialog', { name: 'Open the mandate' });
    expect(entry().value).toBe('');
  });

  describe('from the deal page (CandidateActions)', () => {
    const open = (props: Partial<React.ComponentProps<typeof CandidateActions>>) => {
      render(
        <CandidateActions
          candidateId="c-falcon"
          name="Falcon"
          placedStepId={MODEL_STEP}
          origin="model_proposal"
          canAct={{ ok: true }}
          codename="Falcon"
          parties={PARTIES}
          onChanged={vi.fn()}
          {...props}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Promote to mandate' }));
    };

    it('does not carry the model\'s proposed station into Promote', async () => {
      open({
        proposal: { stepId: MODEL_STEP, reason: 'The model placed 3 of 4 emails in Phase 2', source: 'model_proposal' },
      });
      await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect(entry().value).toBe('');
    });

    it('does not carry an evidence suggestion into Promote either', async () => {
      open({
        placedStepId: EVIDENCE_STEP,
        proposal: { stepId: EVIDENCE_STEP, reason: 'LOI Review because LOI signed', source: 'evidence' },
      });
      await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect(entry().value).toBe('');
    });

    it('does not carry it in when the caller forgot to pass the override: unpicked is the safe direction', async () => {
      open({ placedStepId: MODEL_STEP, overrideStepId: undefined });
      await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect(entry().value).toBe('');
    });

    it('starts at the MD\'s override', async () => {
      open({ placedStepId: EVIDENCE_STEP, overrideStepId: EVIDENCE_STEP });
      await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect(entry().value).toBe('48');
    });

    it('still starts a rules-found deal at its station', async () => {
      open({ origin: 'rules', placedStepId: EVIDENCE_STEP });
      await screen.findByRole('dialog', { name: 'Open the mandate' });
      expect(entry().value).toBe('48');
    });
  });
});
