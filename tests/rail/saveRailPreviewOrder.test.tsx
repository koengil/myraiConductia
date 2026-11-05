import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { PREVIEW_ORDER_NOT_INCLUDED, SaveRailDialog } from '@/components/rail/SaveRailDialog';
import type { ProjectRail } from '@/lib/rail/projectRail';

/*
 * With a reorder Preview active, Save rail says
 * plainly that the moved order is not included; without one it says nothing.
 */

const rail: ProjectRail = {
  currentStepId: 'step-1',
  canEditStructure: true,
  canSaveTemplate: true,
  phases: [{ index: 1, name: 'Origination', dealStatus: 'active' }],
  steps: [],
};

vi.mock('@/lib/rail/projectRail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rail/projectRail')>();
  return {
    ...actual,
    useProjectRail: () => ({ rail, status: 'ready', refresh: vi.fn(), skipStep: vi.fn(), stepRecords: [] }),
  };
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ templates: [] }) }) as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Save rail and a pending Preview order', () => {
  it('says the moved order is not included when a Preview move is active', async () => {
    render(<SaveRailDialog dealId="D-1" previewOrderPending onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText(PREVIEW_ORDER_NOT_INCLUDED)).toBeInTheDocument();
    expect(PREVIEW_ORDER_NOT_INCLUDED).toBe(
      "The order you moved in this browser is not included. The saved rail keeps the deal's saved order.",
    );
  });

  it('says nothing about an order when no Preview is active', async () => {
    render(<SaveRailDialog dealId="D-1" onClose={() => {}} onSaved={() => {}} />);
    await screen.findByRole('dialog', { name: 'Save rail' });
    expect(screen.queryByText(PREVIEW_ORDER_NOT_INCLUDED)).not.toBeInTheDocument();
  });
});
