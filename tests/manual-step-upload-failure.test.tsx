import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ManualStepPanel } from '@/components/rail/ManualStepPanel';

/**
 * #331 pin (V5): the step upload route's 500 body changes from Box text to
 * `Dataroom storage failed (box_403)`, and the panel does not read it. A failed
 * upload still says `Upload failed`, whatever the body holds.
 */

vi.mock('next/navigation', () => ({ useParams: () => ({ projectId: 'atlas-2026' }) }));
vi.mock('@/lib/deals/useDeals', () => ({ useActiveDeal: () => ({ codename: 'Project Solstice' }) }));
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => key === 'gate0_api_create',
}));
vi.mock('@/lib/audit/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit/store')>()),
  logAudit: vi.fn(),
}));

// MD Briefing: an upload-required step.
const STEP_ID = 'p1-s9';

const stepResponse = {
  ok: true,
  status: 200,
  json: async () => ({
    step: { stepId: STEP_ID, status: 'current', assignedTo: null, assignedToName: null, work: {} },
    members: [],
    permissions: { isMd: true, canAssign: true, canComplete: true, canEditWork: true },
  }),
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && String(url).endsWith('/dataroom/upload')) {
        return new Response(JSON.stringify({ error: 'Dataroom storage failed (box_403)' }), { status: 500 });
      }
      return stepResponse as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ManualStepPanel upload failure', () => {
  it('shows Upload failed, not the response body, when the upload route answers 500', async () => {
    render(<ManualStepPanel dealId="atlas-2026" stepId={STEP_ID} />);

    const input = await screen.findByLabelText('Upload presearch / briefing document');
    fireEvent.change(input, { target: { files: [new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })] } });

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toBe('Upload failed');
    expect(document.body.textContent).not.toContain('Dataroom storage failed');
    expect(document.body.textContent).not.toContain('box_403');
  });
});
