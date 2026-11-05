import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEMO_PERSONAS, parseCorpus, readCorpus } from '../scripts/discovery/lib/mailCorpus';
import { loadFixtureMailboxes } from '@/lib/graph/reader/fixture';

import { fixtureCapability } from './discovery/fixtureCapability';

// The synthetic-only rule (R3): nothing in the demo corpus can be a real
// bank, person or Ignatious record.

const CORPUS_PATH = 'tests/fixtures/discovery/demo/corpus.json';
const corpus = readCorpus(CORPUS_PATH);
const PERSONAS = Object.keys(DEMO_PERSONAS);
const DENYLIST = /ignatious|intellibank|tidewell/i;
const BASE_KEYS = /\b(Falcon|Cobra|Heliotrope)\b/;

describe('the demo corpus is synthetic', () => {
  it.each(corpus.messages.map((m) => [m.messageId, m] as const))('%s is synthetic', (_id, m) => {
    for (const a of [m.from, ...m.to, ...m.cc]) {
      expect(PERSONAS.includes(a.address) || /@[a-z0-9-]+\.example$/.test(a.address), a.address).toBe(true);
    }
    expect(m.mailboxes.every((b) => PERSONAS.includes(b))).toBe(true);
    const text = `${m.subject}\n${m.body.content}`;
    expect(text).not.toMatch(/https?:\/\/|www\./i); // no URL
    expect(text).not.toMatch(/\+?\d[\d\s().-]{7,}\d/); // no phone number
    expect(text).not.toMatch(/\battach(ed|ment)\b.*\.(pdf|docx?|xlsx?)\b/i); // no attachment reference
    expect(text).not.toMatch(DENYLIST);
    expect(text).not.toMatch(BASE_KEYS); // never touches Falcon or Cobra
    expect(Number.isNaN(Date.parse(m.date))).toBe(false);
    expect(m.labels).toBeUndefined();
  });

  it('has unique Message-IDs, none shared with the base fixture', () => {
    const ids = corpus.messages.map((m) => m.messageId);
    expect(new Set(ids).size).toBe(ids.length);
    const baseIds = new Set(loadFixtureMailboxes(fixtureCapability).flatMap((b) => b.messages.map((m) => m.internetMessageId)));
    expect(ids.filter((id) => baseIds.has(id))).toEqual([]);
  });

  it('carries the narrative the demo beats need', () => {
    const count = (prefix: string) => corpus.messages.filter((m) => m.messageId.startsWith(`<${prefix}-`)).length;
    expect(count('kestrel')).toBe(18);
    expect(count('harbor')).toBe(3);
    expect(count('osprey')).toBe(8);
    expect(count('bidq')).toBe(3);
    expect(count('noise')).toBe(6);
    expect(corpus.messages.filter((m) => m.phase === 'after-imports').map((m) => m.messageId)).toEqual([
      '<kestrel-017@bank.example>',
      '<kestrel-018@aldermoor.example>',
    ]);
  });

  it('keeps every reference resolvable and the triage reply detached', () => {
    const ids = new Set(corpus.messages.map((m) => m.messageId));
    for (const m of corpus.messages) {
      if (m.inReplyTo) expect(ids.has(m.inReplyTo), m.messageId).toBe(true);
      for (const r of m.references ?? []) expect(ids.has(r), m.messageId).toBe(true);
    }
    const triage = corpus.messages.find((m) => m.messageId === '<bidq-003@castellan.example>')!;
    expect(triage.references).toBeUndefined();
    expect(triage.inReplyTo).toBe('<bidq-002@castellan.example>');
  });

  it('never spells a deal codename in mail that must not route to that deal', () => {
    const KEYS = /\b(Kestrel|Harbor|Osprey)\b/;
    const unrouted = ['<bidq-003@castellan.example>', ...corpus.messages.filter((m) => m.messageId.startsWith('<noise-')).map((m) => m.messageId)];
    for (const id of unrouted) {
      const m = corpus.messages.find((x) => x.messageId === id)!;
      expect(`${m.subject}\n${m.body.content}`, id).not.toMatch(KEYS);
    }
    for (const m of corpus.messages.filter((x) => x.messageId.startsWith('<harbor-'))) {
      expect(`${m.subject}\n${m.body.content}`, m.messageId).not.toMatch(/\b(Kestrel|Osprey)\b/);
    }
  });
});

describe('the corpus reader', () => {
  it('accepts the committed corpus', () => {
    expect(parseCorpus(readFileSync(CORPUS_PATH, 'utf8')).messages).toHaveLength(corpus.messages.length);
  });

  it('throws on the first bad field', () => {
    const bad = JSON.stringify({
      format: 'conductia.mail-corpus/v1',
      messages: [{ ...corpus.messages[0], mailboxes: ['someone.else@bank.example'] }],
    });
    expect(() => parseCorpus(bad)).toThrow(/messages\[0\]\.mailboxes/);
    expect(() => parseCorpus(JSON.stringify({ format: 'nope', messages: [] }))).toThrow(/format/);
  });
});
