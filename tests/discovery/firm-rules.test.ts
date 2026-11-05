import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ROUTE_METHOD } from '@/lib/constants/discovery';
import { normalizeMessage } from '@/lib/discovery/normalize';
import {
  admit,
  codenamesIn,
  MAX_PREFIX_KEYS_PER_SOURCE,
  notePrefixEvidence,
  promotedPrefixes,
  routeByFirmRules,
  subjectPrefixCodenames,
  threadKey,
  type PrefixLedger,
  type RouteCounts,
  type RoutingScope,
} from '@/lib/discovery/route/firmRules';
import { DISCOVERY_RULES_VERSION } from '@/lib/discovery/rulesVersion';
import { fixtureItems } from './fixtureCorpus';
import { RoutingContext } from '../../worker/sync';

const routed = routeByFirmRules(fixtureItems(), { scope: 'unscoped' });
const routesOf = (internetMessageId: string) =>
  routed.find((r) => r.item.internetMessageId === internetMessageId)?.routes ?? [];

describe('codenamesIn', () => {
  it('finds "Project <Name>" and skips ordinary business phrases', () => {
    expect(codenamesIn('Project Falcon and Project Cobra; the Project Management office')).toEqual([
      { key: 'falcon', codename: 'Project Falcon' },
      { key: 'cobra', codename: 'Project Cobra' },
    ]);
    expect(codenamesIn('project falcon in lower case')).toEqual([]);
  });
});

describe('routeByFirmRules over the fixture corpus', () => {
  it('routes codenames in the subject and in the body', () => {
    expect(routesOf('<falcon-001@bank.example>')).toEqual([
      expect.objectContaining({ codenameKey: 'falcon', method: ROUTE_METHOD.CODENAME, confidence: 0.95 }),
    ]);
    expect(routesOf('<falcon-003@bank.example>')).toEqual([
      expect.objectContaining({ codenameKey: 'falcon', method: ROUTE_METHOD.CODENAME, confidence: 0.9 }),
    ]);
  });

  it('routes an alias of a known codename', () => {
    expect(routesOf('<falcon-006@bank.example>')).toEqual([
      expect.objectContaining({ codenameKey: 'falcon', method: ROUTE_METHOD.ALIAS }),
    ]);
  });

  it('continues a routed thread, and stops at a subject change', () => {
    expect(routesOf('<falcon-004@heliotrope.example>')).toEqual([
      expect.objectContaining({ codenameKey: 'falcon', method: ROUTE_METHOD.THREAD_CONTINUATION }),
    ]);
    // Same conversation, new subject: "Dinner Thursday?"
    expect(routesOf('<dinner-005@heliotrope.example>')).toEqual([]);
  });

  it('never routes on quoted history or ordinary phrases', () => {
    expect(routesOf('<fwd-008@bank.example>')).toEqual([]);
    expect(routesOf('<digest-007@newswire.example>')).toEqual([]);
  });

  it('routes eight items: six to Falcon and two to Cobra', () => {
    const falcon = routed.filter((r) => r.routes.some((x) => x.codenameKey === 'falcon'));
    const cobra = routed.filter((r) => r.routes.some((x) => x.codenameKey === 'cobra'));
    expect(falcon).toHaveLength(6);
    expect(cobra).toHaveLength(2);
    expect(routed.filter((r) => r.routes.length === 0)).toHaveLength(6);
  });

  it('matches an alias from an earlier run through knownCodenames', () => {
    const item = normalizeMessage({
      id: 'x',
      internetMessageId: '<later@bank.example>',
      conversationId: null,
      subject: 'Falcon bidder call',
      sentDateTime: '2026-03-01T10:00:00Z',
      from: null,
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: 'text', content: 'Dial-in attached.' },
    });
    const deduped = [{ item, observations: [{ sourceId: 's', providerItemId: 'x' }] }];
    expect(routeByFirmRules(deduped, { scope: 'unscoped' })[0].routes).toEqual([]);
    expect(
      routeByFirmRules(deduped, { knownCodenames: [{ key: 'falcon', codename: 'Project Falcon' }], scope: 'unscoped' })[0].routes,
    ).toEqual([expect.objectContaining({ codenameKey: 'falcon', method: ROUTE_METHOD.ALIAS })]);
  });

  it('continues a thread routed on an earlier page through knownThreads (phase 4)', () => {
    const reply = normalizeMessage({
      id: 'r',
      internetMessageId: '<reply@heliotrope.example>',
      conversationId: 'conv-heliotrope-next',
      subject: 'RE: Heliotrope next steps',
      sentDateTime: '2026-02-11T08:45:00Z',
      from: null,
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: 'text', content: 'Thanks, aligned.' },
    });
    const deduped = [{ item: reply, observations: [{ sourceId: 's', providerItemId: 'r' }] }];
    expect(routeByFirmRules(deduped, { scope: 'unscoped' })[0].routes).toEqual([]);
    const key = threadKey({ conversationId: 'conv-heliotrope-next', threadSubject: 'heliotrope next steps' })!;
    const taught = { codename: 'Project Falcon', taughtIn: new Set<string>() };
    const knownThreads = new Map([[key, new Map([['falcon', taught]])]]);
    expect(routeByFirmRules(deduped, { knownThreads, scope: 'unscoped' })[0].routes).toEqual([
      expect.objectContaining({ codenameKey: 'falcon', method: ROUTE_METHOD.THREAD_CONTINUATION }),
    ]);
    // A known thread with another subject does not match.
    const other = new Map([[threadKey({ conversationId: 'conv-heliotrope-next', threadSubject: 'dinner thursday?' })!, new Map([['falcon', taught]])]]);
    expect(routeByFirmRules(deduped, { knownThreads: other, scope: 'unscoped' })[0].routes).toEqual([]);
  });
});

describe('subject prefix codenames (#622)', () => {
  const FIRM = ['tidewell.example'];
  let n = 0;
  const message = (
    subject: string,
    opts: { from?: string; source?: string | string[]; conversationId?: string | null; body?: string } = {},
  ) => {
    n += 1;
    const item = normalizeMessage({
      id: `p${n}`,
      internetMessageId: `<prefix-${n}@bank.example>`,
      conversationId: opts.conversationId ?? null,
      subject,
      sentDateTime: '2026-05-01T10:00:00Z',
      from: { emailAddress: { address: opts.from ?? 'ellis@tidewell.example', name: null } },
      toRecipients: [{ emailAddress: { address: 'marcus@tidewell.example', name: null } }],
      ccRecipients: [],
      body: { contentType: 'text', content: opts.body ?? 'See attached.' },
    });
    const sources = Array.isArray(opts.source) ? opts.source : [opts.source ?? 'mailbox-a'];
    return { item, observations: sources.map((sourceId) => ({ sourceId, providerItemId: `p${n}` })) };
  };
  const keysOf = (r: { routes: Array<{ codenameKey: string }> }) => r.routes.map((x) => x.codenameKey);
  const route = (items: ReturnType<typeof message>[], owners?: ReadonlyMap<string, string>) =>
    routeByFirmRules(items, { internalDomains: FIRM, sourceOwners: owners, scope: 'unscoped' });
  const MARCUS = 'marcus@tidewell.example';
  const ELLIS = 'ellis@tidewell.example';

  it('promotes a prefix that two firm people open with two topics in one mailbox, and routes the subjects it opens', () => {
    const items = [
      message('Kestrel: lender feedback'),
      message('RE: Kestrel: site visit', { from: MARCUS }),
      message('FW: RE: Kestrel: lender feedback', { from: 'counsel@outside.example' }),
    ];
    const routed = route(items);
    expect(routed.map(keysOf)).toEqual([['kestrel'], ['kestrel'], ['kestrel']]);
    expect(routed[0].routes[0]).toEqual({
      codenameKey: 'kestrel',
      codename: 'Kestrel',
      method: ROUTE_METHOD.CODENAME,
      confidence: 0.8,
      fromSubjectPrefix: true,
    });
    expect(subjectPrefixCodenames(items, FIRM)).toEqual(new Map([['mailbox-a', new Map([['kestrel', 'Kestrel']])]]));
  });

  it('is off without the firm domains', () => {
    expect(routeByFirmRules([message('Kestrel: lender feedback'), message('Kestrel: site visit')], { scope: 'unscoped' }).map(keysOf)).toEqual([[], []]);
  });

  it('does not promote a prefix seen with one topic only, however often', () => {
    expect(route([message('Pellwood: second-round questions'), message('RE: Pellwood: second-round questions')]).map(keysOf)).toEqual([[], []]);
  });

  it('never counts outside senders: newsletters, vendors and e-signature notices', () => {
    const outside = [
      ['Bloomberg: markets wrap', 'Bloomberg: rates outlook', 'news@bloomberg.example'],
      ['Receipt: order 1043', 'Receipt: order 1044', 'billing@vendor.example'],
      ['Docusign: please sign', 'Docusign: reminder to sign', 'dse@docusign.example'],
    ] as const;
    for (const [a, b, from] of outside) expect(route([message(a, { from }), message(b, { from })]).map(keysOf)).toEqual([[], []]);
  });

  it('never promotes labels a firm system or colleague puts on a subject', () => {
    const labels = ['Undeliverable', 'Read', 'Completed', 'External', 'Invoice', 'Reminder', 'Accepted', 'Monday', 'March'];
    for (const label of labels) {
      expect(route([message(`${label}: lunch Tuesday`), message(`${label}: board dinner`, { from: MARCUS })]).map(keysOf)).toEqual([[], []]);
    }
    // Lower-case and multi-word prefixes never match.
    expect(route([message('Building notice: fire drill on 03 Jun'), message('Building notice: fire drill on 07 Apr')]).map(keysOf)).toEqual([[], []]);
    expect(route([message('kestrel: one'), message('kestrel: two')]).map(keysOf)).toEqual([[], []]);
  });

  it('counts per mailbox: one banker\'s mail never teaches another banker\'s mailbox', () => {
    // One topic in each mailbox: promoted in neither.
    expect(route([message('Kestrel: lender feedback', { source: 'a' }), message('Kestrel: site visit', { source: 'b' })]).map(keysOf)).toEqual([[], []]);
    // Promoted in a; the same prefix read only in b stays unrouted.
    const routed = route([
      message('Kestrel: lender feedback', { source: 'a' }),
      message('Kestrel: site visit', { source: 'a', from: MARCUS }),
      message('Kestrel: exclusivity letter', { source: 'b' }),
      // Read in both: it counts for b too, but b still holds one topic only, so b did not promote the prefix and the
      // item, read in a and b, does not route on it (every observer, #173 G-09 3b).
      message('Kestrel: exclusivity letter', { source: ['a', 'b'] }),
    ]);
    expect(routed.map(keysOf)).toEqual([['kestrel'], ['kestrel'], [], []]);
  });

  it('never routes bodies or whole threads: a prefix codename does not feed the alias rule or a thread', () => {
    const routed = route([
      message('Kestrel: lender feedback', { conversationId: 'c1' }),
      message('Kestrel: site visit', { from: MARCUS }),
      message('Hi', { body: 'The Kestrel numbers are attached.' }),
    ]);
    expect(routed.map(keysOf)).toEqual([['kestrel'], ['kestrel'], []]);
    // The candidate name it leaves ("Kestrel") is never read back as a codename by a later run.
    expect(codenamesIn('Kestrel')).toEqual([]);
  });

  it('keeps the "Project <Name>" route and joins a prefix to the same deal under that spelling', () => {
    const routed = route([message('Project Halyard: kickoff'), message('Halyard: buyer coverage'), message('Halyard: FY26 bridge', { from: MARCUS })]);
    expect(routed.map(keysOf)).toEqual([['halyard'], ['halyard'], ['halyard']]);
    expect(routed[0].routes[0]).toEqual(expect.objectContaining({ method: ROUTE_METHOD.CODENAME, confidence: 0.95 }));
    expect(routed[1].routes[0]).toEqual(expect.objectContaining({ codename: 'Project Halyard', confidence: 0.8, fromSubjectPrefix: true }));
  });

  describe('a prefix needs two firm people (#653)', () => {
    it('does not promote on one firm sender, however many topics', () => {
      const items = [message('Quartz: March claim'), message('Quartz: April claim'), message('Quartz: May claim')];
      expect(route(items).map(keysOf)).toEqual([[], [], []]);
      expect(subjectPrefixCodenames(items, FIRM).size).toBe(0);
    });

    it('does not count automated firm addresses as senders, or their subjects as topics', () => {
      const automated = ['noreply', 'no-reply', 'do-not-reply', 'DoNotReply', 'mailer-daemon', 'bounce+abc', 'postmaster', 'notifications', 'notify', 'alerts'];
      for (const local of automated) {
        const system = `${local}@tidewell.example`;
        // Two systems: no people at all.
        expect(route([message('Kestrel: lender feedback', { from: system }), message('Kestrel: site visit', { from: 'noreply@tidewell.example' })]).map(keysOf)).toEqual([[], []]);
        // One person plus a system: still one person.
        expect(route([message('Kestrel: lender feedback'), message('Kestrel: site visit', { from: system })]).map(keysOf)).toEqual([[], []]);
        // Two people whose second topic came from a system: one topic only.
        expect(route([message('Kestrel: lender feedback'), message('Kestrel: lender feedback', { from: MARCUS }), message('Kestrel: site visit', { from: system })]).map(keysOf)).toEqual([[], [], []]);
      }
      // A person whose name only starts like a system word is still a person.
      expect(route([message('Kestrel: lender feedback', { from: 'alertson@tidewell.example' }), message('Kestrel: site visit')]).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
    });

    it('keys a sender without its +tag, so one person with two tags counts once', () => {
      expect(route([message('Kestrel: lender feedback', { from: 'ana+1@tidewell.example' }), message('Kestrel: site visit', { from: 'ana+2@tidewell.example' })]).map(keysOf)).toEqual([[], []]);
      expect(route([message('Kestrel: lender feedback', { from: 'ana@tidewell.example' }), message('Kestrel: site visit', { from: 'Ana+deals@Tidewell.example' })]).map(keysOf)).toEqual([[], []]);
      // Dots are kept: ana.b and anab are two people.
      expect(route([message('Kestrel: lender feedback', { from: 'ana.b@tidewell.example' }), message('Kestrel: site visit', { from: 'anab@tidewell.example' })]).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
    });

    it('routes an internal-only deal: two firm people, no outside participant', () => {
      const routed = route([
        message('Lantern: working draft', { from: 'ellis@tidewell.example' }),
        message('Lantern: board materials', { from: MARCUS }),
      ]);
      expect(routed.map(keysOf)).toEqual([['lantern'], ['lantern']]);
    });

    it('bounds forged firm mail per source: two forged senders seed the label in every mailbox that read it', () => {
      const routed = route([
        message('Kestrel: lender feedback', { from: 'forged1@tidewell.example', source: ['a', 'b'] }),
        message('Kestrel: site visit', { from: 'forged2@tidewell.example', source: ['a', 'b'] }),
        message('Kestrel: site visit', { from: MARCUS, source: 'c' }),
      ]);
      expect(routed.map(keysOf)).toEqual([['kestrel'], ['kestrel'], []]);
      expect(subjectPrefixCodenames(routed, FIRM)).toEqual(
        new Map([
          ['a', new Map([['kestrel', 'Kestrel']])],
          ['b', new Map([['kestrel', 'Kestrel']])],
        ]),
      );
    });
  });

  describe('labels that are never codenames (#653)', () => {
    // The words the #626 review named, plus "May", the one month the list lacked.
    const labels = [
      'Approval', 'Calendar', 'Compliance', 'Docusign', 'Expense', 'Hiring', 'Holiday', 'Lunch', 'Missed',
      'Offsite', 'Reply', 'Sent', 'Shared', 'Signed', 'Thanks', 'Ticket', 'Timesheet', 'Travel', 'Voicemail', 'May',
    ];

    it('does not promote a named label even when two firm people open two topics with it', () => {
      for (const label of labels) {
        const items = [message(`${label}: first topic`), message(`${label}: second topic`, { from: MARCUS })];
        expect(route(items).map(keysOf), label).toEqual([[], []]);
        expect(subjectPrefixCodenames(items, FIRM).size, label).toBe(0);
      }
    });
  });

  describe('the mailbox owner can corroborate a prefix with a reply (#653)', () => {
    const owners = new Map([['mailbox-a', ELLIS]]);

    it('does not promote an owner alone writing originals: a system sending as the mailbox', () => {
      const items = [message('Kestrel: lender feedback'), message('Kestrel: site visit'), message('Kestrel: exclusivity letter')];
      expect(route(items, owners).map(keysOf)).toEqual([[], [], []]);
    });

    it('promotes an owner alone on two topics when one subject is a reply: the Sent Items shape', () => {
      const items = [
        message('Kestrel: lender feedback', { conversationId: 'conv-1' }),
        message('RE: Kestrel: site visit', { conversationId: 'conv-2' }),
      ];
      expect(route(items, owners).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
    });

    it('documents the subject heuristic: an owner-sent "Re:" with no thread evidence passes', () => {
      // No conversation id and no other sender: nothing shows a real reply, the subject alone decides.
      const items = [message('Kestrel: lender feedback'), message('Re: Kestrel: site visit')];
      expect(route(items, owners).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
      // AW: and SV: are replies too; FW: is not.
      expect(route([message('Kestrel: lender feedback'), message('AW: Kestrel: site visit')], owners).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
      expect(route([message('Kestrel: lender feedback'), message('SV: Kestrel: site visit')], owners).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
      expect(route([message('Kestrel: lender feedback'), message('FW: Kestrel: site visit')], owners).map(keysOf)).toEqual([[], []]);
    });

    it('needs the reply to be the owner\'s and the topics to be two: one topic or someone else\'s reply is not enough', () => {
      // The reply is on the one topic the owner opened: one topic only.
      expect(route([message('Kestrel: lender feedback'), message('RE: Kestrel: lender feedback')], owners).map(keysOf)).toEqual([[], []]);
      // The owner's two originals plus a non-owner reply: not two people, and no owner reply.
      const items = [message('Kestrel: lender feedback'), message('Kestrel: site visit'), message('RE: Kestrel: site visit', { from: 'noreply@tidewell.example' })];
      expect(route(items, owners).map(keysOf)).toEqual([[], [], []]);
    });

    it('falls back to two people when the source has no owner entry', () => {
      const items = [message('Kestrel: lender feedback'), message('RE: Kestrel: site visit')];
      expect(route(items).map(keysOf)).toEqual([[], []]);
      expect(route(items, new Map()).map(keysOf)).toEqual([[], []]);
      expect(route(items, new Map([['mailbox-b', ELLIS]])).map(keysOf)).toEqual([[], []]);
      expect(subjectPrefixCodenames(items, FIRM).size).toBe(0);
    });

    it('falls back to two people when the owner never appears as From: a send-as alias', () => {
      const items = [
        message('Kestrel: lender feedback', { from: 'e.ellis@tidewell.example' }),
        message('RE: Kestrel: site visit', { from: 'e.ellis@tidewell.example' }),
      ];
      expect(route(items, owners).map(keysOf)).toEqual([[], []]);
    });

    it('matches the owner through the sender key: case and "+tag" do not hide it', () => {
      const items = [
        message('Kestrel: lender feedback', { from: 'Ellis+deals@Tidewell.example' }),
        message('RE: Kestrel: site visit'),
      ];
      expect(route(items, new Map([['mailbox-a', 'ELLIS@tidewell.example']])).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
    });

    it('keeps the information barrier: owner evidence counts in the owner\'s mailbox only', () => {
      // Both messages are read in a and b and sent by a's owner, with no second sender anywhere.
      const items = [
        message('Kestrel: lender feedback', { source: ['a', 'b'] }),
        message('RE: Kestrel: site visit', { source: ['a', 'b'] }),
      ];
      const both = new Map([
        ['a', ELLIS],
        ['b', MARCUS],
      ]);
      expect(subjectPrefixCodenames(items, FIRM, both)).toEqual(new Map([['a', new Map([['kestrel', 'Kestrel']])]]));
      // b has no owner entry either: the same.
      expect(subjectPrefixCodenames(items, FIRM, new Map([['a', ELLIS]]))).toEqual(new Map([['a', new Map([['kestrel', 'Kestrel']])]]));
      // An item read in a and b routes on the prefix only if both promoted it (every observer, #173 G-09 3b): b did not.
      expect(route(items, both).map(keysOf)).toEqual([[], []]);
      // A copy read only in a, where it was promoted, still routes; one read only in b gets nothing from a's promotion.
      const split = [
        ...items,
        message('Kestrel: exclusivity letter', { source: 'a' }),
        message('Kestrel: exclusivity letter', { source: 'b' }),
      ];
      expect(route(split, both).map(keysOf)).toEqual([[], [], ['kestrel'], []]);
    });

    it('routes an item read in several mailboxes when every one of them promoted the prefix', () => {
      // Two firm people on two topics, each message read in both mailboxes: a and b each promote it.
      const items = [
        message('Kestrel: lender feedback', { source: ['a', 'b'] }),
        message('Kestrel: site visit', { source: ['a', 'b'], from: MARCUS }),
      ];
      expect(route(items).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
    });

    it('still promotes on two people when the owner is one of them', () => {
      const items = [message('Kestrel: lender feedback'), message('Kestrel: site visit', { from: MARCUS })];
      expect(route(items, owners).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
    });

    describe('a Gmail-shaped page mixes sent and received mail (conversation ids are rfc822: roots)', () => {
      const colleagueOriginal = () => message('Kestrel: lender feedback', { from: MARCUS, conversationId: 'rfc822:<root-a@tidewell.example>' });
      const ownerReply = () => message('RE: Kestrel: lender feedback', { conversationId: 'rfc822:<root-a@tidewell.example>' });
      const ownerOriginal = () => message('Kestrel: site visit', { conversationId: 'rfc822:<root-b@tidewell.example>' });

      it('routes as one page: two people', () => {
        const page = [colleagueOriginal(), ownerReply(), ownerOriginal()];
        expect(route(page, owners).map(keysOf)).toEqual([['kestrel'], ['kestrel'], ['kestrel']]);
        expect(route(page).map(keysOf)).toEqual([['kestrel'], ['kestrel'], ['kestrel']]);
      });

      it('cut mid-thread: the first half holds one topic, the second routes through the owner clause', () => {
        expect(route([colleagueOriginal()], owners).map(keysOf)).toEqual([[]]);
        expect(route([ownerReply(), ownerOriginal()], owners).map(keysOf)).toEqual([['kestrel'], ['kestrel']]);
      });

      it('cut mid-thread without the owner map: the second half does not route', () => {
        expect(route([ownerReply(), ownerOriginal()]).map(keysOf)).toEqual([[], []]);
      });
    });
  });

  describe('evidence carried across calls (#173 G-09 3b)', () => {
    // The worker routes a page of 10 at a time, so a prefix's two topics and two people can fall on different pages.
    const ledgerOf = (items: ReturnType<typeof message>[]) => notePrefixEvidence(new Map(), items, FIRM);
    const routeWith = (items: ReturnType<typeof message>[], known: PrefixLedger) =>
      routeByFirmRules(items, { internalDomains: FIRM, knownPrefixEvidence: known, scope: 'unscoped' });

    it('promotes a prefix whose topics and people arrive in different calls', () => {
      const first = [message('Kestrel: lender feedback')];
      expect(route(first).map(keysOf)).toEqual([[]]);
      const second = [message('Kestrel: site visit', { from: MARCUS })];
      // On its own the second call is one topic from one person: below the bar.
      expect(route(second).map(keysOf)).toEqual([[]]);
      expect(routeWith(second, ledgerOf(first)).map(keysOf)).toEqual([['kestrel']]);
      expect(routeWith(second, ledgerOf(first))[0].routes[0]).toEqual(
        expect.objectContaining({ fromSubjectPrefix: true, confidence: 0.8 }),
      );
    });

    it('does not change the evidence it is given', () => {
      const known = ledgerOf([message('Kestrel: lender feedback')]);
      routeWith([message('Kestrel: site visit', { from: MARCUS }), message('Kestrel: data room', { from: MARCUS })], known);
      const kestrel = known.get('mailbox-a')!.get('kestrel')!;
      expect([kestrel.seen.size, kestrel.senders.size]).toEqual([1, 1]);
    });

    it('keeps evidence per mailbox: one mailbox\'s evidence never promotes a prefix in another', () => {
      const known = ledgerOf([message('Kestrel: lender feedback', { source: 'mailbox-a' })]);
      expect(routeWith([message('Kestrel: site visit', { from: MARCUS, source: 'mailbox-b' })], known).map(keysOf)).toEqual([[]]);
    });

    it('holds keyed digests and counts, not plaintext, scoped by mailbox (audit P4)', () => {
      const known = ledgerOf([message('Kestrel: lender feedback', { source: ['mailbox-a', 'mailbox-b'] })]);
      const a = known.get('mailbox-a')!.get('kestrel')!;
      const b = known.get('mailbox-b')!.get('kestrel')!;
      const held = [...a.seen, ...a.senders];
      expect(held).toHaveLength(2);
      for (const value of held) expect(value).toMatch(/^[0-9a-f]{16}$/);
      // Keyed per process and scoped by source: neither a plain hash of the value nor equal across mailboxes.
      const plain = createHash('sha256').update('lender feedback', 'utf8').digest('hex').slice(0, 16);
      expect(a.seen.has(plain)).toBe(false);
      expect([...a.seen][0]).not.toBe([...b.seen][0]);
      const text = JSON.stringify([...known].map(([s, m]) => [s, [...m].map(([k, e]) => [k, e.word, ...e.seen, ...e.senders])]));
      for (const leak of ['lender', 'feedback', 'ellis', 'marcus', 'tidewell']) expect(text).not.toContain(leak);
    });

    it('keeps no more than the bar needs, and nothing once a prefix is promoted (audit P3)', () => {
      const one = ledgerOf([message('Kestrel: a'), message('Kestrel: b'), message('Kestrel: c')]);
      const kestrel = one.get('mailbox-a')!.get('kestrel')!;
      // One sender on three topics: below the bar, and only two topic digests kept.
      expect([kestrel.promoted, kestrel.seen.size, kestrel.senders.size]).toEqual([false, 2, 1]);
      notePrefixEvidence(one, [message('Kestrel: d', { from: MARCUS })], FIRM);
      expect([kestrel.promoted, kestrel.seen.size, kestrel.senders.size, kestrel.ownerTopics.size]).toEqual([true, 0, 0, 0]);
      // Promoted stays promoted; later evidence adds nothing.
      notePrefixEvidence(one, [message('Kestrel: e', { from: 'nina@tidewell.example' })], FIRM);
      expect([kestrel.promoted, kestrel.seen.size]).toEqual([true, 0]);
    });

    it('caps the prefixes tracked per mailbox: past the cap a new prefix is not carried, old ones still are (audit P3)', () => {
      const ledger = notePrefixEvidence(new Map(), [message('Alpha: one'), message('Bravo: one')], FIRM, new Map(), 2);
      notePrefixEvidence(ledger, [message('Charlie: one'), message('Alpha: two', { from: MARCUS })], FIRM, new Map(), 2);
      expect([...ledger.get('mailbox-a')!.keys()]).toEqual(['alpha', 'bravo']);
      expect(ledger.get('mailbox-a')!.get('alpha')!.promoted).toBe(true);
      expect(MAX_PREFIX_KEYS_PER_SOURCE).toBeGreaterThan(0);
      // A prefix the ledger did not carry can still promote within one batch.
      const batch = [message('Charlie: two', { from: MARCUS }), message('Charlie: three')];
      expect(routeWith(batch, ledger).map(keysOf)).toEqual([['charlie'], ['charlie']]);
    });

    it('promotes on carried evidence exactly as on one call', () => {
      const items = [message('Kestrel: lender feedback'), message('RE: Kestrel: site visit', { from: MARCUS })];
      const split = promotedPrefixes(notePrefixEvidence(ledgerOf([items[0]]), [items[1]], FIRM));
      expect(split).toEqual(subjectPrefixCodenames(items, FIRM));
    });
  });
});

describe('DISCOVERY_RULES_VERSION (#653)', () => {
  it('is bumped past the version #626 routed under, so mail read again is routed again', () => {
    expect(DISCOVERY_RULES_VERSION.startsWith('rules-')).toBe(true);
    expect(DISCOVERY_RULES_VERSION.startsWith('rules-2026-10-14')).toBe(false);
  });
});

describe('RoutingContext and subject prefix routes (#622)', () => {
  it('learns nothing from a subject prefix route: no codename and no thread for later pages', () => {
    const at = (subject: string, i: number) => ({
      item: normalizeMessage({
        id: `l${i}`,
        internetMessageId: `<learn-${i}@bank.example>`,
        conversationId: `conv-${i}`,
        subject,
        sentDateTime: '2026-05-01T10:00:00Z',
        from: { emailAddress: { address: i === 1 ? 'ellis@tidewell.example' : 'marcus@tidewell.example', name: null } },
        toRecipients: [],
        ccRecipients: [],
        body: { contentType: 'text', content: 'See attached.' },
      }),
      observations: [{ sourceId: 'a', providerItemId: `l${i}` }],
    });
    const routed = routeByFirmRules([at('Kestrel: lender feedback', 1), at('Kestrel: site visit', 2)], {
      internalDomains: ['tidewell.example'],
      scope: 'unscoped',
    });
    expect(routed.every((r) => r.routes.length === 1)).toBe(true);
    const context = new RoutingContext();
    context.learn(routed);
    expect(context.codenames.size).toBe(0);
    expect(context.threads.size).toBe(0);
  });
});

describe('source scope (#173 G-09)', () => {
  // deals and deals2 are shared sources (team or ownerless inboxes); ana and lena are personal mailboxes.
  const SCOPE: RoutingScope = { shared: new Set(['deals', 'deals2']) };
  let n = 0;
  const mail = (subject: string, o: { sources: string[]; body?: string; conv?: string; from?: string }) => {
    n += 1;
    const item = normalizeMessage({
      id: `s${n}`,
      internetMessageId: `<scope-${n}@bank.example>`,
      conversationId: o.conv ?? null,
      subject,
      sentDateTime: '2026-05-01T10:00:00Z',
      from: { emailAddress: { address: o.from ?? 'ellis@tidewell.example', name: null } },
      toRecipients: [],
      ccRecipients: [],
      body: { contentType: 'text', content: o.body ?? 'See attached.' },
    });
    return { item, observations: o.sources.map((sourceId) => ({ sourceId, providerItemId: `s${n}` })) };
  };
  const keys = (r: { routes: Array<{ codenameKey: string }> }) => r.routes.map((x) => x.codenameKey);
  const route = (
    items: ReturnType<typeof mail>[],
    scope: RoutingScope = SCOPE,
    extra: { counts?: RouteCounts; knownThreads?: Parameters<typeof routeByFirmRules>[1]['knownThreads']; internalDomains?: string[] } = {},
  ) => routeByFirmRules(items, { scope, ...extra });

  describe('admit', () => {
    const itemIn = (...sources: string[]) => mail('Subject', { sources });
    it('admits everything when unscoped', () => {
      expect(admit(itemIn('deals', 'ana'), new Set(), 'unscoped')).toBe(true);
    });
    it('admits an item no source observed only when unscoped (audit G6)', () => {
      const unobserved = { ...itemIn('deals'), observations: [] };
      expect(admit(unobserved, new Set(['deals', 'ana']), SCOPE)).toBe(false);
      expect(admit(unobserved, new Set(), 'unscoped')).toBe(true);
    });
    it('needs a shared source to have taught the key itself', () => {
      expect(admit(itemIn('deals'), new Set(['deals']), SCOPE)).toBe(true);
      expect(admit(itemIn('deals'), new Set(['deals2']), SCOPE)).toBe(false);
      expect(admit(itemIn('deals'), new Set(['ana']), SCOPE)).toBe(false);
    });
    it('needs a personal source to have a personal teacher somewhere, not the shared one', () => {
      expect(admit(itemIn('lena'), new Set(['ana']), SCOPE)).toBe(true);
      expect(admit(itemIn('lena'), new Set(['deals']), SCOPE)).toBe(false);
      expect(admit(itemIn('lena'), new Set(), SCOPE)).toBe(false);
    });
    it('needs every observing source to be allowed', () => {
      expect(admit(itemIn('ana', 'deals'), new Set(['ana']), SCOPE)).toBe(false);
      expect(admit(itemIn('ana', 'deals'), new Set(['deals']), SCOPE)).toBe(false);
      expect(admit(itemIn('ana', 'deals'), new Set(['ana', 'deals']), SCOPE)).toBe(true);
    });
  });

  it('refuses a key taught only in a shared source on a personal source, and counts the refusal', () => {
    const items = [mail('Project Fallow: bid process', { sources: ['deals'] }), mail('Fallow bidder call', { sources: ['ana'] })];
    const counts = { scopeBlocked: 0 };
    expect(route(items, SCOPE, { counts }).map(keys)).toEqual([['fallow'], []]);
    expect(counts).toEqual({ scopeBlocked: 1 });
    expect(route(items, 'unscoped').map(keys)).toEqual([['fallow'], ['fallow']]);
  });

  it('refuses a key taught only in a personal source on a shared source, and pools it across personal sources', () => {
    const items = [
      mail('Project Fallow: bid process', { sources: ['ana'] }),
      mail('Fallow bidder call', { sources: ['deals'] }),
      mail('Fallow bidder call', { sources: ['lena'] }),
    ];
    expect(route(items).map(keys)).toEqual([['fallow'], [], ['fallow']]);
  });

  it('lets a shared source route only on what it taught itself: another shared source is refused', () => {
    const items = [
      mail('Project Fallow: bid process', { sources: ['deals'] }),
      mail('Fallow bidder call', { sources: ['deals2'] }),
      mail('Fallow bidder call', { sources: ['deals'] }),
    ];
    expect(route(items).map(keys)).toEqual([['fallow'], [], ['fallow']]);
  });

  it('refuses a mixed copy both ways, and admits it once both sides taught the key', () => {
    const bare = (sources: string[]) => mail('Gorse diligence list', { sources });
    const counts = { scopeBlocked: 0 };
    expect(route([mail('Project Gorse: draft SPA', { sources: ['ana'] }), bare(['ana', 'deals'])], SCOPE, { counts }).map(keys)).toEqual([['gorse'], []]);
    expect(counts.scopeBlocked).toBe(1);
    expect(route([mail('Project Gorse: draft SPA', { sources: ['deals'] }), bare(['deals', 'ana'])]).map(keys)).toEqual([['gorse'], []]);
    expect(
      route([mail('Project Gorse: draft SPA', { sources: ['ana'] }), mail('Project Gorse: SPA mark-up', { sources: ['deals'] }), bare(['ana', 'deals'])]).map(keys),
    ).toEqual([['gorse'], ['gorse'], ['gorse']]);
  });

  it('does not launder a shared-only key into a personal mailbox through a mixed copy', () => {
    const items = [
      mail('Project Fallow: teaser draft', { sources: ['deals'] }),
      // Read in deals@ and in Ana's mailbox: the literal Aster teaches both, the bare Fallow is refused on the item.
      mail('Project Aster: weekly status', { sources: ['deals', 'ana'], body: 'Also, Fallow needs a decision on the teaser.' }),
      mail('Fallow teaser feedback', { sources: ['lena'] }),
      mail('Aster check-in', { sources: ['ana'] }),
      mail('Aster bidder call', { sources: ['deals'] }),
    ];
    const counts = { scopeBlocked: 0 };
    expect(route(items, SCOPE, { counts }).map(keys)).toEqual([['fallow'], ['aster'], [], ['aster'], ['aster']]);
    expect(counts.scopeBlocked).toBe(2);
  });

  describe('threads', () => {
    it('continues a thread only where the thread was taught: a shared reader of a personal root is refused', () => {
      const items = [
        mail('Buyer list', { sources: ['ana'], conv: 'c1', body: 'Draft list for Project Briar attached.' }),
        mail('RE: Buyer list', { sources: ['deals'], conv: 'c1' }),
        mail('RE: Buyer list', { sources: ['lena'], conv: 'c1' }),
      ];
      const counts = { scopeBlocked: 0 };
      expect(route(items, SCOPE, { counts }).map(keys)).toEqual([['briar'], [], ['briar']]);
      expect(counts.scopeBlocked).toBe(1);
    });

    it('inherits what the key was taught in when an alias starts the thread, and never widens it', () => {
      const items = [
        mail('Project Fallow: teaser draft', { sources: ['deals'] }),
        // An alias route in deals@: the thread inherits {deals}, not a personal teacher.
        mail('Seller call', { sources: ['deals'], conv: 'c2', body: 'Fallow agenda attached.' }),
        mail('RE: Seller call', { sources: ['deals'], conv: 'c2' }),
        mail('RE: Seller call', { sources: ['ana'], conv: 'c2' }),
      ];
      expect(route(items).map(keys)).toEqual([['fallow'], ['fallow'], ['fallow'], []]);
    });

    it('admits nothing from a known thread without taughtIn, and everything it names in taughtIn', () => {
      const reply = mail('RE: Buyer list', { sources: ['deals'], conv: 'c1' });
      const thread = threadKey(reply.item)!;
      const known = (taughtIn: string[]) => new Map([[thread, new Map([['briar', { codename: 'Project Briar', taughtIn: new Set(taughtIn) }]])]]);
      expect(route([reply], SCOPE, { knownThreads: known([]) }).map(keys)).toEqual([[]]);
      expect(route([reply], SCOPE, { knownThreads: known(['ana']) }).map(keys)).toEqual([[]]);
      expect(route([reply], SCOPE, { knownThreads: known(['deals']) }).map(keys)).toEqual([['briar']]);
      expect(route([reply], 'unscoped', { knownThreads: known([]) }).map(keys)).toEqual([['briar']]);
    });
  });

  describe('knownCodenames', () => {
    const bare = () => mail('Falcon bidder call', { sources: ['deals'] });
    const known = (taughtIn?: string[]) => [{ key: 'falcon', codename: 'Project Falcon', ...(taughtIn ? { taughtIn: new Set(taughtIn) } : {}) }];

    it('admits nothing without taughtIn when scoped, and still routes unscoped', () => {
      expect(routeByFirmRules([bare()], { knownCodenames: known(), scope: SCOPE }).map(keys)).toEqual([[]]);
      expect(routeByFirmRules([bare()], { knownCodenames: known(), scope: 'unscoped' }).map(keys)).toEqual([['falcon']]);
    });

    it('admits the sources it names', () => {
      expect(routeByFirmRules([bare()], { knownCodenames: known(['deals']), scope: SCOPE }).map(keys)).toEqual([['falcon']]);
      expect(routeByFirmRules([bare()], { knownCodenames: known(['deals2']), scope: SCOPE }).map(keys)).toEqual([[]]);
    });
  });

  it('never teaches from a subject prefix: a prefix promoted in a shared source adds it to no key', () => {
    const FIRM = ['tidewell.example'];
    const items = [
      mail('Project Kestrel: bid process', { sources: ['ana'] }),
      mail('Kestrel: lender feedback', { sources: ['deals'] }),
      mail('Kestrel: site visit', { sources: ['deals'], from: 'marcus@tidewell.example' }),
      mail('Kestrel bidder call', { sources: ['deals'] }),
    ];
    // The prefix routes deals@'s own subjects; the bare word there is still refused, because only Ana's mail taught it.
    expect(route(items, SCOPE, { internalDomains: FIRM }).map(keys)).toEqual([['kestrel'], ['kestrel'], ['kestrel'], []]);
  });
});
