import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { TemplateDetailPanel, type TemplateDetail } from '@/app/(authed)/rail-templates/TemplateDetailPanel';

/*
 * The template skill builder's `open` comes from state. Closing sets it
 * false while the builder is still mounted, so the shared dialog can play its
 * exit motion (the dialog itself is stubbed: it records the open prop).
 */

const seen = vi.hoisted(() => ({ open: [] as boolean[], unmounted: 0 }));
vi.mock('@/components/rail/SkillBuilderDialog', () => ({
  SkillBuilderDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) => {
    seen.open.push(open);
    React.useEffect(() => () => {
      seen.unmounted += 1;
    }, []);
    return (
      <div data-testid="builder" data-open={String(open)}>
        {open ? (
          <button type="button" onClick={onClose}>
            Close builder
          </button>
        ) : null}
      </div>
    );
  },
}));

const detail: TemplateDetail = {
  template: { id: 'rob', name: 'Rob', description: '', kind: 'saved', editable: true, forkedFromName: 'Default' },
  phases: [{ index: 2, name: 'Preparation' }],
  availableCatalogSteps: [],
  steps: [
    {
      id: 'step-1',
      stepId: 'custom-a',
      title: 'Buyer probe',
      description: '',
      seq: null,
      phaseIndex: 2,
      phaseName: 'Preparation',
      displayOrder: 1,
      origin: 'custom',
    } as TemplateDetail['steps'][number],
  ],
};

afterEach(() => {
  cleanup();
  seen.open.length = 0;
  seen.unmounted = 0;
});

describe('TemplateSkillBuilder open state', () => {
  it('closing sets open false before unmount, so the dialog sees its closing state', () => {
    render(
      <TemplateDetailPanel
        detail={detail}
        error={null}
        editing={false}
        changes={[]}
        publishing={false}
        publishError={null}
        changeReviewOn={false}
        headingRef={React.createRef()}
        onPublish={() => {}}
        onAdded={() => {}}
        onRemove={() => {}}
        onSaveDescription={async () => null}
        onSaveTemplateDescription={async () => null}
        onUndo={() => {}}
        onStartFromDefault={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Add a step here' })[0]);
    expect(screen.getByTestId('builder')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Close builder' }));
    // Still mounted, now closing: the dialog received open=false.
    expect(screen.getByTestId('builder')).toHaveAttribute('data-open', 'false');
    expect(seen.open.at(-1)).toBe(false);
    expect(seen.unmounted).toBe(0);
  });
});
