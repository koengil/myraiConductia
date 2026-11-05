import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { WelcomeBrief } from '@/components/onboarding/WelcomeBrief';
import type { Perimeter } from '@/lib/perimeter/perimeter';

/**
 * The welcome brief (criteria C1-C11), covering D8.12 (an action set per viewer
 * archetype), D8.13 (the later-visit contract) and D8.14 (no other company's
 * roster).
 *
 * Every archetype here is defined by its PERIMETER, not by its role name,
 * because that is how the component decides: it offers upload when the seat
 * carries upload rights, not when the role happens to be called "seller".
 */

const DEAL = { code: 'PROJECT-ATLAS', codename: 'Atlas', status: 'active' };

function perimeter(over: Partial<Perimeter> = {}): Perimeter {
  return {
    destinations: ['mandate', 'rail', 'dataRoom', 'team'],
    documents: { total: 3, rooms: [{ room: 'deal', count: 3 }] },
    capabilities: { canUploadToDataRoom: false, canInviteTeammate: false },
    invariants: ['external_never_internal_room', 'external_never_mnpi'],
    ...over,
  };
}

function renderBrief(over: {
  perimeter?: Perimeter | null;
  dealRole?: string | null;
  phase?: number;
}) {
  return render(
    <WelcomeBrief
      projectId="PROJECT-ATLAS"
      deal={DEAL}
      companyName="Vista Equity Partners"
      dealRole={over.dealRole ?? 'seller'}
      phase={over.phase ?? 1}
      perimeter={over.perimeter === undefined ? perimeter() : over.perimeter}
    />,
  );
}

describe('welcome brief — the viewer sees their own seat (C4, C5)', () => {
  it('names the deal, the company, the role and the phase', () => {
    const { container } = renderBrief({});
    expect(screen.getByText(/Atlas/)).toBeTruthy();
    expect(screen.getByText(/Vista Equity Partners/)).toBeTruthy();
    expect(screen.getByText(/Seller/)).toBeTruthy();
    expect(container.textContent).toContain('Access up to Preparation');
  });

  it('names the phase, never a number, a raw status or the deal code', () => {
    const { container } = render(
      <WelcomeBrief
        projectId="ATLAS-2026-001"
        deal={{ code: 'ATLAS-2026-001', codename: 'Atlas', status: 'intake' }}
        companyName="your firm"
        dealRole="seller"
        phase={0}
        perimeter={perimeter()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Access up to Origination');
    expect(text).not.toMatch(/PHASE/);
    expect(text).not.toMatch(/disclosure phase/i);
    expect(text).not.toMatch(/INTAKE/);
    expect(text).not.toContain('ATLAS-2026-001');
  });

  it('states the document count available to this viewer', () => {
    // textContent, not getByText: the count renders across several JSX
    // expressions, so it is not a single text node.
    const { container } = renderBrief({
      perimeter: perimeter({ documents: { total: 3, rooms: [] } }),
    });
    expect(container.textContent).toMatch(/3 documents/);
  });
});

describe('welcome brief — actions per archetype (D8.12, C6-C8)', () => {
  it('offers upload to a seat that carries upload rights', () => {
    renderBrief({
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: true, canInviteTeammate: false },
      }),
    });
    expect(screen.getByRole('link', { name: /Upload a document/i })).toBeTruthy();
  });

  it('does not offer upload to a buyer-side seat', () => {
    renderBrief({
      dealRole: 'buyer',
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: false, canInviteTeammate: false },
      }),
    });
    expect(screen.queryByRole('link', { name: /Upload a document/i })).toBeNull();
  });

  it('does not offer upload to an observer', () => {
    renderBrief({
      dealRole: 'read_only',
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: false, canInviteTeammate: false },
      }),
    });
    expect(screen.queryByRole('link', { name: /Upload/i })).toBeNull();
  });

  it('offers inviting a teammate to a director who holds that authority', () => {
    renderBrief({
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: false, canInviteTeammate: true },
      }),
    });
    expect(screen.getByRole('link', { name: /Invite a teammate/i })).toBeTruthy();
  });

  it('does not offer inviting to a member without that authority', () => {
    renderBrief({});
    expect(screen.queryByRole('link', { name: /Invite a teammate/i })).toBeNull();
  });

  it('keeps Data Room and Team reachable even with zero documents', () => {
    // An empty room is still a room. Hiding the link would tell the invitee
    // they lack access they actually hold.
    renderBrief({ perimeter: perimeter({ documents: { total: 0, rooms: [] } }) });
    expect(screen.getByRole('link', { name: /Data Room/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Team/i })).toBeTruthy();
  });
});

describe('welcome brief — honest empty and unavailable states (C11)', () => {
  it('says nothing has been released rather than inventing a count', () => {
    renderBrief({ perimeter: perimeter({ documents: { total: 0, rooms: [] } }) });
    expect(screen.getByText(/No documents have been released/i)).toBeTruthy();
    expect(screen.queryByText(/0 documents/)).toBeNull();
  });

  it('reports an unreadable perimeter as unreadable, never as zero', () => {
    renderBrief({ perimeter: null });
    expect(screen.getByRole('status').textContent).toMatch(/could not be read/i);
    expect(screen.queryByText(/No documents have been released/i)).toBeNull();
  });
});

describe('welcome brief — later-visit contract (D8.13, C1/C3)', () => {
  it('shows new values after a phase raise while keeping the same structure', () => {
    const before = renderBrief({ phase: 1, perimeter: perimeter({ documents: { total: 1, rooms: [] } }) });
    // Structure is which actions are offered, not their wording: the hints
    // deliberately carry the counts, which are exactly what should change.
    const structureBefore = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(before.container.textContent).toMatch(/1 document is/);
    before.unmount();

    // Same viewer, later visit, after an MD raised their phase.
    const after = renderBrief({ phase: 3, perimeter: perimeter({ documents: { total: 7, rooms: [] } }) });
    expect(after.container.textContent).toMatch(/7 documents are/);
    expect(after.container.textContent).toMatch(/Access up to Diligence/);
    const structureAfter = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
    expect(structureAfter).toEqual(structureBefore);
  });

  it('shows a newly granted capability on a later render', () => {
    const first = renderBrief({});
    expect(screen.queryByRole('link', { name: /Upload a document/i })).toBeNull();
    first.unmount();

    renderBrief({
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: true, canInviteTeammate: false },
      }),
    });
    expect(screen.getByRole('link', { name: /Upload a document/i })).toBeTruthy();
  });
});

describe('welcome brief — no other company roster (D8.14, C10)', () => {
  it('names only the viewer own company and no counterparty roster', () => {
    const { container } = renderBrief({
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: true, canInviteTeammate: true },
      }),
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Vista Equity Partners');
    // Nothing about who else is on the deal: no counterparty name, no person.
    expect(text).not.toMatch(/Atlassian|Anthropic|Salesforce|@/);
  });

  it('links to Team without carrying roster content into the brief', () => {
    renderBrief({});
    const team = screen.getByRole('link', { name: /Team/i });
    expect(team.getAttribute('href')).toBe('/projects/PROJECT-ATLAS/team');
  });

  it('keeps every link inside the scoped external destination set (C9)', () => {
    renderBrief({
      perimeter: perimeter({
        capabilities: { canUploadToDataRoom: true, canInviteTeammate: true },
      }),
    });
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(
        /^\/projects\/PROJECT-ATLAS\/(data-room|team)$/,
      );
    }
  });
});
