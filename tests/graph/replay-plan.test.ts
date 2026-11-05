import { describe, expect, it } from 'vitest';

import { planFromManifest } from '../integration/support/replayCassette';
import type { Cassette } from '../../scripts/m365/cassette/replayFetch';

// The cassette replay test's plan ([318 2/6]) runs only in the integration job; its pure part is pinned here.
const manifest = (sources: Array<{ kind: string; address: string }>) => ({ sources }) as unknown as Cassette['manifest'];

describe('planFromManifest: the people and domains a cassette replay seats', () => {
  it('seats one owner per mailbox, de-duplicated and lower-cased, and reads their domains', () => {
    const plan = planFromManifest(
      manifest([
        { kind: 'mailbox', address: 'A@one.example' },
        { kind: 'mailbox', address: 'a@one.example' },
        { kind: 'mailbox', address: 'b@two.example' },
        { kind: 'sharepoint_site', address: 'contoso.sharepoint.com:/sites/deals' },
      ]),
    );
    expect(plan).toEqual({
      mailboxes: ['a@one.example', 'b@two.example'],
      sites: ['contoso.sharepoint.com:/sites/deals'],
      domains: ['one.example', 'two.example'],
      people: ['a@one.example', 'b@two.example'],
    });
  });

  it('accepts a site-only cassette: one placeholder site owner on a reserved domain, and no mailbox owner', () => {
    const plan = planFromManifest(manifest([{ kind: 'sharepoint_site', address: 'contoso.sharepoint.com:/sites/deals' }]));
    expect(plan.mailboxes).toEqual([]);
    expect(plan.people).toEqual(['site-owner@replay.invalid']);
    expect(plan.domains).toEqual(['replay.invalid']);
  });

  it('refuses a cassette with no source, and a mailbox that is not an address, naming only a count', () => {
    expect(() => planFromManifest(manifest([]))).toThrow('the cassette names no mailbox or site source');
    expect(() => planFromManifest(manifest([{ kind: 'mailbox', address: 'not-an-address' }]))).toThrow(
      '1 mailbox source(s) in the cassette: at least one is not an address',
    );
  });
});
