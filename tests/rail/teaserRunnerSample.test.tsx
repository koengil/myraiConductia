import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

import { SAMPLE_DRAFT_COPY, TeaserRunner } from '@/components/rail/TeaserRunner';
import { SessionProvider, useSession } from '@/lib/session/store';
import * as sessionStore from '@/lib/session/store';
import { DraftAgent, capitaliseSentences, teaserTitle } from '@/lib/orchestration/agents/draft-agent';
import type { ContextEnvelope } from '@/lib/orchestration/types';

/*
 * The sandbox teaser is a fixed sample. It says so, its title never
 * reads "Project the seller", and its screen never sets the shell ribbon.
 */

function RibbonProbe() {
  const { state } = useSession();
  return <span data-compliance-status={state.complianceStatus} data-testid="ribbon" />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TeaserRunner sample', () => {
  it('labels the output as a sample and leaves the ribbon unchanged', async () => {
    const dispatchSpy = vi.fn();
    const realUseSession = sessionStore.useSession;
    vi.spyOn(sessionStore, 'useSession').mockImplementation(() => {
      const session = realUseSession();
      return {
        ...session,
        dispatch: (action: Parameters<typeof session.dispatch>[0]) => {
          dispatchSpy(action);
          session.dispatch(action);
        },
      };
    });
    render(
      <SessionProvider>
        <RibbonProbe />
        <TeaserRunner />
      </SessionProvider>,
    );
    const before = screen.getByTestId('ribbon').getAttribute('data-compliance-status');

    fireEvent.click(screen.getByRole('button', { name: 'Draft the teaser' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm plan' }));
    await screen.findByRole('button', { name: 'Sign off & clear to send' });

    const banner = document.querySelector('[data-preview="banner"]') as HTMLElement;
    expect(banner).toHaveTextContent(SAMPLE_DRAFT_COPY);
    expect(SAMPLE_DRAFT_COPY).toBe("Sample draft. Not written from this deal's data.");
    expect(screen.getByText(/Screen of this sample text/)).toBeInTheDocument();

    const title = screen.getByText(/Confidential Teaser/);
    expect(title.textContent).not.toMatch(/Project the seller|Project The Company/);
    expect(title.textContent).toMatch(/^Confidential Teaser/);

    expect(screen.getByTestId('ribbon').getAttribute('data-compliance-status')).toBe(before);
    expect(dispatchSpy.mock.calls.filter(([a]) => a?.type === 'SET_COMPLIANCE')).toHaveLength(0);
  });
});

describe('DraftAgent title and sentences', () => {
  it('names a real seller, and reads "Confidential Teaser" alone otherwise', () => {
    expect(teaserTitle('Atlassian')).toBe('Project Atlassian: Confidential Teaser');
    expect(teaserTitle('the seller')).toBe('Confidential Teaser');
    expect(teaserTitle(undefined)).toBe('Confidential Teaser');
    expect(teaserTitle('  ')).toBe('Confidential Teaser');
  });

  it('capitalises the first letter of each generated sentence', () => {
    expect(capitaliseSentences('the seller sits here. it grows.')).toBe('The seller sits here. It grows.');
  });

  it('drafts a teaser with no "Project the seller" title and a capitalised market read', async () => {
    const envelope: ContextEnvelope = {
      jobId: 'job-1',
      dealId: 'deal-1',
      actorId: 'actor-md',
      goal: 'Prepare the teaser',
      completionCondition: 'A teaser exists',
      documents: [],
      brief: { sellerName: 'the seller', sector: 'Software', headline: 'Category-defining software.' },
      priorFindings: { research: { comps: [{ name: 'Salesforce', evRevenue: 7 }], marketRead: 'the seller sits in a durable position.' } },
    };
    const out = await new DraftAgent().run({
      goal: 'Draft the teaser',
      envelope,
      completionCondition: 'A teaser draft exists',
      model: 'frontier',
      report: () => {},
    } as never);
    const teaser = out.result.teaser;
    expect(teaser.split('\n\n')[0]).toBe('Confidential Teaser');
    expect(teaser).not.toContain('Project the seller');
    expect(teaser).toContain('The seller sits in a durable position.');
  });
});
