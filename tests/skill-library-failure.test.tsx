import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BenchCatalog } from '@/components/skills/BenchCatalog';
import { SKILL_LIBRARY_UNAVAILABLE_MESSAGE } from '@/lib/ignatious/failure';

const LEAKY_SERVER_ERROR =
  'Skill bench unreachable at http://localhost:4111. Locally start @ignatious/skill-bench; on deploy use the same host as IGNATIOUS_CONTROL_PLANE_URL.';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('BenchCatalog when the bench is unreachable', () => {
  it('states the library is unavailable without naming the infrastructure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: LEAKY_SERVER_ERROR }),
      })),
    );

    const { container } = render(<BenchCatalog />);

    expect(await screen.findByText(SKILL_LIBRARY_UNAVAILABLE_MESSAGE)).toBeTruthy();
    const rendered = container.textContent ?? '';
    for (const leak of ['localhost', '4111', 'IGNATIOUS_', 'skill-bench']) {
      expect(rendered).not.toContain(leak);
    }
  });
});

describe('BenchCatalog with no default model resolved', () => {
  it('names the deployment model as the default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ skills: [], defaultModel: null }),
      })),
    );

    render(<BenchCatalog />);

    expect(await screen.findByText(/The default is the deployment model\./)).toBeTruthy();
  });
});
