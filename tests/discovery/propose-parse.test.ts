// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { PROPOSAL_MODEL } from '@/lib/discovery/propose/model';
import { parseProposalReply } from '@/lib/discovery/propose/parse';
import { PROMPT_HASH, PROMPT_VERSION } from '@/lib/modelGateway/prompts/dealProposal.v2';
import { loadRecording, recordedTransport } from '@/lib/modelGateway/record';
import { SYNTHETIC_CORPUS_DIGEST } from '@/lib/modelGateway/syntheticCorpus.generated';

import { PROPOSE_REPLY_TABLE } from '../helpers/proposeReplyTable';
import { buildProposeStub, PROPOSE_STUB_PATH, proposableItems, serializeProposeStub } from '../helpers/proposeStubReplies';
import { STUB_PATH } from '../helpers/stubReplies';

const KESTREL = { ref: 'c:00000000-0000-4000-8000-0000000000aa', name: 'Project Kestrel' };
const CANDIDATES = [KESTREL, { ref: 'm:harbor', name: 'Project Harbor' }];

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ deal_related: true, p_deal: 0.9, deal: { ref: KESTREL.ref }, phase: 'phase-4', p_phase: 0.7, ...over });

describe('parseProposalReply', () => {
  it('reads a deal answer that names a listed candidate', () => {
    expect(parseProposalReply(reply(), CANDIDATES)).toEqual({
      ok: true,
      reply: { deal_related: true, p_deal: 0.9, deal: { ref: KESTREL.ref }, phase: 'phase-4', p_phase: 0.7 },
    });
  });

  it('reads a new deal name, trimmed, inside a fenced block', () => {
    const text = '```json\n' + reply({ deal: { new_name: '  Project Osprey ' } }) + '\n```';
    expect(parseProposalReply(text, CANDIDATES)).toMatchObject({ ok: true, reply: { deal: { new_name: 'Project Osprey' } } });
  });

  it('reads a "no", and drops any deal or phase it gives', () => {
    expect(parseProposalReply(reply({ deal_related: false, p_deal: 0.05, deal: null, phase: null, p_phase: 0 }), [])).toEqual({
      ok: true,
      reply: { deal_related: false, p_deal: 0.05, deal: null, phase: null, p_phase: 0 },
    });
    expect(parseProposalReply(reply({ deal_related: false, deal: { new_name: 'Stray' } }), [])).toMatchObject({
      ok: true,
      reply: { deal: null, phase: null },
    });
  });

  it.each([
    ['not JSON', 'I think this is about Kestrel.'],
    ['two objects', `${reply()}\n${reply()}`],
    ['an array', '[true, 0.9, null, null, 0]'],
    ['an array of two objects', `[${reply()}, ${reply()}]`],
    ['deal_related not a boolean', reply({ deal_related: 'yes' })],
    ['p_deal missing', JSON.stringify({ deal_related: true, deal: { ref: KESTREL.ref }, phase: 'phase-4', p_phase: 0.7 })],
    ['p_deal above 1', reply({ p_deal: 1.2 })],
    ['p_phase not a number', reply({ p_phase: 'high' })],
    ['a ref not in the candidates', reply({ deal: { ref: 'c:00000000-0000-4000-8000-0000000000bb' } })],
    ['a ref when no candidates were listed', reply()],
    ['a ref and a new name together', reply({ deal: { ref: KESTREL.ref, new_name: 'Kestrel' } })],
    ['a deal of another shape', reply({ deal: 'Project Kestrel' })],
    ['an empty new name', reply({ deal: { new_name: '   ' } })],
    ['a new name over 80 characters', reply({ deal: { new_name: 'x'.repeat(81) } })],
    ['a phase outside the rail', reply({ phase: 'phase-6' })],
    ['a bake-off stage name instead of a phase', reply({ phase: 'marketing' })],
    ['deal_related without a deal', reply({ deal: null })],
    ['deal_related without a phase', reply({ phase: null })],
  ])('is invalid for %s', (label, text) => {
    const candidates = label === 'a ref when no candidates were listed' ? [] : CANDIDATES;
    expect(parseProposalReply(text, candidates)).toEqual({ ok: false, code: 'invalid' });
  });

  it('accepts a new name of exactly 80 characters', () => {
    expect(parseProposalReply(reply({ deal: { new_name: 'x'.repeat(80) } }), [])).toMatchObject({ ok: true });
  });
});

describe('the deal proposal stub replies (offline stand-in, not a recording)', () => {
  const root = process.cwd();

  it('is committed at its own path, current with the corpus and the double, and says what it is', () => {
    expect(existsSync(join(root, PROPOSE_STUB_PATH)), `${PROPOSE_STUB_PATH} is missing`).toBe(true);
    expect(readFileSync(join(root, PROPOSE_STUB_PATH), 'utf8')).toBe(serializeProposeStub(buildProposeStub(root)));
    const file = loadRecording(join(root, PROPOSE_STUB_PATH));
    expect(file).toMatchObject({
      purpose: 'deal_proposal',
      promptVersion: PROMPT_VERSION,
      promptHash: PROMPT_HASH,
      model: PROPOSAL_MODEL,
      provider: 'stub',
      corpusDigest: SYNTHETIC_CORPUS_DIGEST,
    });
    expect(file.provenance).toMatch(/^STUB, not a model recording/);
    expect(PROPOSE_STUB_PATH).not.toBe(STUB_PATH);
  });

  it('answers every demo message the firm rules can leave unrouted, and only those', () => {
    const file = loadRecording(join(root, PROPOSE_STUB_PATH));
    const items = proposableItems(root);
    expect(items.length).toBeGreaterThan(0);
    expect(Object.keys(file.replies).sort()).toEqual(items.map((e) => e.item.contentHash).sort());
    expect(Object.keys(PROPOSE_REPLY_TABLE).sort()).toEqual(items.map((e) => e.item.internetMessageId).sort());
  });

  it('holds replies that parse, with at least one deal and one "no"', () => {
    const file = loadRecording(join(root, PROPOSE_STUB_PATH));
    const parsed = Object.values(file.replies).map((r) => parseProposalReply(r.text, []));
    expect(parsed.every((p) => p.ok)).toBe(true);
    const answers = parsed.flatMap((p) => (p.ok ? [p.reply.deal_related] : []));
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  it('replays through the recorded transport for a deal_proposal request only', async () => {
    const file = loadRecording(join(root, PROPOSE_STUB_PATH));
    const { item } = proposableItems(root)[0];
    const input = { subject: item.subject, sentAt: item.sentAt, body: item.bodyText, domains: [], candidates: [] };
    const hit = await recordedTransport(file).send({
      purpose: 'deal_proposal',
      promptVersion: 'v2',
      model: PROPOSAL_MODEL,
      tenantId: DEV_TENANT_ID,
      contentHash: item.contentHash,
      input,
    });
    expect(hit).toMatchObject({ ok: true, usage: null, transport: 'recorded' });
    const miss = await recordedTransport(file).send({
      purpose: 'milestone_extract',
      promptVersion: 'v1',
      model: PROPOSAL_MODEL,
      tenantId: DEV_TENANT_ID,
      sourceItemId: item.internetMessageId,
      contentHash: item.contentHash,
      input: { subject: item.subject, sentAt: item.sentAt, body: item.bodyText },
    });
    expect(miss).toMatchObject({ ok: false, code: 'recording_miss' });
  });
});
