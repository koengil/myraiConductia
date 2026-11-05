// @vitest-environment node
// The rule detector rules/v1 (#173 G-07 slice 3a, design R7). The demo seed is the positive golden set, the
// hand-written negatives must all yield nothing, and the clause orders, skip markers, date forms and the
// wrapped quote opener are pinned one by one. Failures name message ids and line numbers, never a sentence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cutWrappedQuoteOpener, detectMilestones, RULES_V1, RULES_VERSION } from '@/lib/discovery/detect';
import { MILESTONE_STATION, type MilestoneType } from '@/lib/discovery/milestones';
import { bodyText } from '@/lib/discovery/normalize/text';

const SENT = '2026-09-20T09:00:00Z';
const typesOf = (body: string, sentAt = SENT) => detectMilestones(body, sentAt).map((e) => e.type);
const dateOf = (body: string, sentAt = SENT) => detectMilestones(body, sentAt).map((e) => e.occurredAt);

type SeedMessage = { messageId: string; date: string; body: { contentType: 'html' | 'text'; content: string } };
const SEED: SeedMessage[] = readFileSync(join(process.cwd(), 'tests/fixtures/discovery/demo/gmail-seed.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as SeedMessage);
const idOf = (messageId: string) => messageId.replace(/^<|@.*$/g, '');
const seedBody = (id: string) => {
  const m = SEED.find((s) => idOf(s.messageId) === id);
  if (!m) throw new Error(`no seed message ${id}`);
  return { body: bodyText(m.body), sentAt: m.date };
};

/** Every event the detector finds in the demo seed, as type@date per message id. Messages not listed yield none. */
const GOLDEN: Record<string, string[]> = {
  'kestrel-002': ['engagement_letter_signed@2026-05-06'],
  'kestrel-004': ['vdr_opened@2026-05-28'],
  'kestrel-011': ['process_letter_sent@2026-08-12'],
  'kestrel-012': ['bids_received@2026-08-28'],
  'kestrel-013': ['loi_signed@2026-09-18'],
  'kestrel-014': ['loi_signed@2026-09-18'],
  'kestrel-015': ['loi_signed@2026-09-18'],
  'kestrel-018': ['signed@2026-10-28'],
  'harbor-003': ['exclusivity_granted@2026-09-17'],
  'osprey-001': ['engagement_letter_signed@2025-01-13'],
  'osprey-002': ['vdr_opened@2025-02-04'],
  'osprey-004': ['loi_signed@2025-04-15'],
  'osprey-005': ['signed@2025-05-30'],
};

const NEGATIVES_FILE = 'tests/fixtures/discovery/detect/negatives.v1.txt';
const NEGATIVES_TEXT = readFileSync(join(process.cwd(), NEGATIVES_FILE), 'utf8');
const NEGATIVES = NEGATIVES_TEXT.split('\n')
  .map((raw, i) => ({ line: i + 1, text: raw.replace(/\\n/g, '\n') }))
  .filter(({ text }) => text.trim() !== '' && !text.startsWith('#'));

describe('rules/v1', () => {
  it('is versioned, and covers seven station-bearing types with no lifecycle or NDA type', () => {
    expect(RULES_VERSION).toBe('rules/v1');
    const types = RULES_V1.map((r) => r.type);
    expect(types).toEqual([
      'loi_signed',
      'exclusivity_granted',
      'signed',
      'bids_received',
      'vdr_opened',
      'engagement_letter_signed',
      'process_letter_sent',
    ]);
    for (const type of types) expect(MILESTONE_STATION[type], type).not.toBeNull();
    const out: MilestoneType[] = ['closed', 'announced', 'client_nda_signed', 'buyer_nda_executed', 'process_paused', 'process_terminated'];
    for (const type of out) expect(types, type).not.toContain(type);
  });
});

describe('the demo seed is the positive golden set', () => {
  it('finds exactly the golden events, normalized the way ingestion stores the body', () => {
    expect(SEED).toHaveLength(38);
    const found: Record<string, string[]> = {};
    for (const m of SEED) {
      const events = detectMilestones(bodyText(m.body), m.date).map((e) => `${e.type}@${e.occurredAt}`);
      if (events.length > 0) found[idOf(m.messageId)] = events;
    }
    expect(found).toEqual(GOLDEN);
  });

  it('catches the team-only kestrel-015 LOI and points its span at the LOI sentence', () => {
    const { body, sentAt } = seedBody('kestrel-015');
    const [event, ...rest] = detectMilestones(body, sentAt);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ type: 'loi_signed', occurredAt: '2026-09-18', confidence: 0.5 });
    expect(body.slice(event.spanStart, event.spanEnd)).toBe('The LOI for Project Kestrel was signed today, 18 September 2026.');
  });
});

describe('the negative corpus', () => {
  it('holds at least 50 hand-written negatives across every category', () => {
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(50);
    for (const header of [
      '# negation',
      '# questions',
      '# plans and the future',
      '# conditions and time relations',
      '# comparables',
      '# wrapped quote openers',
      '# closed the data room',
      '# requests and imperatives',
      '# questions with a lower-case line after',
      '# refuted and hypothetical',
    ]) {
      expect(NEGATIVES_TEXT.split('\n'), header).toContain(header);
    }
  });

  it('yields no event for any negative (failures list line numbers only)', () => {
    const hits = NEGATIVES.filter(({ text }) => detectMilestones(text, SENT).length > 0).map(({ line }) => `${NEGATIVES_FILE}:${line}`);
    expect(hits).toEqual([]);
  });
});

describe('clause orders', () => {
  it.each([
    ['passive, no auxiliary', 'The data room opened on 28 May 2026.', 'vdr_opened'],
    ['passive, were', 'Final bids were received on 28 August 2026.', 'bids_received'],
    ['passive, has been', 'The process letter has been sent to six buyers.', 'process_letter_sent'],
    ['passive, got', 'The engagement letter got countersigned on 6 May 2026.', 'engagement_letter_signed'],
    ['passive, came in', 'Three indications of interest came in on 3 August 2026.', 'bids_received'],
    ['passive, went live', 'The VDR went live on 4 February 2025.', 'vdr_opened'],
    ['passive, went out', 'The process letter went out on 12 August 2026.', 'process_letter_sent'],
    ['passive, three words apart with the auxiliary, a name counting as one', 'The LOI for Project Kestrel was signed.', 'loi_signed'],
    ['passive, has been with one word between', 'The SPA itself has been signed.', 'signed'],
    ['active', 'Aldermoor signed the letter of intent on 18 September 2026.', 'loi_signed'],
    ['active, has', 'Northwind has countersigned the exclusivity agreement.', 'exclusivity_granted'],
    ['active, no determiner', 'Northwind granted exclusivity to Aldermoor on 17 September 2026.', 'exclusivity_granted'],
    ['active, executed', 'Both parties executed the purchase agreement on 30 May 2025.', 'signed'],
    ['active, a modifier between', 'We received three bids on 28 August 2026.', 'bids_received'],
    ['active, the and a modifier', 'Larkspur opened the virtual data room on 4 February 2025.', 'vdr_opened'],
    ['active, sent', 'Storm sent the process letter to both bidders.', 'process_letter_sent'],
  ])('matches %s', (_label, sentence, type) => {
    expect(typesOf(sentence)).toEqual([type]);
  });

  it.each([
    ['four words apart', 'The LOI for the Kestrel deal was signed.'],
    ['four words apart, counting has been (audit S13)', 'The LOI for Project Kestrel has been signed.'],
    ['three words and an auxiliary (audit S13)', 'The LOI for the deal was signed.'],
    ['a comma between', 'The LOI, as drafted by counsel, was signed.'],
    ['a relative clause between', 'The LOI which Aldermoor drafted was signed.'],
    ['no subject before an active verb', 'Signed the LOI on 18 September 2026.'],
    ['a determiner before the verb (an adjective)', 'Aldermoor returned the signed LOI.'],
    ['signed off', 'Legal signed off on the SPA.'],
    ['a lower-case acronym', 'The hotel spa was signed over to the buyer.'],
    ['a verb outside the rule', 'Northwind closed the data room on 30 September 2026.'],
  ])('does not match with %s', (_label, sentence) => {
    expect(typesOf(sentence)).toEqual([]);
  });

  it('finds one event per rule per sentence, in body order, each spanning its own sentence', () => {
    const body = 'The LOI was signed on 18 September 2026. The SPA was signed on 28 October 2026.';
    const events = detectMilestones(body, '2026-10-30T09:00:00Z');
    expect(events.map((e) => `${e.type}@${e.occurredAt}`)).toEqual(['loi_signed@2026-09-18', 'signed@2026-10-28']);
    expect(events.map((e) => body.slice(e.spanStart, e.spanEnd))).toEqual([
      'The LOI was signed on 18 September 2026.',
      'The SPA was signed on 28 October 2026.',
    ]);
    expect(typesOf('The LOI was signed on 18 September 2026 and the LOI was countersigned too.')).toEqual(['loi_signed']);
  });

  it('yields nothing for an unreadable sent time', () => {
    expect(detectMilestones('The LOI was signed on 18 September 2026.', 'not a date')).toEqual([]);
  });
});

describe('skip markers', () => {
  const BASE = 'The LOI was signed on 18 September 2026';

  it('leaves the unmarked base sentence matching, so each case below is skipped by its marker alone', () => {
    expect(typesOf(`${BASE}.`)).toEqual(['loi_signed']);
  });

  it.each([
    // a question
    ['?', '?'],
    // negation
    ['not', ', not on the 17th.'],
    ["n't", ", but Castellan wasn't told."],
    ['never', ', and Castellan never replied.'],
    ['no longer', ', and Castellan is no longer in the process.'],
    ['yet to', ', and Castellan has yet to reply.'],
    ['without', ' without the board.'],
    // a plan or the future
    ['will', ', and diligence will start on Monday.'],
    ['would', ', as Castellan would.'],
    ['should', ', as it should.'],
    ['shall', ', and we shall proceed.'],
    ['expect', ', as we expect.'],
    ['plan', ' per the plan.'],
    ['aim', ', which was the aim.'],
    ['intend', ', as we intended.'],
    ['to be', ', as it had to be.'],
    ['going to', ', as it was going to.'],
    ['draft of', ' as a draft of the final terms.'],
    ['next week', ', with diligence next week.'],
    ['pending', ', pending board approval.'],
    ['subject to', ' subject to financing.'],
    ['once', ' at once.'],
    ['target', ', on target.'],
    ['may', ', and Castellan may follow.'],
    // a condition or a time relation
    ['if', ' if the board agrees.'],
    ['unless', ' unless Castellan objects.'],
    ['when', ' when the board met.'],
    ['whenever', ', as happens whenever terms are agreed.'],
    ['until', ' until the board met.'],
    ['before', ' before the board met.'],
    ['after', ' after the board met.'],
    ['assuming', ', assuming the board agrees.'],
    ['provided', ', provided the board agrees.'],
    ['in case', ', in case Castellan asks.'],
    ['whether', ', whether or not Castellan agrees.'],
    // a comparison
    ['benchmark', ', our benchmark for timing.'],
    ['comparable', ', in a comparable deal.'],
    ['comps', ', in the comps.'],
    ['precedent', ', in the precedent.'],
    ['similar', ', in a similar deal.'],
    ['like the', ', like the Osprey deal.'],
  ])('skips a sentence with %s', (_marker, tail) => {
    expect(typesOf(`${BASE}${tail}`)).toEqual([]);
  });

  it.each([
    // a request (audit S9)
    ['need', 'We need the LOI signed by Friday.'],
    ['please get', 'Please get the engagement letter countersigned.'],
    ["let's get", "Let's get the SPA executed."],
    ['kindly confirm', 'Kindly confirm the LOI was countersigned.'],
    ['awaiting', 'Ludlow is awaiting the LOI signed by Corvane.'],
    ['hopefully', 'Hopefully the bids were received by now.'],
    ['requested', 'Corvane requested the data room opened to their advisers.'],
    // an instruction: a sentence that opens on a bare verb (audit S9)
    ['a bare imperative', 'Send the process letter to the remaining bidders.'],
    ['a bare imperative after a bullet', '- Have the purchase agreement executed by both parties.'],
    // refuted, hedged or a template (audit S11)
    ['a rumour', 'The rumor that the LOI was signed is false.'],
    ['a hedge to check', 'I think the SPA was signed but need to check.'],
    ['supposedly', 'Supposedly the bids were received on Friday.'],
    ['a template placeholder', 'Template: The LOI was signed on [date].'],
    ['an angle-bracket placeholder', 'The data room opened on <date>.'],
  ])('skips a sentence with %s', (_marker, sentence) => {
    expect(typesOf(sentence)).toEqual([]);
  });

  it('reads past tense with "got" and "confirmed" as a report, not a request', () => {
    expect(typesOf('We got the LOI signed on 18 September 2026.')).toEqual(['loi_signed']);
    expect(typesOf('Confirmed: the LOI was signed on 18 September 2026.')).toEqual(['loi_signed']);
  });

  it('ends a question at its question mark whatever follows (audit S10)', () => {
    expect(typesOf('Was the LOI signed?\nthanks')).toEqual([]);
    expect(typesOf('Was the SPA executed? let me know')).toEqual([]);
    expect(typesOf('Was the LOI signed? Yes. The LOI was signed on 18 September 2026.')).toEqual(['loi_signed']);
  });

  it('reads "May" the month as a date, not as the modal', () => {
    expect(detectMilestones('The data room opened on 28 May 2026.', SENT).map((e) => e.occurredAt)).toEqual(['2026-05-28']);
  });
});

describe('date forms', () => {
  it.each([
    ['D Month YYYY', 'The LOI was signed on 18 September 2026.', SENT, '2026-09-18'],
    ['D Mon YYYY', 'The LOI was signed on 18 Sep 2026.', SENT, '2026-09-18'],
    ['D Mon. YYYY', 'The LOI was signed on 18 Sept. 2026.', SENT, '2026-09-18'],
    ['Month D, YYYY', 'The LOI was signed on September 18, 2026.', SENT, '2026-09-18'],
    ['Mon D, YYYY', 'The LOI was signed on Sep 18, 2026.', SENT, '2026-09-18'],
    ['an ordinal day', 'The LOI was signed on 18th September 2026.', SENT, '2026-09-18'],
    ['YYYY-MM-DD', 'The LOI was signed on 2026-09-18.', SENT, '2026-09-18'],
    ['D Month, this year', 'The LOI was signed on 18 September.', SENT, '2026-09-18'],
    ['Month D, this year', 'The LOI was signed on September 18.', SENT, '2026-09-18'],
    ['D Month after the sent date, so last year', 'The LOI was signed on 28 December.', '2027-01-03T09:00:00Z', '2026-12-28'],
    ['today', 'The LOI was signed today.', SENT, '2026-09-20'],
    ['yesterday, across a month end', 'The LOI was signed yesterday.', '2026-10-01T08:00:00Z', '2026-09-30'],
    ['today and the date after the verb', 'The LOI was signed today, 18 September 2026.', '2026-09-18T17:30:00Z', '2026-09-18'],
    // the date tied to the verb, not the leftmost (audit S12)
    ['the date after the verb, not an earlier one', 'On 1 September 2026 Ludlow got approval; the LOI was signed on 18 September 2026.', SENT, '2026-09-18'],
    ['the date nearest before the verb', 'On 1 September 2026 we met, and on 18 September 2026 the LOI was signed.', SENT, '2026-09-18'],
    ['last week (seven days before the sent day)', 'The LOI was signed last week.', SENT, '2026-09-13'],
    ['last month (the first of the month before)', 'The LOI was signed last month.', SENT, '2026-08-01'],
    ['last year (the first of January before)', 'The LOI was signed last year.', SENT, '2025-01-01'],
    // the sender's local day (audit S12)
    ['today, late evening at the sender', 'The LOI was signed today.', '2026-09-18T22:30:00-04:00', '2026-09-18'],
    ['today, in UTC when no offset is kept', 'The LOI was signed today.', '2026-09-19T02:30:00Z', '2026-09-19'],
    ['an ambiguous numeric date (falls back to the sent date)', 'The LOI was signed on 18/09/2026.', SENT, '2026-09-20'],
    ['an impossible date (falls back to the sent date)', 'The LOI was signed on 31 September 2026.', SENT, '2026-09-20'],
    ['no date (the sent date)', 'The LOI was signed.', SENT, '2026-09-20'],
  ])('reads %s', (_label, sentence, sentAt, date) => {
    expect(dateOf(sentence, sentAt)).toEqual([date]);
  });
});

describe('the wrapped quote opener', () => {
  const QUOTED = 'The LOI for Project Kestrel was signed today, 18 September 2026.';
  const reply = (opener: string) => `Thanks, noted.\n\n${opener}\n${QUOTED}`;

  it('leaves the quoted sentence detectable on its own, so the cuts below are what drop it', () => {
    expect(typesOf(QUOTED)).toEqual(['loi_signed']);
  });

  it.each([
    ['a one-line opener', 'On Fri, 18 Sep 2026 at 17:30, Storm Duncan <storm.duncan@bank.example> wrote:'],
    ['a two-line opener', 'On Fri, 18 Sep 2026 at 17:30, Storm Duncan <storm.duncan@bank.example>\nwrote:'],
    ['a two-line opener with the address wrapped', 'On Fri, 18 Sep 2026 at 17:30, Storm Duncan\n<storm.duncan@bank.example> wrote:'],
    ['a three-line opener', 'On Fri, 18 Sep 2026 at 17:30,\nStorm Duncan\n<storm.duncan@bank.example> wrote:'],
  ])('cuts the body at %s', (_label, opener) => {
    const body = reply(opener);
    expect(cutWrappedQuoteOpener(body)).toBe('Thanks, noted.\n\n');
    expect(detectMilestones(body, SENT)).toEqual([]);
  });

  it('keeps a line that only starts with "On" and ends a sentence', () => {
    const body = 'On Friday the data room opened.\nThe LOI was signed on 18 September 2026.';
    expect(cutWrappedQuoteOpener(body)).toBe(body);
    expect(typesOf(body)).toEqual(['vdr_opened', 'loi_signed']);
  });

  it('keeps an "On" line separated from "wrote:" by a blank line', () => {
    const body = `On Fri, 18 Sep 2026 at 17:30, Storm Duncan\n\nwrote:\n${QUOTED}`;
    expect(cutWrappedQuoteOpener(body)).toBe(body);
  });
});
