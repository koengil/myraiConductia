import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlagsProvider, useFlag } from '@/lib/flags/FlagsContext';

function Probe() {
  return <span>{useFlag('gate0_api_create') ? 'ON' : 'OFF'}</span>;
}

describe('FlagsProvider / useFlag', () => {
  it('exposes the resolved flag value to client components', () => {
    render(
      <FlagsProvider
        value={{
          rail_templates: false,
          template_change_review: false,
          deal_data_room_nav: false,
          gate0_api_create: true,
          platform_onboarding: false,
          work_identity_onboarding: false,
          mail_channel: false,
          mail_jev_second_opinion: false,
          teaser_sandbox_runner: false,
          company_access_management: false,
          setup_walkthroughs: false,
          book_view: false,
          project_rail_model: false,
          deal_discovery: false,
          discovery_worker_enabled: false,
          discovery_model_proposals_demo: false,
          workbench_top_nav: false,
          skill_authoring: false,
          skill_output_revisions: false,
        }}
      >
        <Probe />
      </FlagsProvider>,
    );
    expect(screen.getByText('ON')).toBeInTheDocument();
  });

  it('fails closed (false) when used outside a provider', () => {
    render(<Probe />);
    expect(screen.getByText('OFF')).toBeInTheDocument();
  });
});
