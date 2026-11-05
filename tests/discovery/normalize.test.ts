import { describe, expect, it } from 'vitest';

import {
  collisionMetrics,
  cosineSimilarity,
  dedupeObservations,
  documentKey,
  htmlToText,
  isDocumentKey,
  isReplySubject,
  lengthRatio,
  normalizeDocument,
  normalizeMessage,
  normalizeSubject,
  participantsOf,
  stripQuotedHistory,
  type Observation,
} from '@/lib/discovery/normalize';
import { loadFixtureMailboxes } from '@/lib/graph/reader/fixture';

import { fixtureCapability } from './fixtureCapability';

const mailboxes = loadFixtureMailboxes(fixtureCapability);
const message = (internetMessageId: string) => {
  for (const box of mailboxes) {
    const found = box.messages.find((m) => m.internetMessageId === internetMessageId);
    if (found) return found;
  }
  throw new Error(`fixture message ${internetMessageId} missing`);
};

describe('htmlToText', () => {
  it('turns blocks into lines, drops tags and decodes entities', () => {
    expect(htmlToText('<p>Morgan,</p><p>Heliotrope&#39;s board &amp; CFO<br>agree</p>')).toBe(
      "Morgan,\n\nHeliotrope's board & CFO\nagree",
    );
  });

  it('drops script and style content', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Kept</p><script>alert(1)</script>')).toBe('Kept');
  });

  it('flattens the fixture HTML kickoff mail', () => {
    const item = normalizeMessage(message('<falcon-001@bank.example>'));
    expect(item.bodyText).toBe(
      "Morgan, Dana,\n\nProject Falcon kicks off next week. Heliotrope's board approved the sale process on Friday.\n\nStorm",
    );
  });
});

describe('stripQuotedHistory', () => {
  it('cuts at an "On ... wrote:" line and drops > lines', () => {
    const item = normalizeMessage(message('<falcon-004@heliotrope.example>'));
    expect(item.bodyText).toBe('Thanks Storm. The board is aligned on the timeline.');
    expect(item.bodyText).not.toContain('Falcon');
  });

  it('cuts at an Outlook Original Message block, so a forward does not carry the quoted codename', () => {
    const item = normalizeMessage(message('<fwd-008@bank.example>'));
    expect(item.bodyText).toBe('FYI, see below.');
  });

  it('treats a From: line as a header block only when Sent: or Date: follows', () => {
    expect(stripQuotedHistory('From: the board, a clear yes.\nNext steps follow.')).toBe(
      'From: the board, a clear yes.\nNext steps follow.',
    );
    expect(stripQuotedHistory('Agreed.\n\nFrom: Dana Price\nSent: Monday\nSubject: x\n\nold')).toBe('Agreed.');
  });
});

describe('normalizeSubject', () => {
  it('drops stacked reply and forward prefixes and lowercases', () => {
    expect(normalizeSubject('RE: FW: Heliotrope next steps')).toBe('heliotrope next steps');
    expect(normalizeSubject('Fwd:  Re:Heliotrope   next steps')).toBe('heliotrope next steps');
    expect(normalizeSubject(null)).toBe('');
  });
});

describe('isReplySubject (#653)', () => {
  it('is true when the subject opens with a reply token, with an optional [n], in any case', () => {
    for (const subject of ['RE: Kestrel: site visit', 're: x', 'Re:x', 'AW: Terminplan', 'SV: Tidsplan', 'RE[2]: x', 'Re [3] : x', '  RE: padded', 'RE: FW: x']) {
      expect(isReplySubject(subject), subject).toBe(true);
    }
  });

  it('is false for a forward, an original and a word that merely starts with a reply token', () => {
    for (const subject of ['FW: RE: x', 'Fwd: x', 'WG: x', 'TR: x', 'Kestrel: site visit', 'Reminder: x', 'Revenue: x', 'Re x', '', null, undefined]) {
      expect(isReplySubject(subject), String(subject)).toBe(false);
    }
  });
});

describe('participantsOf', () => {
  it('lists sender, To and Cc once each, lowercased', () => {
    expect(participantsOf(message('<falcon-001@bank.example>'))).toEqual([
      { role: 'from', address: 'storm.duncan@bank.example', name: 'Storm Duncan' },
      { role: 'to', address: 'morgan.vale@bank.example', name: 'Morgan Vale' },
      { role: 'cc', address: 'dana.price@heliotrope.example', name: 'Dana Price' },
    ]);
  });
});

describe('dedupeObservations', () => {
  it('keeps one item per internet_message_id with every mailbox it was seen in', () => {
    const observations: Observation[] = mailboxes.flatMap((box) =>
      box.messages.map((m) => ({ sourceId: box.mailbox, providerItemId: m.id, item: normalizeMessage(m) })),
    );
    const { items: deduped, collisions } = dedupeObservations(observations);

    expect(collisions).toEqual([]);
    expect(observations).toHaveLength(17);
    expect(deduped).toHaveLength(14);
    const kickoff = deduped.find((d) => d.item.internetMessageId === '<falcon-001@bank.example>');
    expect(kickoff?.observations.map((o) => o.sourceId).sort()).toEqual([
      'morgan.vale@bank.example',
      'storm.duncan@bank.example',
    ]);
    const lunch = deduped.find((d) => d.item.internetMessageId === '<lunch-006@bank.example>');
    expect(lunch?.observations).toHaveLength(2);
  });

  it('never merges a different message that reuses a known id: the first keeps it, the other is a collision', () => {
    const genuine = normalizeMessage(message('<falcon-001@bank.example>'));
    const forged = normalizeMessage({
      ...message('<lunch-006@bank.example>'),
      internetMessageId: ' <falcon-001@bank.example> ',
    });
    expect(forged.internetMessageId).toBe(genuine.internetMessageId);
    expect(forged.contentHash).not.toBe(genuine.contentHash);

    const { items, collisions } = dedupeObservations([
      { sourceId: 'alice', providerItemId: 'a-1', item: genuine },
      { sourceId: 'bob', providerItemId: 'b-1', item: forged },
      { sourceId: 'carol', providerItemId: 'c-1', item: genuine },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].item).toBe(genuine);
    expect(items[0].observations.map((o) => o.sourceId)).toEqual(['alice', 'carol']);
    expect(collisions).toEqual([
      {
        sourceId: 'bob',
        providerItemId: 'b-1',
        key: genuine.internetMessageId,
        itemHash: forged.contentHash,
        ...collisionMetrics(genuine, forged),
      },
    ]);
    expect(collisions[0].similarity).toBeLessThan(1);
  });

  it('refuses a message whose id is blank or shaped like a document key', () => {
    const base = message('<falcon-002@bank.example>');
    expect(() => normalizeMessage({ ...base, internetMessageId: '  ' })).toThrow(/usable Internet message id/);
    expect(() => normalizeMessage({ ...base, internetMessageId: documentKey('D1:f-cim') })).toThrow(
      /usable Internet message id/,
    );
  });

  it('hashes content deterministically', () => {
    const a = normalizeMessage(message('<falcon-002@bank.example>'));
    const b = normalizeMessage(message('<falcon-002@bank.example>'));
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe('normalizeDocument (phase 4)', () => {
  it('makes a SharePoint document an item keyed by its drive item, with no thread', () => {
    const item = normalizeDocument({
      driveItemKey: 'D1:f-cim',
      providerItemId: 'f-cim',
      name: ' Falcon CIM.docx ',
      drivePath: '/Deals/Falcon CIM.docx',
      lastModifiedDateTime: '2026-03-01T10:00:00Z',
      authors: [{ address: 'morgan.vale@bank.example', name: 'Morgan Vale' }],
      text: '  Project Falcon memorandum  ',
      cTag: 'c1',
    });
    expect(item).toMatchObject({
      internetMessageId: documentKey('D1:f-cim'),
      conversationId: null,
      subject: 'Falcon CIM.docx',
      sentAt: '2026-03-01T10:00:00Z',
      participants: [{ role: 'from', address: 'morgan.vale@bank.example', name: 'Morgan Vale' }],
      bodyText: 'Project Falcon memorandum',
      kind: 'document',
      driveItemKey: 'D1:f-cim',
      drivePath: '/Deals/Falcon CIM.docx',
    });
    expect(isDocumentKey(item.internetMessageId)).toBe(true);
    expect(isDocumentKey('<falcon-001@bank.example>')).toBe(false);
  });
});


describe('collision metrics', () => {
  it('scores identical text 1 and text with no word in common 0', () => {
    expect(cosineSimilarity('Project Falcon kickoff', 'project falcon KICKOFF')).toBe(1);
    expect(cosineSimilarity('Project Falcon', 'lunch tomorrow')).toBe(0);
    expect(cosineSimilarity('', '')).toBe(1);
    expect(cosineSimilarity('Falcon', '')).toBe(0);
  });

  it('scores a copy with an external banner as a near-duplicate', () => {
    const body = 'Team, the Falcon management presentation moves to Thursday. Please send comments on the CIM by noon.';
    const banner = `[EXTERNAL] This message came from outside the organization.\n${body}`;
    expect(cosineSimilarity(body, banner)).toBeGreaterThan(0.75);
    expect(lengthRatio(body, banner)).toBeGreaterThan(0.6);
  });

  it('measures length as the shorter over the longer', () => {
    expect(lengthRatio('abcd', 'ab')).toBe(0.5);
    expect(lengthRatio('', '')).toBe(1);
    expect(lengthRatio('abc', '')).toBe(0);
  });

  it('compares subject and text together', () => {
    const same = collisionMetrics({ subject: 'Falcon', bodyText: 'kickoff' }, { subject: 'Falcon', bodyText: 'kickoff' });
    expect(same).toEqual({ similarity: 1, lengthRatio: 1 });
  });
});
