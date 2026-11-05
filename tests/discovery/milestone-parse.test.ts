import { describe, expect, it } from 'vitest';

import { parseMilestoneReply } from '@/lib/discovery/extract/parse';

const BODY = 'Elena,\n\nThe letter of intent for Project Kestrel was signed on\n18 September 2026.   We now move to confirmatory diligence.\n\nStorm';
const QUOTE = 'The letter of intent for Project Kestrel was signed on\n18 September 2026.';
const reply = (m: Record<string, unknown>) => JSON.stringify({ milestones: [{ type: 'loi_signed', occurred_on: '2026-09-18', quote: QUOTE, confidence: 0.9, ...m }] });

describe('parseMilestoneReply', () => {
  it('reads bare JSON', () => {
    const r = parseMilestoneReply(reply({}), BODY);
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'loi_signed', occurredAt: '2026-09-18', confidence: 0.9 });
    expect(BODY.slice(r.events[0].spanStart, r.events[0].spanEnd)).toBe(QUOTE);
  });

  it('reads fenced JSON with prose around it', () => {
    const r = parseMilestoneReply('Here you go:\n```json\n' + reply({}) + '\n```\nDone.', BODY);
    expect(r.ok).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(parseMilestoneReply('{"milestones":[]}', BODY)).toEqual({ ok: true, events: [] });
  });

  it('rejects text that is not JSON', () => {
    expect(parseMilestoneReply('I could not find any milestones.', BODY)).toEqual({ ok: false, error: 'not_json' });
  });

  it.each([
    ['an unknown type', { type: 'deal_won' }],
    ['a bad date', { occurred_on: '18/09/2026' }],
    ['an impossible date', { occurred_on: '2026-02-31' }],
    ['confidence above one', { confidence: 1.2 }],
    ['negative confidence', { confidence: -0.1 }],
    ['a missing confidence', { confidence: undefined }],
    ['an empty quote', { quote: '  ' }],
    ['an over-long quote', { quote: 'x'.repeat(601) }],
  ])('rejects %s as schema', (_name, patch) => {
    expect(parseMilestoneReply(reply(patch), BODY)).toEqual({ ok: false, error: 'schema' });
  });

  it('rejects a payload with no milestones array as schema', () => {
    expect(parseMilestoneReply('{"events":[]}', BODY)).toEqual({ ok: false, error: 'schema' });
  });

  it('rejects a quote that is not in the body', () => {
    expect(parseMilestoneReply(reply({ quote: 'The LOI was signed on 19 September 2026.' }), BODY)).toEqual({
      ok: false,
      error: 'span_not_found',
    });
  });

  it('still finds the span when the model reflowed the whitespace', () => {
    const r = parseMilestoneReply(
      reply({ quote: 'The letter of intent for Project Kestrel was signed on 18 September 2026.' }),
      BODY,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const covered = BODY.slice(r.events[0].spanStart, r.events[0].spanEnd);
    expect(covered.startsWith('The letter of intent')).toBe(true);
    expect(covered.endsWith('18 September 2026.')).toBe(true);
  });

  it('drops the second of two milestones of one type on one span', () => {
    const one = { type: 'loi_signed', occurred_on: '2026-09-18', quote: QUOTE, confidence: 0.9 };
    const r = parseMilestoneReply(JSON.stringify({ milestones: [one, { ...one, confidence: 0.5 }] }), BODY);
    expect(r.ok && r.events).toHaveLength(1);
  });

  it('keeps no quote text in what it returns', () => {
    const r = parseMilestoneReply(reply({}), BODY);
    expect(JSON.stringify(r)).not.toContain('letter of intent');
    expect(Object.keys((r as { events: object[] }).events[0]).sort()).toEqual([
      'confidence',
      'occurredAt',
      'spanEnd',
      'spanStart',
      'type',
    ]);
  });
});
