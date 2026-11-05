import { describe, expect, it } from 'vitest';

import { dedupeObservations, normalizeMessage } from '@/lib/discovery/normalize';
import { dealKeyOfName, SubjectNames } from '@/lib/discovery/propose/alsoNamed';
import { proposeDeals } from '@/lib/discovery/propose/run';
import type { MailMessage } from '@/lib/discovery/source/types';
import { routeByFirmRules } from '@/lib/discovery/route/firmRules';
import { DEV_TENANT_ID } from '@/lib/db/tenant';

import { memoryProposalStore, passesFor } from '../helpers/memoryProposalStore';
import { proposeReplyDouble } from '../helpers/proposeReplyDouble';

let seq = 0;
const msg = (subject: string): MailMessage =>
  ({
    id: `also-${++seq}`,
    internetMessageId: `<also-${seq}@bank.example>`,
    conversationId: `conv-also-${seq}`,
    subject,
    sentDateTime: '2026-05-01T10:00:00Z',
    from: { emailAddress: { name: null, address: 'ellis@bank.example' } },
    toRecipients: [],
    ccRecipients: [],
    body: { contentType: 'text', content: 'See attached. Ellis Brandt, Analyst' },
  }) as MailMessage;
const routed = (subjects: string[]) =>
  routeByFirmRules(
    dedupeObservations(subjects.map((s) => { const m = msg(s); return { sourceId: 's', providerItemId: m.id, item: normalizeMessage(m) }; })).items,
    { scope: 'unscoped' },
  );

describe('SubjectNames (#623)', () => {
  it('names the parties a deal\'s own subjects use, most used first, and never a word another deal\'s subjects use', () => {
    const names = new SubjectNames();
    names.add(
      routed([
        'Project Kestrel: Ashgrove valuation',
        'RE: Project Kestrel: Ashgrove valuation',
        'Project Kestrel: Reno site visit',
        'Project Halyard: management meeting with Pellwood',
        'Project Halyard: Reno travel',
        'Lunch on Friday',
      ]),
    );
    expect(names.for('Project Kestrel')).toEqual(['Ashgrove']);
    expect(names.for('Project Halyard')).toEqual(['Pellwood']);
    expect(names.for('Project Unknown')).toEqual([]);
  });

  it('keys a bare codename and a "Project <Name>" the same way', () => {
    expect(dealKeyOfName('Project Halyard')).toBe('halyard');
    expect(dealKeyOfName('Kestrel')).toBe('kestrel');
  });
});

describe('proposeDeals sends each known deal\'s other names (#623)', () => {
  it('lists the names from the page\'s routed subjects, and asks only the unrouted message', async () => {
    const entries = routed(['Project Kestrel: Ashgrove valuation', 'Project Kestrel: lender feedback', 'Deal team change: Ashgrove']);
    const m = memoryProposalStore({ candidates: [{ ref: 'c:7d0e6c1e-0a7b-4b0e-9b6a-1d1f4a1c2b3d', name: 'Project Kestrel', candidateId: '7d0e6c1e-0a7b-4b0e-9b6a-1d1f4a1c2b3d' }] });
    const transport = proposeReplyDouble(() => ({ deal_related: false, p_deal: 0.1, deal: null, phase: null, p_phase: 0 }));
    await proposeDeals(entries, {
      tenantId: DEV_TENANT_ID,
      runId: '00000000-0000-4000-8000-000000000001',
      sourceId: 's',
      sources: passesFor(DEV_TENANT_ID, m.store),
      gate: { flagOn: true, env: {} },
      transport,
      store: m.store,
      sleep: async () => {},
    });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].input.subject).toBe('Deal team change: Ashgrove');
    expect(transport.sent[0].input.candidates).toEqual([
      { ref: 'c:7d0e6c1e-0a7b-4b0e-9b6a-1d1f4a1c2b3d', name: 'Project Kestrel', alsoNamed: ['Ashgrove'] },
    ]);
  });
});
