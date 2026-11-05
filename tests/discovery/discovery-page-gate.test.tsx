import { beforeEach, describe, expect, it, vi } from 'vitest';

const isEnabledMock = vi.hoisted(() => vi.fn());
const getUserMock = vi.hoisted(() => vi.fn());
const maybeSingleMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/flags/isEnabled', () => ({ isEnabled: isEnabledMock }));
vi.mock('@/lib/flags/supabaseSource', () => ({ supabaseFlagSource: {} }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: getUserMock },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
  }),
}));
vi.mock('@/components/discovery/CandidateList', () => ({ CandidateList: () => <div data-testid="candidate-list" /> }));
vi.mock('@/components/discovery/CandidateDetailView', () => ({ CandidateDetailView: () => <div data-testid="candidate-detail" /> }));
vi.mock('@/components/discovery/IngestionHealth', () => ({ IngestionHealth: () => <div data-testid="ingestion-health" /> }));
vi.mock('@/components/discovery/ModelProposals', () => ({ ModelProposals: () => <div data-testid="model-proposals" /> }));
vi.mock('@/components/discovery/TeamInboxes', () => ({ TeamInboxes: () => <div data-testid="team-inboxes" /> }));
vi.mock('@/components/discovery/TeamInboxAuditTrail', () => ({
  TeamInboxAuditTrail: () => <div data-testid="team-inbox-audit-trail" />,
}));

import { renderToStaticMarkup } from 'react-dom/server';
import CandidatePage from '@/app/(authed)/discovery/[candidateId]/page';
import DiscoveryPage from '@/app/(authed)/discovery/page';

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await DiscoveryPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockResolvedValue({ data: { user: { id: 'u-bank' } } });
  maybeSingleMock.mockResolvedValue({ data: { is_external: false } });
});

describe('/discovery page gate', () => {
  it('404s for a bank user when deal_discovery is off', async () => {
    isEnabledMock.mockResolvedValue(false);
    await expect(DiscoveryPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(isEnabledMock).toHaveBeenCalledWith('deal_discovery', expect.anything());
  });

  it('tells an external party Discovery is not available, never a 404 (#395)', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: true } });
    const html = await renderPage();
    expect(html).toContain('Not available to your account');
    expect(html).not.toContain('data-testid="candidate-list"');
    expect(html).not.toContain('data-testid="ingestion-health"');
  });

  it('404s when there is no signed-in user', async () => {
    isEnabledMock.mockResolvedValue(true);
    getUserMock.mockResolvedValue({ data: { user: null } });
    await expect(DiscoveryPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders for a bank user when the flag is on', async () => {
    isEnabledMock.mockResolvedValue(true);
    await expect(DiscoveryPage()).resolves.toBeTruthy();
  });

  it('shows a banker the proposed deals and no ingestion health', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: null } });
    const html = await renderPage();
    expect(html).toContain('data-testid="candidate-list"');
    expect(html).not.toContain('data-testid="ingestion-health"');
    expect(html).toContain('Proposed deals');
  });

  it('places the demo model proposals below the rules-found list, for bankers and the control room (#460)', async () => {
    isEnabledMock.mockResolvedValue(true);
    for (const firm_role of [null, 'cco']) {
      maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role } });
      const html = await renderPage();
      expect(html).toContain('data-testid="model-proposals"');
      expect(html.indexOf('data-testid="model-proposals"')).toBeGreaterThan(html.indexOf('data-testid="candidate-list"'));
    }
    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'admin' } });
    expect(await renderPage()).not.toContain('data-testid="model-proposals"');
    maybeSingleMock.mockResolvedValue({ data: { is_external: true } });
    expect(await renderPage()).not.toContain('data-testid="model-proposals"');
  });

  it('shows the firm admin ingestion health only, never the proposed deals (Q19)', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'admin' } });
    const html = await renderPage();
    expect(html).toContain('data-testid="ingestion-health"');
    expect(html).not.toContain('data-testid="candidate-list"');
    expect(html).not.toContain('Proposed deals</h1>');
  });

  it('shows the firm admin the team inboxes card below ingestion health, and no one else (#581)', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'admin' } });
    const html = await renderPage();
    expect(html).toContain('data-testid="team-inboxes"');
    expect(html.indexOf('data-testid="team-inboxes"')).toBeGreaterThan(html.indexOf('data-testid="ingestion-health"'));
    for (const data of [
      { is_external: false, firm_role: null },
      { is_external: false, firm_role: 'cco' },
      { is_external: true },
    ]) {
      maybeSingleMock.mockResolvedValue({ data });
      expect(await renderPage()).not.toContain('data-testid="team-inboxes"');
    }
  });

  it('shows the firm admin and the control room the team inbox audit trail, and no one else (#173 G-03)', async () => {
    isEnabledMock.mockResolvedValue(true);
    const TRAIL = 'data-testid="team-inbox-audit-trail"';

    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'admin' } });
    const admin = await renderPage();
    expect(admin.split(TRAIL)).toHaveLength(2);
    expect(admin.indexOf(TRAIL)).toBeGreaterThan(admin.indexOf('data-testid="team-inboxes"'));

    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'cco' } });
    const cco = await renderPage();
    expect(cco.split(TRAIL)).toHaveLength(2);
    expect(cco.indexOf(TRAIL)).toBeGreaterThan(cco.indexOf('data-testid="ingestion-health"'));
    expect(cco.indexOf(TRAIL)).toBeLessThan(cco.indexOf('data-testid="candidate-list"'));

    for (const data of [{ is_external: false, firm_role: null }, { is_external: true }]) {
      maybeSingleMock.mockResolvedValue({ data });
      expect(await renderPage()).not.toContain(TRAIL);
    }
  });

  it('shows the control room both', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'cco' } });
    const html = await renderPage();
    expect(html).toContain('data-testid="ingestion-health"');
    expect(html).toContain('data-testid="candidate-list"');
  });

  it('404s when the viewer\'s own row cannot be read', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: null });
    await expect(DiscoveryPage()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('/discovery/[candidateId] page gate', () => {
  const params = Promise.resolve({ candidateId: '00000000-0000-4000-8000-000000000001' });

  it('tells an external party Discovery is not available, never a 404 (#395)', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: true } });
    const html = renderToStaticMarkup(await CandidatePage({ params }));
    expect(html).toContain('Not available to your account');
    expect(html).not.toContain('data-testid="candidate-detail"');
  });

  it('404s a firm admin, who never sees a candidate (Q19)', async () => {
    isEnabledMock.mockResolvedValue(true);
    maybeSingleMock.mockResolvedValue({ data: { is_external: false, firm_role: 'admin' } });
    await expect(CandidatePage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders the candidate for a banker', async () => {
    isEnabledMock.mockResolvedValue(true);
    const html = renderToStaticMarkup(await CandidatePage({ params }));
    expect(html).toContain('data-testid="candidate-detail"');
  });
});
