import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

import { RemoveStepControl } from '@/components/rail/RemoveStepControl';
import { RemovedStepsSection } from '@/components/rail/RemovedStepsSection';
import { GATE0_STEP_IDS } from '@/lib/rail/gate0';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';

function step(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: 'uuid-1',
    stepId: 'custom:abc',
    origin: 'custom',
    phaseIndex: 2,
    displayOrder: 5,
    seq: null,
    status: 'pending',
    definition: { title: 'Weekly project update', description: 'd' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

function rail(steps: ProjectRailStep[]): ProjectRail {
  return {
    currentStepId: null,
    canEditStructure: true,
    canSaveTemplate: false,
    phases: [],
    steps,
  };
}

describe('RemoveStepControl', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  });

  it('is disabled and says why for a protected step', () => {
    render(
      <RemoveStepControl
        projectId="deal-1"
        step={step({ stepId: [...GATE0_STEP_IDS][0], origin: 'catalog' })}
        canRemove
        onRemoved={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: /remove/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/required/i)).toBeInTheDocument();
    // The visible sentence is the button's description (S6-23), not the title alone.
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')).toHaveTextContent(
      'This step is required and cannot be removed.',
    );
  });

  it('is disabled and says why for a completed step', () => {
    render(
      <RemoveStepControl
        projectId="deal-1"
        step={step({ status: 'complete' })}
        canRemove
        onRemoved={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: /remove/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')).toHaveTextContent(
      'This step is completed and cannot be removed.',
    );
  });

  it('renders no control at all for a caller without structural authority', () => {
    const { container } = render(
      <RemoveStepControl projectId="deal-1" step={step()} canRemove={false} onRemoved={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms once before it calls DELETE', async () => {
    const onRemoved = vi.fn();
    render(
      <RemoveStepControl projectId="deal-1" step={step()} canRemove onRemoved={onRemoved} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /remove step/i }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/v1/deals/deal-1/rail/steps/uuid-1');
    expect(init.method).toBe('DELETE');
    expect(onRemoved).toHaveBeenCalled();
  });

  it('keeps the step and shows the conflict when the server refuses', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'A completed step cannot be removed' }),
    })) as unknown as typeof fetch;
    const onRemoved = vi.fn();
    render(<RemoveStepControl projectId="deal-1" step={step()} canRemove onRemoved={onRemoved} />);

    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove step/i }));

    await waitFor(() =>
      expect(screen.getByText('A completed step cannot be removed.')).toBeInTheDocument(),
    );
    expect(onRemoved).not.toHaveBeenCalled();
  });
});

describe('RemovedStepsSection', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch;
  });

  it('renders nothing when no step has been removed', () => {
    const { container } = render(
      <RemovedStepsSection projectId="deal-1" rail={rail([step()])} canRestore onRestored={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each removed step with when it was removed', () => {
    render(
      <RemovedStepsSection
        projectId="deal-1"
        rail={rail([
          step({
            removedAt: '2026-09-09T10:00:00Z',
            removedBy: { id: 'user-storm', name: 'Storm Duncan' },
          }),
        ])}
        canRestore
        onRestored={vi.fn()}
      />,
    );
    expect(screen.getByText('Weekly project update')).toBeInTheDocument();
    expect(screen.getByText(/Storm Duncan/)).toBeInTheDocument();
  });

  it('says a step nobody removed was left out of the saved rail', () => {
    render(
      <RemovedStepsSection
        projectId="deal-1"
        rail={rail([step({ removedAt: '2026-09-09T10:00:00Z', removedBy: null })])}
        canRestore
        onRestored={vi.fn()}
      />,
    );
    expect(screen.getByText('Left out of the saved rail')).toBeInTheDocument();
  });

  it('posts to the restore route and reports back', async () => {
    const onRestored = vi.fn();
    render(
      <RemovedStepsSection
        projectId="deal-1"
        rail={rail([
          step({
            removedAt: '2026-09-09T10:00:00Z',
            removedBy: { id: 'user-storm', name: 'Storm Duncan' },
          }),
        ])}
        canRestore
        onRestored={onRestored}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());

    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/api/v1/deals/deal-1/rail/steps/uuid-1/restore');
    expect(init.method).toBe('POST');
  });

  it('offers no Restore action without structural authority', () => {
    render(
      <RemovedStepsSection
        projectId="deal-1"
        rail={rail([
          step({
            removedAt: '2026-09-09T10:00:00Z',
            removedBy: { id: 'user-storm', name: 'Storm Duncan' },
          }),
        ])}
        canRestore={false}
        onRestored={vi.fn()}
      />,
    );
    expect(screen.getByText('Weekly project update')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore/i })).not.toBeInTheDocument();
  });
});

describe('remove and restore failures read plainly', () => {
  it('a 500 shows the plain sentence and never the server text; the server text goes to the console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom internal: pg 23505' }),
    })) as unknown as typeof fetch;
    const onRemoved = vi.fn();
    render(<RemoveStepControl projectId="deal-1" step={step()} canRemove onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove step' }));
    expect(await screen.findByText('The step was not removed. Try again.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('pg 23505');
    expect(consoleError).toHaveBeenCalledWith(expect.any(String), 500, 'boom internal: pg 23505');
    expect(onRemoved).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('a network failure says so in the confirm, with no unhandled rejection', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    render(<RemoveStepControl projectId="deal-1" step={step()} canRemove onRemoved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove step' }));
    expect(
      await screen.findByText('This step could not be removed. Check your connection and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove step' })).toBeEnabled();
  });

  it('a failed restore shows the plain sentence, never the server text', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom internal: pg 23505' }),
    })) as unknown as typeof fetch;
    render(
      <RemovedStepsSection
        projectId="deal-1"
        rail={rail([step({ removedAt: '2026-09-09T10:00:00Z', removedBy: { id: 'user-storm', name: 'Storm Duncan' } })])}
        canRestore
        onRestored={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    expect(await screen.findByText('The step was not restored. Try again.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('pg 23505');
    consoleError.mockRestore();
  });
});
