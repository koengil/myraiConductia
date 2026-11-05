import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALLOWED_DESTINATIONS, type DestinationId } from '../src/lib/perspective/access';
import { DESTINATION_TITLES } from '../src/lib/perspective/destinationTitles';
import { perDealNavItems } from '../src/components/organisms/navigation/perDealNav';
import { PerimeterPreview, type Perimeter } from '../src/components/onboarding/PerimeterPreview';

/**
 * The perimeter preview used to keep its own three-entry label map and fall
 * back to `?? id`, so seven of the ten destinations reached the person being
 * invited as camelCase. These tests hold the fix in place from both ends: the
 * mapping is total over `DestinationId`, and it is the only place a title is
 * written down.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ALL_IDS = Object.keys(DESTINATION_TITLES) as DestinationId[];

function perimeterFor(destinations: DestinationId[]): Perimeter {
  return {
    destinations,
    documents: { total: 2, rooms: [{ room: 'Deal', count: 2 }] },
    capabilities: { canUploadToDataRoom: false, canInviteTeammate: false },
    invariants: ['external_never_mnpi'],
  };
}

function stubPreviewFetch(perimeter: Perimeter) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ dealContext: 'existing', perimeter }),
    })),
  );
}

describe('destination titles', () => {
  it('names every destination the type declares', () => {
    // Exhaustiveness is enforced by `Record<DestinationId, string>` at compile
    // time; this is the runtime half, and it also catches an empty string.
    for (const id of ALL_IDS) {
      expect(DESTINATION_TITLES[id]?.length).toBeGreaterThan(0);
    }
    expect(ALL_IDS).toHaveLength(10);
  });

  it('never lets an identifier stand in for a title', () => {
    for (const id of ALL_IDS) {
      const title = DESTINATION_TITLES[id];
      expect(title).not.toBe(id);
      // camelCase is what leaked before: a lowercase run followed by a capital.
      expect(title).not.toMatch(/^[a-z]+[A-Z]/);
    }
  });

  it('titles every destination each perspective can reach', () => {
    for (const [perspective, allowed] of Object.entries(ALLOWED_DESTINATIONS)) {
      for (const id of allowed) {
        expect(DESTINATION_TITLES[id], `${perspective} -> ${id}`).toBeTruthy();
      }
    }
  });
});

describe('the registry is the only place a title is written', () => {
  const CONSUMERS = [
    'src/components/organisms/navigation/perDealNav.ts',
    'src/components/shell/AppNav.tsx',
    'src/components/onboarding/PerimeterPreview.tsx',
  ];

  it.each(CONSUMERS)('%s reads titles from the registry', (relative) => {
    const source = readFileSync(resolve(process.cwd(), relative), 'utf8');
    expect(source).toContain('DESTINATION_TITLES');
  });

  it('declares no title literal on a nav row', () => {
    const titles = Object.values(DESTINATION_TITLES);
    for (const relative of CONSUMERS) {
      const source = readFileSync(resolve(process.cwd(), relative), 'utf8');
      const labelLines = source.split('\n').filter((line) => /\blabel:/.test(line));
      for (const line of labelLines) {
        for (const title of titles) {
          expect(line, `${relative}: ${line.trim()}`).not.toContain(`'${title}'`);
        }
      }
    }
  });

  it('has no second copy of the preview label map', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/onboarding/PerimeterPreview.tsx'),
      'utf8',
    );
    expect(source).not.toContain('DESTINATION_COPY');
  });
});

describe('the shell rail', () => {
  it('labels each per-deal row from the registry', () => {
    for (const item of perDealNavItems('storm')) {
      expect(item.label).toBe(DESTINATION_TITLES[item.id]);
    }
  });
});

describe('the perimeter preview', () => {
  it.each(Object.keys(ALLOWED_DESTINATIONS))(
    'prints titles, never identifiers, for %s',
    async (perspective) => {
      const destinations = [
        ...ALLOWED_DESTINATIONS[perspective as keyof typeof ALLOWED_DESTINATIONS],
      ];
      stubPreviewFetch(perimeterFor(destinations));

      render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);
      const line = await screen.findByText(/^Pages:/);

      for (const id of destinations) {
        expect(line.textContent).toContain(DESTINATION_TITLES[id]);
      }
      // The identifiers that used to leak must not appear anywhere in the line.
      for (const id of destinations.filter((d) => d !== DESTINATION_TITLES[d])) {
        expect(line.textContent).not.toMatch(new RegExp(`\\b${id}\\b`));
      }
    },
  );

  it('refuses a perimeter naming a destination it cannot title', async () => {
    // Silently printing the raw id is the defect. Failing loudly is the fix:
    // an unnameable destination is an uncomputed perimeter.
    stubPreviewFetch(perimeterFor(['mandate', 'somethingNew' as DestinationId]));

    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      /could not be checked/i,
    );
  });

  it('refuses an inherited property masquerading as a destination', async () => {
    // `'toString' in DESTINATION_TITLES` is true. `hasOwnProperty` is not.
    stubPreviewFetch(perimeterFor(['toString' as DestinationId]));

    render(<PerimeterPreview mode="member" dealId="PROJECT-X" userId="u-1" phase={2} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      /could not be checked/i,
    );
  });
});
