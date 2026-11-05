import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import RailTemplatesPageClient from '@/app/(authed)/rail-templates/page.client';
import {
  DEFAULT_LOCKED_COPY,
  FIXED_STEP_COPY,
  PUBLISH_PREVIEW_ORDER_COPY,
  REORDER_PREVIEW_COPY,
} from '@/app/(authed)/rail-templates/TemplateDetailPanel';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE } from '@/lib/constants/roles';

const { useCurrentUserMock } = vi.hoisted(() => ({
  useCurrentUserMock: vi.fn(),
}));

vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: useCurrentUserMock,
}));

const ready = (permissionKeys: string[]) => ({
  status: 'ready' as const,
  data: {
    user: {
      id: 'u-1',
      email: 'rob@bank.test',
      full_name: 'Rob',
      display_name: 'Rob',
      firm_role: null,
      department: null,
      is_external: false,
      status: 'active',
      company_id: 'co-bank',
      company_role: COMPANY_ROLE.MEMBER,
      can_invite: false,
    },
    company: { id: 'co-bank', name: 'Bank' },
    mandate: null,
    company_permissions: permissionKeys.map((permissionKey) => ({
      permissionKey,
      source: { type: 'direct' as const, id: null, name: 'Direct grant' },
    })),
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Rails configuration page', () => {
  it('asks for the permission when the caller cannot configure templates', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([]) });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mine: [] }) }));

    render(<RailTemplatesPageClient />);

    expect(await screen.findByRole('heading', { name: 'Rails configuration' })).toBeInTheDocument();
    expect(screen.getByText(/need permission/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create template' })).not.toBeInTheDocument();
  });

  it('shows no hint line telling the banker to open Default (S6-12)', async () => {
    useCurrentUserMock.mockReturnValue({
      state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          templates: [
            { id: null, name: 'Default', kind: 'default', stepCount: 61, forkedFromName: null, createdAt: null },
          ],
        }),
      }),
    );

    render(<RailTemplatesPageClient />);

    expect(await screen.findByRole('button', { name: /Default/ })).toBeInTheDocument();
    expect(screen.queryByText(/Open Default to see/)).not.toBeInTheDocument();
  });

  it('lists the house default and creates a named copy from it', async () => {
    useCurrentUserMock.mockReturnValue({
      state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          templates: [
            {
              id: null,
              name: 'Default',
              kind: 'default',
              stepCount: 61,
              forkedFromName: null,
              createdAt: null,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ template: { id: 'rob', name: 'Rob' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          templates: [
            {
              id: null,
              name: 'Default',
              kind: 'default',
              stepCount: 61,
              forkedFromName: null,
              createdAt: null,
            },
            {
              id: 'rob',
              name: 'Rob',
              kind: 'saved',
              stepCount: 61,
              forkedFromName: 'Default',
              createdAt: '2026-10-01T00:00:00Z',
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);

    expect(await screen.findByText('Built into Conductia · 61 steps')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'New template' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    const dialog = screen.getByRole('dialog', { name: 'New template' });
    // The dialog names the default rail it starts from before "Create template".
    expect(within(dialog).getByTestId('template-starting-point')).toHaveTextContent(
      'Starts from your default rail. A new deal gets it unless someone picks a template, and its 61 steps come across in their phases.',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Start from' })).toHaveAccessibleDescription(
      /Starts from your default rail\./,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Rob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create template' }));

    await waitFor(() => {
      expect(screen.getByText('Started from Default · 61 steps')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/rail-catalog',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Rob', sourceTemplateId: null }),
      }),
    );
  });

  it('deletes a saved template after confirmation', async () => {
    useCurrentUserMock.mockReturnValue({
      state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
    });
    const listed = {
      ok: true,
      json: async () => ({
        templates: [
          {
            id: null,
            name: 'Default',
            kind: 'default',
            stepCount: 61,
            forkedFromName: null,
            forkedFromRemoved: false,
            createdAt: null,
          },
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Rob',
            kind: 'saved',
            stepCount: 2,
            forkedFromName: 'Default',
            forkedFromRemoved: false,
            createdAt: null,
          },
        ],
      }),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return { ok: true, json: async () => ({ deleted: true }) };
      return listed;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Actions for Rob' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete template…' }));
    expect(await screen.findByRole('dialog', { name: 'Delete Rob?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete template' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/rail-catalog/11111111-1111-4111-8111-111111111111',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Rob?' })).not.toBeInTheDocument());
  });

  it('opens a saved template and removes a step', async () => {
    useCurrentUserMock.mockReturnValue({
      state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
    });
    const detail = {
      template: {
        id: 'rob',
        name: 'Rob',
        kind: 'saved',
        editable: true,
        forkedFromName: 'Default',
      },
      phases: [{ index: 1, name: 'Origination' }],
      availableCatalogSteps: [],
      steps: [
        {
          id: 'step-1',
          stepId: 'p1-s1',
          title: 'Target universe',
          description: 'The buyers worth a first conversation.',
          seq: 1,
          phaseIndex: 1,
          phaseName: 'Origination',
          displayOrder: 1,
          origin: 'catalog',
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return { ok: true, json: async () => ({ removed: true }) };
      if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
      if (url.endsWith('/rob')) return { ok: true, json: async () => detail };
      return {
        ok: true,
        json: async () => ({
          templates: [
            {
              id: 'rob',
              name: 'Rob',
              kind: 'saved',
              stepCount: 1,
              forkedFromName: 'Default',
              createdAt: null,
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    expect(await screen.findByText('Target universe')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Target universe' }));

    // Nothing is sent until Remove is pressed in the confirmation.
    const confirm = await screen.findByRole('dialog', { name: 'Remove Target universe from this template?' });
    const deletes = () => fetchMock.mock.calls.filter((call) => ((call as unknown[])[1] as RequestInit | undefined)?.method === 'DELETE');
    expect(deletes()).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/rail-catalog/rob/steps/step-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
    expect(deletes()).toHaveLength(1);
  });

  it('offers no Remove on a step every deal needs, and Cancel sends nothing', async () => {
    useCurrentUserMock.mockReturnValue({
      state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
    });
    const view = (id: string, stepId: string, title: string, order: number) => ({
      id,
      stepId,
      title,
      description: '',
      seq: null,
      phaseIndex: 1,
      phaseName: 'Origination',
      displayOrder: order,
      origin: 'catalog',
    });
    const detail = {
      template: { id: 'rob', name: 'Rob', kind: 'saved', editable: true, forkedFromName: 'Default' },
      phases: [{ index: 1, name: 'Origination' }],
      availableCatalogSteps: [],
      steps: [view('step-cn', 'p1-s7', 'Codename', 1), view('step-1', 'p1-s1', 'Target universe', 2)],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return { ok: true, json: async () => ({ removed: true }) };
      if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
      if (url.endsWith('/rob')) return { ok: true, json: async () => detail };
      return { ok: true, json: async () => ({ templates: [summary('rob', 'Rob')] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    expect(await screen.findByText('Codename')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Codename' })).not.toBeInTheDocument();
    expect(screen.getAllByText(FIXED_STEP_COPY).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Target universe' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Target universe from this template?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.mock.calls.some((call) => ((call as unknown[])[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('names a step from the gap between names and opens its details', async () => {
    useCurrentUserMock.mockReturnValue({
      state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]),
    });
    const detail = {
      template: {
        id: 'rob',
        name: 'Rob',
        kind: 'saved',
        editable: true,
        forkedFromName: 'Default',
      },
      phases: [{ index: 1, name: 'Origination' }],
      availableCatalogSteps: [],
      steps: [
        {
          id: 'step-1',
          stepId: 'p1-s1',
          title: 'Target universe',
          description: 'The buyers worth a first conversation.',
          seq: 1,
          phaseIndex: 1,
          phaseName: 'Origination',
          displayOrder: 1,
          origin: 'catalog',
        },
        {
          id: 'step-2',
          stepId: 'p1-s2',
          title: 'First call',
          description: '',
          seq: 2,
          phaseIndex: 1,
          phaseName: 'Origination',
          displayOrder: 2,
          origin: 'catalog',
        },
      ],
    };
    const draft = {
      id: '11111111-1111-4111-8111-111111111111',
      dealId: 'rob',
      status: 'active',
      name: '',
      placement: { kind: 'after', phaseIndex: 1, afterStepId: 'step-1' },
      composerText: '',
      editRevision: 1,
      messages: [],
      activeAttempt: null,
      candidate: {
        id: '22222222-2222-4222-8222-222222222222',
        digest: 'ab'.repeat(32),
        schemaVersion: 1,
        name: 'Probe',
        purpose: 'A first look.',
        expectedInput: 'Notes',
        expectedOutput: 'A list',
        inputs: [],
      },
      publication: { available: false },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/skill-drafts') && url.endsWith('/publish')) {
        return {
          ok: true,
          json: async () => ({ stepId: '33333333-3333-4333-8333-333333333333', digest: 'ab'.repeat(32) }),
        };
      }
      if (url.includes('/skill-drafts') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { name?: string };
        return { ok: true, json: async () => ({ draft: { ...draft, name: body.name ?? '', editRevision: 2 } }) };
      }
      if (url.includes('/skill-drafts')) return { ok: true, json: async () => ({ draft }) };
      if (init?.method === 'PATCH') {
        return { ok: true, json: async () => ({ description: 'A first look at the buyers.' }) };
      }
      if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
      if (url.endsWith('/rob')) return { ok: true, json: async () => detail };
      return {
        ok: true,
        json: async () => ({
          templates: [
            {
              id: 'rob',
              name: 'Rob',
              kind: 'saved',
              stepCount: 2,
              forkedFromName: 'Default',
              createdAt: null,
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    expect(await screen.findByText('First call')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Step name' })).not.toBeInTheDocument();

    const gaps = screen.getAllByRole('button', { name: 'Add a step here' });
    fireEvent.click(gaps[1]);
    const dialog = await screen.findByRole('dialog', { name: 'Skill builder' });
    expect(screen.getByText('Describe the skill you want to build.')).toBeInTheDocument();
    expect(screen.getByText('Skill preview')).toBeInTheDocument();
    await waitFor(() => {
      // The gap clicked is the placement, shown as one line until Change.
      expect(screen.getByTestId('placement-summary')).toHaveTextContent('Adds after: Target universe');
    });
    expect(screen.queryByRole('combobox', { name: /^Position/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change where this step goes' }));
    expect(screen.getByRole('combobox', { name: /^Position/ })).toHaveValue('after:step-1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Step name' }), { target: { value: 'Probe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save skill and add step' }));

    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/rail-catalog/rob/skill-drafts/11111111-1111-4111-8111-111111111111/publish',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    expect(screen.getByRole('dialog', { name: 'Target universe' })).toBeInTheDocument();
    expect(screen.getByText('House step')).toBeInTheDocument();
    const description = screen.getByRole('textbox', { name: 'Description' });
    expect(description).toHaveValue('The buyers worth a first conversation.');
    fireEvent.change(description, { target: { value: 'A first look at the buyers.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/rail-catalog/rob/steps/step-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ description: 'A first look at the buyers.' }),
        }),
      );
    });
  });
});

type Publication = {
  published: { version: number; revisionId: string; publishedAt: string } | null;
  hasUnpublishedChanges: boolean;
};

function robList() {
  return {
    ok: true,
    json: async () => ({
      templates: [
        { id: 'rob', name: 'Rob', kind: 'saved', stepCount: 1, forkedFromName: 'Default', createdAt: null },
      ],
    }),
  };
}

function robDetail(publication: Publication) {
  return {
    template: { id: 'rob', name: 'Rob', kind: 'saved', editable: true, forkedFromName: 'Default' },
    phases: [{ index: 1, name: 'Origination' }],
    availableCatalogSteps: [],
    steps: [
      {
        id: 'step-1',
        stepId: 'p1-s1',
        title: 'Target universe',
        description: '',
        seq: 1,
        phaseIndex: 1,
        phaseName: 'Origination',
        displayOrder: 1,
        origin: 'catalog',
      },
    ],
    ...publication,
  };
}

function publishFetch(
  before: Publication,
  after: Publication,
  publishResponse: { ok: boolean; status: number; body: unknown },
) {
  let published = false;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/publish') && init?.method === 'POST') {
      published = publishResponse.ok;
      return {
        ok: publishResponse.ok,
        status: publishResponse.status,
        json: async () => publishResponse.body,
      };
    }
    if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
    if (url.endsWith('/rob')) {
      return { ok: true, json: async () => robDetail(published ? after : before) };
    }
    return robList();
  });
}

describe('Publishing a rail template', () => {
  it('shows the published version and publishes the changes once', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const fetchMock = publishFetch(
      {
        published: { version: 3, revisionId: 'rev-3', publishedAt: '2026-10-02T12:00:00.000Z' },
        hasUnpublishedChanges: true,
      },
      {
        published: { version: 4, revisionId: 'rev-4', publishedAt: '2026-10-05T12:00:00.000Z' },
        hasUnpublishedChanges: false,
      },
      { ok: true, status: 200, body: { templateId: 'tpl-1', revisionId: 'rev-4', version: 4, stepCount: 1 } },
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    expect(await screen.findByText('Version 3 · published Oct 2, 2026')).toBeInTheDocument();
    expect(screen.getByText('Changes not published')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Publish changes' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(await screen.findByText('Version 4 · published Oct 5, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Changes not published')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
    const publishCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/publish'));
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toEqual([
      '/api/v1/rail-catalog/rob/publish',
      expect.objectContaining({ method: 'POST' }),
    ]);
  });

  it('says when a template is not published yet and offers the first publish', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const unpublished = { published: null, hasUnpublishedChanges: true };
    vi.stubGlobal('fetch', publishFetch(unpublished, unpublished, { ok: true, status: 200, body: {} }));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));

    expect(await screen.findByText('Not published yet')).toBeInTheDocument();
    expect(screen.queryByText('Changes not published')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeEnabled();
  });

  it('shows why a publish was refused, in plain copy', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const changed = {
      published: { version: 2, revisionId: 'rev-2', publishedAt: '2026-10-02T12:00:00.000Z' },
      hasUnpublishedChanges: true,
    };
    vi.stubGlobal(
      'fetch',
      publishFetch(changed, changed, {
        ok: false,
        status: 409,
        body: { error: 'This template is missing a step every deal needs, so it cannot be published.' },
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Publish changes' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This template is missing a step every deal needs, so it cannot be published.',
    );
    expect(alert.textContent).not.toContain('—');
  });

  it('disables publishing when the published version is current', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const current = {
      published: { version: 2, revisionId: 'rev-2', publishedAt: '2026-10-02T12:00:00.000Z' },
      hasUnpublishedChanges: false,
    };
    vi.stubGlobal('fetch', publishFetch(current, current, { ok: true, status: 200, body: {} }));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));

    expect(await screen.findByText('Version 2 · published Oct 2, 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeDisabled();
  });

  it('shows no publish controls on the house template', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/default')) {
          return {
            ok: true,
            json: async () => ({
              template: { id: null, name: 'Default', kind: 'default', editable: false, forkedFromName: null },
              phases: [{ index: 1, name: 'Origination' }],
              availableCatalogSteps: [],
              steps: [],
              published: null,
              hasUnpublishedChanges: false,
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            templates: [
              { id: null, name: 'Default', kind: 'default', stepCount: 61, forkedFromName: null, createdAt: null },
            ],
          }),
        };
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Default' }));

    expect(await screen.findByText(DEFAULT_LOCKED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish changes' })).not.toBeInTheDocument();
  });
});

const PUBLISH_SCOPE_COPY = 'This description stays on this template. It is not part of the published version.';

function detailsFetch(kind: 'saved' | 'default') {
  const step = (
    id: string,
    stepId: string,
    title: string,
    origin: 'catalog' | 'custom',
    order: number,
    hasSkill = false,
  ) => ({
    id,
    stepId,
    title,
    description: 'Context',
    seq: origin === 'catalog' ? order : null,
    phaseIndex: 1,
    phaseName: 'Origination',
    displayOrder: order,
    origin,
    hasSkill,
  });
  const saved = kind === 'saved';
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PATCH') {
      return { ok: true, json: async () => ({ id: 'rob', description: 'For any carve-out.', changed: true }) };
    }
    if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
    if (url.endsWith(saved ? '/rob' : '/default')) {
      return {
        ok: true,
        json: async () => ({
          template: {
            id: saved ? 'rob' : null,
            name: saved ? 'Rob' : 'Default',
            description: saved ? 'For carve-outs.' : '',
            kind,
            editable: saved,
            forkedFromName: saved ? 'Default' : null,
          },
          phases: [{ index: 1, name: 'Origination' }],
          availableCatalogSteps: [],
          steps: [
            step('step-1', 'p1-s1', 'Target universe', 'catalog', 1),
            ...(saved
              ? [
                  step('step-2', 'custom-1', 'Buyer probe', 'custom', 2),
                  step('step-3', 'custom-2', 'Buyer long list', 'custom', 3, true),
                ]
              : []),
          ],
          published: null,
          hasUnpublishedChanges: false,
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        templates: [
          {
            id: saved ? 'rob' : null,
            name: saved ? 'Rob' : 'Default',
            kind,
            stepCount: 1,
            forkedFromName: saved ? 'Default' : null,
            createdAt: null,
          },
        ],
      }),
    };
  });
}

describe('Step details publish scope', () => {
  it('says a house step description stays on an editable template', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', detailsFetch('saved'));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    await screen.findByText('Target universe');
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);

    const note = screen.getByText(PUBLISH_SCOPE_COPY);
    expect(note).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveAccessibleDescription(PUBLISH_SCOPE_COPY);
  });

  it('does not say it for a custom step of an editable template', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', detailsFetch('saved'));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    await screen.findByText('Buyer probe');
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[1]);

    expect(screen.getByText('Custom step')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    expect(screen.queryByText(PUBLISH_SCOPE_COPY)).not.toBeInTheDocument();
  });

  it('does not say it on the house default template', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', detailsFetch('default'));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Default' }));
    await screen.findByText('Target universe');
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);

    expect(screen.getByText('House step')).toBeInTheDocument();
    expect(screen.queryByText(PUBLISH_SCOPE_COPY)).not.toBeInTheDocument();
  });

  it('marks a step that holds a skill, in the list and in its details', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', detailsFetch('saved'));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    await screen.findByText('Buyer long list');

    expect(screen.getAllByText('Skill')).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[2]);

    expect(screen.getByText('Skill step')).toBeInTheDocument();
    expect(screen.queryByText('Custom step')).not.toBeInTheDocument();
  });
});

describe('Template description', () => {
  it('shows the description and saves an edit', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const fetchStub = detailsFetch('saved');
    vi.stubGlobal('fetch', fetchStub);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    expect(await screen.findByText('For carve-outs.')).toBeInTheDocument();

    // Click straight into the description to type.
    fireEvent.click(screen.getByRole('button', { name: /^Edit description\.\s*For carve-outs\./ }));
    expect(screen.getByRole('textbox', { name: 'Template description' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Template description' })).toHaveValue('For carve-outs.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Template description' }), {
      target: { value: 'For any carve-out.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));

    await waitFor(() =>
      expect(
        fetchStub.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/rob') &&
            (init as RequestInit | undefined)?.method === 'PATCH' &&
            JSON.parse(String((init as RequestInit).body)).description === 'For any carve-out.',
        ),
      ).toBe(true),
    );
  });

  it('puts the saved text back when the save fails, says so, and offers the typed text again', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const base = detailsFetch('saved');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return { ok: false, json: async () => ({ error: 'Keep the description within 500 characters.' }) };
        }
        return base(input, init);
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit description/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template description' }), {
      target: { value: 'Typed text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Keep the description within 500 characters. Your edit was not saved.',
    );
    // The unsaved text never shows as the description.
    expect(screen.queryByRole('textbox', { name: 'Template description' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Edit description\.\s*For carve-outs\./ })).toBeInTheDocument();
    expect(screen.queryByText('Typed text')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit again' }));
    expect(screen.getByRole('textbox', { name: 'Template description' })).toHaveValue('Typed text');
  });

  it('offers no editor on the house default', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', detailsFetch('default'));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Default' }));
    await screen.findByText('Target universe');

    expect(screen.queryByRole('button', { name: /Edit description/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

function summary(id: string, name: string) {
  return { id, name, kind: 'saved', stepCount: 58, forkedFromName: 'Default', forkedFromRemoved: false, createdAt: '2026-10-01T12:00:00Z' };
}

const DEFAULT_SUMMARY = {
  id: null,
  name: 'Default',
  kind: 'default',
  stepCount: 61,
  forkedFromName: null,
  forkedFromRemoved: false,
  createdAt: null,
};

describe('Rails configuration list', () => {
  it('groups templates and filters them by name as you type', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const names = ['Carve-out', 'Debt advisory', 'Healthcare carve-out', 'Minority stake', 'Recap', 'Software sell-side', 'Spin-off', 'Tech sell-side'];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ templates: [DEFAULT_SUMMARY, ...names.map((n, i) => summary(`t-${i}`, n))] }),
      })),
    );

    render(<RailTemplatesPageClient />);

    const savedGroup = await screen.findByRole('list', { name: /Saved by your firm/ });
    expect(screen.getByRole('list', { name: 'Built in' })).toBeInTheDocument();
    expect(within(savedGroup).getAllByRole('listitem')).toHaveLength(8);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search templates' }), { target: { value: 'carve' } });
    expect(within(screen.getByRole('list', { name: /Saved by your firm/ })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('list', { name: 'Built in' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Healthcare carve-out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recap' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search templates' }), { target: { value: 'nothing like it' } });
    expect(screen.getByRole('status')).toHaveTextContent('No template matches “nothing like it”.');
  });

  it('says what a new template starts with when a saved source is chosen', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ templates: [DEFAULT_SUMMARY, summary('rob', 'Rob')] }) })),
    );

    render(<RailTemplatesPageClient />);
    await screen.findByRole('button', { name: 'Rob' });
    fireEvent.click(screen.getByRole('button', { name: 'New template' }));
    const dialog = screen.getByRole('dialog', { name: 'New template' });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Start from' }), { target: { value: 'rob' } });

    expect(within(dialog).getByTestId('template-starting-point')).toHaveTextContent(
      'Starts as a copy of Rob, and its 58 steps come across in their phases. Rob stays as it is.',
    );

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New template' })).not.toBeInTheDocument());
  });
});

describe('Publish audience', () => {
  const published = {
    published: { version: 2, revisionId: 'rev-2', publishedAt: '2026-10-02T12:00:00.000Z' },
    hasUnpublishedChanges: true,
  };

  function renderWithReview(on: boolean) {
    const map = Object.fromEntries(
      (Object.keys(FLAG_REGISTRY) as FlagKey[]).map((key) => [key, false]),
    ) as FlagMap;
    render(
      <FlagsProvider value={{ ...map, template_change_review: on }}>
        <RailTemplatesPageClient />
      </FlagsProvider>,
    );
  }

  it('states beside "Publish changes" who gets it, with template change review on', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', publishFetch(published, published, { ok: true, status: 200, body: {} }));

    renderWithReview(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));

    const button = await screen.findByRole('button', { name: 'Publish changes' });
    expect(button).toHaveAccessibleDescription(
      'New deals that start from Rob get the published version. Open deals on Rob get a notice, and their team accepts or discards each added or removed step. Nothing changes on those deals until they choose.',
    );
  });

  it('says open deals keep their rail when template change review is off', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', publishFetch(published, published, { ok: true, status: 200, body: {} }));

    renderWithReview(false);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));

    expect(await screen.findByTestId('publish-audience')).toHaveTextContent(
      'New deals that start from Rob get the published version. Open deals keep the rail they started with.',
    );
  });
});

describe('The default rail', () => {
  it('is locked with its reason and offers a new template from it', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', detailsFetch('default'));

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Default' }));
    await screen.findByText('Target universe');

    expect(screen.getByText(DEFAULT_LOCKED_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a step here' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-drag-handle]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'New template from Default' }));
    const dialog = screen.getByRole('dialog', { name: 'New template' });
    expect(within(dialog).getByRole('combobox', { name: 'Start from' })).toHaveValue('');
    expect(within(dialog).getByTestId('template-starting-point')).toHaveTextContent('Starts from your default rail.');
  });
});

describe('A stale template load keeps the error banner', () => {
  it('a reload for a template no longer open leaves the open template\'s error in place', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const rob = {
      template: { id: 'rob', name: 'Rob', description: '', kind: 'saved', editable: true, forkedFromName: 'Default' },
      phases: [{ index: 2, name: 'Preparation' }],
      availableCatalogSteps: [],
      steps: [
        { id: 'step-1', stepId: 'custom-a', title: 'Buyer probe', description: '', seq: null, phaseIndex: 2, phaseName: 'Preparation', displayOrder: 1, origin: 'custom' },
      ],
    };
    let releaseDelete: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') {
          await new Promise<void>((resolve) => {
            releaseDelete = resolve;
          });
          return { ok: true, json: async () => ({ removed: true }) };
        }
        if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
        if (url.endsWith('/rob')) return { ok: true, json: async () => rob };
        if (url.endsWith('/ann')) return { ok: false, status: 404, json: async () => ({ error: 'Template not found.' }) };
        return { ok: true, json: async () => ({ templates: [summary('rob', 'Rob'), summary('ann', 'Ann')] }) };
      }),
    );
    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Buyer probe' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Buyer probe from this template?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));

    // Meanwhile Ann is opened and fails to load.
    fireEvent.click(screen.getByRole('button', { name: 'Ann' }));
    expect(await screen.findByText('Template not found.')).toBeInTheDocument();

    // Rob's remove settles and reloads Rob: a stale load for Ann's banner.
    releaseDelete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('Template not found.')).toBeInTheDocument();
  });
});

describe('Template description wrapping', () => {
  it('lets an unbroken description wrap anywhere', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const long = 'x'.repeat(400);
    const detail = {
      template: { id: 'rob', name: 'Rob', description: long, kind: 'saved', editable: true, forkedFromName: 'Default' },
      phases: [{ index: 2, name: 'Preparation' }],
      availableCatalogSteps: [],
      steps: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
        if (url.endsWith('/rob')) return { ok: true, json: async () => detail };
        return { ok: true, json: async () => ({ templates: [summary('rob', 'Rob')] }) };
      }),
    );
    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    const text = await screen.findByText(long);
    expect(text).toHaveAttribute('data-template-description');
    expect(text.className).toContain('[overflow-wrap:anywhere]');
  });
});

describe('Template failures read plainly', () => {
  it('a 500 on the description save shows the plain sentence, never the server text', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detail = {
      template: { id: 'rob', name: 'Rob', description: 'Old text', kind: 'saved', editable: true, forkedFromName: 'Default' },
      phases: [{ index: 2, name: 'Preparation' }],
      availableCatalogSteps: [],
      steps: [
        { id: 'step-1', stepId: 'custom-a', title: 'Buyer probe', description: '', seq: null, phaseIndex: 2, phaseName: 'Preparation', displayOrder: 1, origin: 'custom' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'PATCH') return { ok: false, status: 500, json: async () => ({ error: 'boom internal: pg 23505' }) };
        if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
        if (url.endsWith('/rob')) return { ok: true, json: async () => detail };
        return { ok: true, json: async () => ({ templates: [summary('rob', 'Rob')] }) };
      }),
    );
    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit description/ }));
    const box = await screen.findByLabelText('Template description');
    fireEvent.change(box, { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the description.');
    expect(document.body.textContent).not.toContain('pg 23505');
    consoleError.mockRestore();
  });

  it('a 500 on Remove shows "The step was not removed. Try again."', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const detail = {
      template: { id: 'rob', name: 'Rob', description: '', kind: 'saved', editable: true, forkedFromName: 'Default' },
      phases: [{ index: 2, name: 'Preparation' }],
      availableCatalogSteps: [],
      steps: [
        { id: 'step-1', stepId: 'custom-a', title: 'Buyer probe', description: '', seq: null, phaseIndex: 2, phaseName: 'Preparation', displayOrder: 1, origin: 'custom' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') return { ok: false, status: 500, json: async () => ({ error: 'boom internal: pg 23505' }) };
        if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
        if (url.endsWith('/rob')) return { ok: true, json: async () => detail };
        return { ok: true, json: async () => ({ templates: [summary('rob', 'Rob')] }) };
      }),
    );
    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Buyer probe' }));
    const confirm = await screen.findByRole('dialog', { name: 'Remove Buyer probe from this template?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('The step was not removed. Try again.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('pg 23505');
    consoleError.mockRestore();
  });
});

describe('Template step order (Preview)', () => {
  function orderFetch() {
    const step = (id: string, stepId: string, title: string, phaseIndex: number, order: number) => ({
      id,
      stepId,
      title,
      description: '',
      seq: null,
      phaseIndex,
      phaseName: phaseIndex === 1 ? 'Origination' : 'Preparation',
      displayOrder: order,
      origin: 'custom',
      hasSkill: false,
    });
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/changes')) return { ok: true, json: async () => ({ changes: [] }) };
      if (url.endsWith('/rob')) {
        return {
          ok: true,
          json: async () => ({
            template: { id: 'rob', name: 'Rob', description: '', kind: 'saved', editable: true, forkedFromName: 'Default' },
            phases: [
              { index: 1, name: 'Origination' },
              { index: 2, name: 'Preparation' },
            ],
            availableCatalogSteps: [],
            steps: [
              step('s-gate', 'p1-s6', 'Conflicts check', 1, 1),
              step('s-a', 'custom-a', 'Buyer probe', 2, 2),
              step('s-b', 'custom-b', 'Buyer long list', 2, 3),
              step('s-c', 'custom-c', 'Teaser', 2, 4),
            ],
            published: null,
            hasUnpublishedChanges: true,
          }),
        };
      }
      return { ok: true, json: async () => ({ templates: [summary('rob', 'Rob')] }) };
    });
  }

  const titlesIn = (phase: string) =>
    within(screen.getByRole('list', { name: new RegExp(`^${phase}`) }))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-step-row'))
      .filter(Boolean);

  it('moves a step in this browser only, marks it Preview, and resets', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const fetchMock = orderFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    await screen.findByText('Teaser');
    expect(titlesIn('Preparation')).toEqual(['s-a', 's-b', 's-c']);
    // A step every deal needs stays put and says why; the others can be dragged.
    expect(screen.getAllByText(FIXED_STEP_COPY).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Move Conflicts check' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-drag-handle]')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Move Buyer probe' }));
    const dialog = await screen.findByRole('dialog', { name: 'Buyer probe' });
    expect(within(dialog).getByText(REORDER_PREVIEW_COPY)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('radio', { name: /After 04 · Teaser/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move step' }));

    await waitFor(() => expect(titlesIn('Preparation')).toEqual(['s-b', 's-c', 's-a']));
    expect(screen.getByText('Moved in this browser')).toBeInTheDocument();
    const banner = document.querySelector('[data-preview="banner"]') as HTMLElement;
    expect(banner).toHaveTextContent(REORDER_PREVIEW_COPY);
    // Nothing is sent: every call is a read.
    expect(fetchMock.mock.calls.every((call) => !((call as unknown[])[1] as RequestInit | undefined)?.method)).toBe(true);
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeEnabled();

    fireEvent.click(within(banner).getByRole('button', { name: 'Reset' }));
    expect(titlesIn('Preparation')).toEqual(['s-a', 's-b', 's-c']);
    expect(screen.queryByText('Moved in this browser')).not.toBeInTheDocument();
  });

  it('says Publish leaves a Preview order out, and publishes the saved order', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const fetchMock = orderFetch();
    vi.stubGlobal('fetch', fetchMock);

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    await screen.findByText('Teaser');
    expect(screen.queryByText(PUBLISH_PREVIEW_ORDER_COPY)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move Buyer probe' }));
    const dialog = await screen.findByRole('dialog', { name: 'Buyer probe' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /After 04 · Teaser/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move step' }));
    await waitFor(() => expect(titlesIn('Preparation')).toEqual(['s-b', 's-c', 's-a']));

    expect(screen.getByTestId('publish-preview-order')).toHaveTextContent(
      "The order you moved in this browser is not included. Publishing uses the template's saved order.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/rail-catalog/rob/publish')).toBe(true),
    );
    const publish = fetchMock.mock.calls.find(([u]) => String(u) === '/api/v1/rail-catalog/rob/publish')!;
    const init = (publish as unknown[])[1] as RequestInit;
    expect(init.method).toBe('POST');
    // The publish carries no step order: the server publishes the template's saved order.
    expect(init.body).toBeUndefined();
    // No other write carried the Preview order either.
    const writes = fetchMock.mock.calls.filter((call) => ((call as unknown[])[1] as RequestInit | undefined)?.method);
    expect(writes).toHaveLength(1);
  });
});

describe('template page edge cases', () => {
  it('says only published templates are offered to new deals', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ templates: [DEFAULT_SUMMARY] }) })));

    render(<RailTemplatesPageClient />);

    expect(await screen.findByText(/^New deals can start from published templates\./)).toBeInTheDocument();
  });

  it('settles the description editor when the reload after a save fails', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const base = detailsFetch('saved');
    let saved = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          saved = true;
          return { ok: true, json: async () => ({ description: 'For any carve-out.' }) };
        }
        if (saved && String(input).endsWith('/rob')) throw new TypeError('Failed to fetch');
        return base(input, init);
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit description/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template description' }), {
      target: { value: 'For any carve-out.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));

    expect(await screen.findByRole('button', { name: /^Edit description\.\s*For any carve-out\./ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Saving' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not open the template.');
  });

  it('holds Remove while a description saves', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const base = detailsFetch('saved');
    let finish: (value: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          await new Promise((resolve) => {
            finish = resolve;
          });
          return { ok: true, json: async () => ({ description: 'x' }) };
        }
        return base(input, init);
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Edit description/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Template description' }), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save description' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Target universe' })).toBeDisabled());
    finish(null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Target universe' })).toBeEnabled());
  });

  it('drops a template response that arrives after another template was opened', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const savedFetch = detailsFetch('saved');
    const defaultFetch = detailsFetch('default');
    let releaseRob: () => void = () => {};
    const robHeld = new Promise<void>((resolve) => {
      releaseRob = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/rob')) {
          await robHeld;
          return savedFetch(input, init);
        }
        if (url.endsWith('/default') || url.endsWith('/default/changes')) return defaultFetch(input, init);
        if (url.endsWith('/rail-catalog')) {
          return {
            ok: true,
            json: async () => ({ templates: [DEFAULT_SUMMARY, summary('rob', 'Rob')] }),
          };
        }
        return savedFetch(input, init);
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(await screen.findByText(DEFAULT_LOCKED_COPY)).toBeInTheDocument();

    releaseRob();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('heading', { level: 2, name: 'Default' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Rob' })).not.toBeInTheDocument();
  });

  it('shows a refused step description save inside the open dialog', async () => {
    useCurrentUserMock.mockReturnValue({ state: ready([COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE]) });
    const base = detailsFetch('saved');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return { ok: false, json: async () => ({ error: 'Keep the description within 4000 characters.' }) };
        }
        return base(input, init);
      }),
    );

    render(<RailTemplatesPageClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rob' }));
    await screen.findByText('Target universe');
    fireEvent.click(screen.getAllByRole('button', { name: 'Details' })[0]);
    const dialog = screen.getByRole('dialog', { name: 'Target universe' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Description' }), { target: { value: 'Typed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Keep the description within 4000 characters. Your edit was not saved.',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Description' })).toHaveValue('Typed');
  });
});
