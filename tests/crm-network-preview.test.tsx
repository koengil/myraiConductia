import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/leads/CrmNetworkGraph', () => ({
  CrmNetworkGraph: () => <div data-testid="crm-network-graph">graph</div>,
}));

import { CrmNetworkPreview } from '@/components/leads/CrmNetworkPreview';

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

describe('CrmNetworkPreview', () => {
  it('renders the live network shell after fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(200, {
          clientCompany: {
            id: 'cust-1',
            name: 'Tokmail',
            color: '#66635c',
            kind: 'client',
          },
          companies: [{ id: 'lead-a', name: 'Alpha Co', color: '#2f7d78', kind: 'lead' }],
          people: [{ id: 'p1', name: 'Alex Chen', companyId: 'lead-a', leadId: 'lead-a' }],
          edges: [],
        }),
      ),
    );

    render(<CrmNetworkPreview scope={{ tenantWide: false, orgName: 'Tokmail' }} />);

    expect(await screen.findByRole('heading', { name: 'Network' })).toBeInTheDocument();
    expect(await screen.findByText('Alpha Co')).toBeInTheDocument();
    expect(await screen.findByText(/Tokmail \(your organization\)/i)).toBeInTheDocument();
    expect(await screen.findByTestId('crm-network-graph')).toBeInTheDocument();
    expect(screen.getByText(/dashed lines show who covers which lead/i)).toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
