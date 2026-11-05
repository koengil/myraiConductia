import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import type { MailMessage } from '@/lib/discovery/source/types';
import { dedupeObservations, normalizeDocument, normalizeMessage, type DedupedItem } from '@/lib/discovery/normalize';
import { messageKey } from '@/lib/discovery/propose/key';
import { PROPOSAL_MODEL } from '@/lib/discovery/propose/model';
import type { ProposalReply } from '@/lib/discovery/propose/parse';
import { SourcePasses, type BeginResult } from '@/lib/discovery/propose/passes';
import {
  emptyStreak,
  MAX_ATTEMPTS,
  MAX_CONSECUTIVE_FAILURES,
  proposeDeals,
  RETRY_DELAYS_MS,
  type ProposeContext,
} from '@/lib/discovery/propose/run';
import { routeByFirmRules, type RoutedItem } from '@/lib/discovery/route/firmRules';
import { PROMPT_HASH, PROMPT_VERSION } from '@/lib/modelGateway/prompts/dealProposal.v2';
import { loadRecording, recordedTransport } from '@/lib/modelGateway/record';
import { ZDR_RETRY_DELAYS_MS } from '@/lib/modelGateway/gatewayClient';
import type { ModelTransport } from '@/lib/modelGateway/transports';

import { memoryProposalStore, passesFor } from '../helpers/memoryProposalStore';
import { PROPOSE_REPLY_TABLE } from '../helpers/proposeReplyTable';
import { proposeReplyDouble } from '../helpers/proposeReplyDouble';
import { DEMO_LATE_DIR, demoItems } from './demoCorpus';

const RUN = '0b9a1c3e-5d7f-4a2b-8c4d-6e8f0a1b2c3d';
const SOURCE = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_SOURCE = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const KESTREL_ID = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';
const STUB = join(process.cwd(), 'tests/fixtures/discovery/demo/model-replies/propose.v2.stub.json');
const SYNTHETIC_ENV = {
  DISCOVERY_PROPOSE_TRANSPORT: 'gateway',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55521',
  NEXT_PUBLIC_APP_ENV: 'local',
};
const HAIKU_USAGE = { model: 'anthropic/claude-haiku-5.5', inputTokens: 2000, outputTokens: 100 };
const DEAL: ProposalReply = { deal_related: true, p_deal: 0.9, deal: { new_name: 'Project Heron' }, phase: 'phase-2', p_phase: 0.6 };
const NOT_DEAL: ProposalReply = { deal_related: false, p_deal: 0.1, deal: null, phase: null, p_phase: 0 };

/** The demo corpus as the worker routes it: real normalizeMessage output, unrouted entries only. */
const unroutedDemo = (): RoutedItem[] => routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' }).filter((r) => r.routes.length === 0);

const ctx = (transport: ModelTransport, store: ProposeContext['store'], over: Partial<ProposeContext> = {}): ProposeContext => ({
  tenantId: DEV_TENANT_ID,
  runId: RUN,
  sourceId: SOURCE,
  sources: passesFor(DEV_TENANT_ID, store),
  gate: { flagOn: true, env: {} },
  transport,
  store,
  sleep: async () => {},
  ...over,
});

let seq = 0;
/** A message read from a mailbox: a Graph-shaped message through the real normalizer. */
function message(over: Partial<MailMessage> & { internetMessageId: string }): MailMessage {
  seq++;
  return {
    id: `AAMk-test-${seq}`,
    conversationId: `conv-test-${seq}`,
    subject: 'Quick question on the numbers',
    sentDateTime: '2026-03-02T10:00:00Z',
    from: { emailAddress: { name: 'Dana Fox', address: 'dana.fox@harbourline.example' } },
    toRecipients: [{ emailAddress: { name: 'Alex Chen', address: 'alex.chen@bank.example' } }],
    ccRecipients: [],
    body: { contentType: 'text', content: 'Can you send the updated model before Thursday?' },
    ...over,
  } as MailMessage;
}

const sighted = (msg: MailMessage, sourceId = SOURCE) => ({ sourceId, providerItemId: msg.id, item: normalizeMessage(msg) });
const route = (items: DedupedItem[]) => routeByFirmRules(items, { scope: 'unscoped' });

describe('proposeDeals over the demo corpus, offline (recorded stub)', () => {
  it('answers every unrouted message once, and only the deal answers carry a deal and a phase', async () => {
    const entries = unroutedDemo();
    expect(entries.length).toBeGreaterThan(0);
    const m = memoryProposalStore();
    const tally = await proposeDeals(entries, ctx(recordedTransport(loadRecording(STUB)), m.store));

    expect(tally).toMatchObject({ called: entries.length, failed: 0, invalid: 0, skippedNotSynthetic: 0, costUsd: 0 });
    expect(tally.deal + tally.notDeal).toBe(entries.length);
    const rows = m.rows();
    expect(rows).toHaveLength(entries.length);
    for (const entry of entries) {
      const row = rows.find((r) => r.messageKey === messageKey(entry.item.internetMessageId))!;
      const want = PROPOSE_REPLY_TABLE[entry.item.internetMessageId];
      expect(row.outcome, entry.item.internetMessageId).toBe(want.deal_related ? 'deal' : 'not_deal');
      expect(row).toMatchObject({ itemHash: entry.item.contentHash, model: PROPOSAL_MODEL, promptVersion: PROMPT_VERSION, promptHash: PROMPT_HASH, runId: RUN, contentSourceId: SOURCE });
    }
    // The buyer's bid follow-up the codename rule misses is the demo's model-found deal mail.
    const kestrel = rows.find((r) => r.messageKey === messageKey('<bidq-003@castellan.example>'))!;
    expect(kestrel).toMatchObject({ outcome: 'deal', dealKey: 'm:project-kestrel', dealName: 'Project Kestrel', phase: 'phase-3', candidateId: null });
    expect(tally.newNames).toBe(1);
    for (const row of rows.filter((r) => r.outcome !== 'deal')) {
      expect(row).toMatchObject({ dealKey: null, dealName: null, phase: null, candidateId: null });
    }
    expect(m.usage).toEqual([]); // a replay writes no usage
  });

  it('stores no text: no subject, body, address or display name reaches a row', async () => {
    const entries = unroutedDemo();
    const m = memoryProposalStore();
    await proposeDeals(entries, ctx(recordedTransport(loadRecording(STUB)), m.store));
    const dump = JSON.stringify(m.rows());
    expect(dump).not.toContain('@');
    for (const { item } of entries) {
      expect(dump).not.toContain(item.internetMessageId);
      if (item.subject) expect(dump, item.subject).not.toContain(item.subject);
      for (const line of item.bodyText.split('\n').filter((l) => l.trim().length > 12)) expect(dump).not.toContain(line.trim());
      for (const p of item.participants) if (p.name) expect(dump).not.toContain(p.name);
    }
    expect(m.rows().every((r) => r.partyDomains.every((d) => /^[a-z0-9.-]+$/.test(d)))).toBe(true);
  });

  it('names a listed candidate by its ref, so the rules-found deal and the model-found mail meet', async () => {
    const m = memoryProposalStore({ candidates: [{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel', candidateId: KESTREL_ID }] });
    const transport = recordedTransport(loadRecording(STUB));
    const tally = await proposeDeals(unroutedDemo(), ctx(transport, m.store));
    const kestrel = m.rows().find((r) => r.messageKey === messageKey('<bidq-003@castellan.example>'))!;
    expect(kestrel).toMatchObject({ dealKey: `c:${KESTREL_ID}`, dealName: 'Project Kestrel', candidateId: KESTREL_ID });
    expect(tally.newNames).toBe(0);
  });

  it('skips settled messages on a rerun, by message key', async () => {
    const m = memoryProposalStore();
    const entries = unroutedDemo();
    await proposeDeals(entries, ctx(recordedTransport(loadRecording(STUB)), m.store));
    const again = proposeReplyDouble(() => NOT_DEAL);
    const tally = await proposeDeals(entries, ctx(again, m.store));
    expect(again.sent).toEqual([]);
    expect(tally.called).toBe(0);
    expect(m.rows().every((r) => r.writes === 1)).toBe(true);
  });
});

describe('proposeDeals: one row per message', () => {
  it('gives two distinct messages with identical subject and body two rows', async () => {
    const a = message({ internetMessageId: '<twin-a@harbourline.example>' });
    const b = message({ internetMessageId: '<twin-b@harbourline.example>' });
    const { items } = dedupeObservations([sighted(a), sighted(b)]);
    expect(items).toHaveLength(2);
    expect(items[0].item.contentHash).toBe(items[1].item.contentHash);
    const m = memoryProposalStore();
    const transport = proposeReplyDouble(() => DEAL);
    const tally = await proposeDeals(route(items), ctx(transport, m.store));
    expect(tally).toMatchObject({ called: 2, deal: 2, newNames: 1 });
    expect(m.rows()).toHaveLength(2);
    expect(new Set(m.rows().map((r) => r.messageKey)).size).toBe(2);
    expect(new Set(m.rows().map((r) => r.dealKey))).toEqual(new Set(['m:project-heron']));
  });

  it('gives one message read from two mailboxes one row per mailbox, so each owner has their own answer (review M3)', async () => {
    const msg = message({ internetMessageId: '<shared-1@harbourline.example>' });
    const { items } = dedupeObservations([sighted(msg, SOURCE), sighted(msg, OTHER_SOURCE)]);
    expect(items).toHaveLength(1);
    const m = memoryProposalStore();
    const transport = proposeReplyDouble(() => DEAL);
    await proposeDeals(route(items), ctx(transport, m.store));
    await proposeDeals(route(items), ctx(transport, m.store, { sourceId: OTHER_SOURCE }));
    expect(transport.sent).toHaveLength(2);
    expect(m.rows().map((r) => r.contentSourceId).sort()).toEqual([SOURCE, OTHER_SOURCE].sort());
    // A rerun on either mailbox asks nothing again: each source's answer is settled.
    await proposeDeals(route(items), ctx(transport, m.store, { sourceId: OTHER_SOURCE }));
    await proposeDeals(route(items), ctx(transport, m.store));
    expect(transport.sent).toHaveLength(2);
    expect(m.rows().every((r) => r.writes === 1)).toBe(true);
  });

  it('asks once for one message that appears twice in the entries handed in', async () => {
    const msg = message({ internetMessageId: '<dup-1@harbourline.example>' });
    const entry = route(dedupeObservations([sighted(msg)]).items)[0];
    const m = memoryProposalStore();
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals([entry, entry], ctx(transport, m.store));
    expect(transport.sent).toHaveLength(1);
  });
});

describe('proposeDeals: what is sent', () => {
  it('sends a message (no kind) and never a document', async () => {
    const msg = message({ internetMessageId: '<msg-1@harbourline.example>' });
    const doc = normalizeDocument({
      driveItemKey: 'drive-1:item-1',
      providerItemId: 'item-1',
      name: 'Board pack draft.docx',
      drivePath: '/Shared/Board pack draft.docx',
      lastModifiedDateTime: '2026-03-01T00:00:00Z',
      authors: [{ address: 'dana.fox@harbourline.example', name: 'Dana Fox' }],
      text: 'Draft board pack for the March meeting.',
      cTag: null,
    });
    expect(normalizeMessage(msg).kind).toBeUndefined();
    expect(doc.kind).toBe('document');
    const entries = route(
      dedupeObservations([sighted(msg), { sourceId: SOURCE, providerItemId: 'item-1', item: doc }]).items,
    );
    expect(entries.every((e) => e.routes.length === 0)).toBe(true);
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const tally = await proposeDeals(entries, ctx(transport, memoryProposalStore().store));
    expect(tally.called).toBe(1);
    expect(transport.sent.map((s) => s.contentHash)).toEqual([normalizeMessage(msg).contentHash]);
  });

  it('never sends a routed entry', async () => {
    const routed = routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' }).filter((r) => r.routes.length > 0);
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const tally = await proposeDeals(routed, ctx(transport, memoryProposalStore().store));
    expect(tally.called).toBe(0);
    expect(transport.sent).toEqual([]);
  });

  it('sends participant domains, never an address or a display name, with the full body for the prompt to cut', async () => {
    const body = `${'The vendor DD report is ready. '.repeat(400)}End.`;
    const msg = message({ internetMessageId: '<long-1@harbourline.example>', body: { contentType: 'text', content: body } });
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(route(dedupeObservations([sighted(msg)]).items), ctx(transport, memoryProposalStore().store));
    const [{ input }] = transport.sent;
    expect(input.domains).toEqual(['bank.example', 'harbourline.example']);
    expect(JSON.stringify(input.domains)).not.toContain('@');
    expect(input.body.length).toBeGreaterThan(8000);
  });

  it('on the synthetic path sends only committed corpus mail', async () => {
    const outside = message({ internetMessageId: '<not-in-corpus@harbourline.example>' });
    const entries = [...unroutedDemo(), ...route(dedupeObservations([sighted(outside)]).items)];
    const m = memoryProposalStore();
    const transport = proposeReplyDouble(() => NOT_DEAL, { kind: 'gateway' });
    const tally = await proposeDeals(entries, ctx(transport, m.store, { gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    expect(tally.skippedNotSynthetic).toBe(1);
    expect(tally.called).toBe(entries.length - 1);
    expect(transport.sent.map((s) => s.contentHash)).not.toContain(normalizeMessage(outside).contentHash);
    expect(m.rows().map((r) => r.messageKey)).not.toContain(messageKey('<not-in-corpus@harbourline.example>'));
  });
});

describe('proposeDeals: settle, retry and usage', () => {
  const one = () => route(dedupeObservations([sighted(message({ internetMessageId: `<retry-${++seq}@harbourline.example>` }))]).items);

  it(`retries a transport failure up to ${MAX_ATTEMPTS} times within the run, writes nothing, and asks again next run`, async () => {
    const entries = one();
    const m = memoryProposalStore();
    const failing = proposeReplyDouble(() => DEAL, { alwaysFail: true });
    const tally = await proposeDeals(entries, ctx(failing, m.store));
    expect(failing.sent).toHaveLength(MAX_ATTEMPTS);
    expect(tally).toMatchObject({ called: 1, failed: 1, deal: 0 });
    expect(m.rows()).toEqual([]);

    const healthy = proposeReplyDouble(() => DEAL);
    const next = await proposeDeals(entries, ctx(healthy, m.store));
    expect(next).toMatchObject({ called: 1, failed: 0, deal: 1 });
    expect(m.rows()).toHaveLength(1);
  });

  it('settles on the second attempt after one failure', async () => {
    const entries = one();
    const m = memoryProposalStore();
    const flaky = proposeReplyDouble(() => DEAL, { failFirstFor: new Set([entries[0].item.contentHash]) });
    const tally = await proposeDeals(entries, ctx(flaky, m.store));
    expect(flaky.sent).toHaveLength(2);
    expect(tally).toMatchObject({ failed: 0, deal: 1 });
  });

  it('settles an unparseable reply as invalid, with no deal, and never asks again', async () => {
    const entries = one();
    const m = memoryProposalStore();
    const tally = await proposeDeals(entries, ctx(proposeReplyDouble(() => 'not json at all'), m.store));
    expect(tally).toMatchObject({ invalid: 1, deal: 0 });
    expect(m.rows()[0]).toMatchObject({ outcome: 'invalid', dealKey: null, dealName: null, phase: null, pDeal: null });
    const again = proposeReplyDouble(() => DEAL);
    await proposeDeals(entries, ctx(again, m.store));
    expect(again.sent).toEqual([]);
  });

  it('settles a ref that names no supplied candidate as invalid', async () => {
    const entries = one();
    const m = memoryProposalStore({ candidates: [{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel', candidateId: KESTREL_ID }] });
    const stray = { ...DEAL, deal: { ref: 'c:00000000-0000-4000-8000-00000000dead' } };
    const tally = await proposeDeals(entries, ctx(proposeReplyDouble(() => stray), m.store));
    expect(tally.invalid).toBe(1);
    expect(m.rows()[0].outcome).toBe('invalid');

    const listed = memoryProposalStore({ candidates: [{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel', candidateId: KESTREL_ID }] });
    const transport = proposeReplyDouble((input) => ({ ...DEAL, deal: { ref: input.candidates[0].ref } }));
    await proposeDeals(entries, ctx(transport, listed.store));
    expect(transport.sent[0].input.candidates).toEqual([{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel' }]);
    expect(listed.rows()[0]).toMatchObject({ outcome: 'deal', dealKey: `c:${KESTREL_ID}`, candidateId: KESTREL_ID });
  });

  it('offers a deal the model named earlier on the page to later messages, and counts it as new once', async () => {
    const entries = route(
      dedupeObservations([
        sighted(message({ internetMessageId: '<heron-1@harbourline.example>', subject: 'one' })),
        sighted(message({ internetMessageId: '<heron-2@harbourline.example>', subject: 'two' })),
      ]).items,
    );
    const transport = proposeReplyDouble(() => DEAL);
    const tally = await proposeDeals(entries, ctx(transport, memoryProposalStore().store));
    expect(transport.sent[0].input.candidates).toEqual([]);
    expect(transport.sent[1].input.candidates).toEqual([{ ref: 'm:project-heron', name: 'Project Heron' }]);
    expect(tally).toMatchObject({ deal: 2, newNames: 1 });
  });

  it('writes usage for a live gateway call only, priced from tokens', async () => {
    const m = memoryProposalStore();
    const live = proposeReplyDouble(() => DEAL, { kind: 'gateway', usage: HAIKU_USAGE });
    const tally = await proposeDeals(unroutedDemo().slice(0, 2), ctx(live, m.store, { gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    expect(m.usage).toEqual([
      { externalId: 'msg_propose_double_1', model: HAIKU_USAGE.model, usage: HAIKU_USAGE },
      { externalId: 'msg_propose_double_2', model: HAIKU_USAGE.model, usage: HAIKU_USAGE },
    ]);
    // 2000 in at $0.10 and 100 out at $0.50 per MTok, twice.
    expect(tally.costUsd).toBeCloseTo(2 * (2000 * 0.1 + 100 * 0.5) / 1_000_000, 9);

    const replay = memoryProposalStore();
    await proposeDeals(unroutedDemo().slice(0, 2), ctx(proposeReplyDouble(() => DEAL, { usage: HAIKU_USAGE }), replay.store));
    expect(replay.usage).toEqual([]);
  });

  it('writes a priced row for a billed failure the retry replaces, and one for the success (#645)', async () => {
    const entries = unroutedDemo().slice(0, 1);
    const m = memoryProposalStore();
    const live = proposeReplyDouble(() => DEAL, {
      kind: 'gateway',
      usage: HAIKU_USAGE,
      billedFailFirstFor: new Set([entries[0].item.contentHash]),
    });
    const tally = await proposeDeals(entries, ctx(live, m.store, { gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    expect(live.sent).toHaveLength(2);
    expect(tally).toMatchObject({ called: 1, failed: 0, deal: 1 });
    expect(m.usage.map((u) => u.externalId)).toEqual(['msg_propose_double_1', 'msg_propose_double_2']);
    expect(m.usage.every((u) => u.usage !== null)).toBe(true);
    // Both attempts were billed: the tally is the sum of the two priced rows.
    expect(tally.costUsd).toBeCloseTo(2 * (2000 * 0.1 + 100 * 0.5) / 1_000_000, 9);
  });

  it('writes one row when a no-provider ZDR refusal clears on the retry: the refusal was not billed (#645, D106)', async () => {
    const entries = unroutedDemo().slice(0, 1);
    const replies = proposeReplyDouble(() => DEAL, { kind: 'gateway', usage: HAIKU_USAGE });
    let refusals = 1;
    const blip: ModelTransport = {
      kind: 'gateway',
      async send(req) {
        if (refusals-- > 0) return { ok: false, outcome: 'failed', code: 'zdr_unavailable', zdrReason: 'no_providers_available', transport: 'gateway', latencyMs: 0 };
        return replies.send(req);
      },
    };
    const m = memoryProposalStore();
    const tally = await proposeDeals(entries, ctx(blip, m.store, { gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    expect(tally).toMatchObject({ called: 1, failed: 0, deal: 1 });
    expect(m.usage).toHaveLength(1);
    expect(tally.costUsd).toBeCloseTo((2000 * 0.1 + 100 * 0.5) / 1_000_000, 9);
  });

  it('writes no row for a recorded replay, even one marked billed (D72, D91)', async () => {
    const entries = unroutedDemo().slice(0, 1);
    const m = memoryProposalStore();
    const replay = proposeReplyDouble(() => DEAL, { usage: HAIKU_USAGE, billedFailFirstFor: new Set([entries[0].item.contentHash]) });
    const tally = await proposeDeals(entries, ctx(replay, m.store));
    expect(replay.sent).toHaveLength(2);
    expect(tally).toMatchObject({ called: 1, deal: 1, costUsd: 0 });
    expect(m.usage).toEqual([]);
  });

  it('keys each reply without an id on its own local: id, so two are two rows (#645)', async () => {
    const m = memoryProposalStore();
    const live = proposeReplyDouble(() => DEAL, { kind: 'gateway', usage: HAIKU_USAGE, responseId: '' });
    await proposeDeals(unroutedDemo().slice(0, 2), ctx(live, m.store, { gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    const ids = m.usage.map((u) => u.externalId);
    expect(ids).toHaveLength(2);
    expect(ids.every((id) => id.startsWith('local:'))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('writes an unpriced row under the requested model for a reply without usage, and adds no cost (#645)', async () => {
    const m = memoryProposalStore();
    const live = proposeReplyDouble(() => DEAL, { kind: 'gateway' });
    const tally = await proposeDeals(unroutedDemo().slice(0, 1), ctx(live, m.store, { gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    expect(tally).toMatchObject({ called: 1, deal: 1, costUsd: 0 });
    expect(m.usage).toEqual([{ externalId: 'msg_propose_double_1', model: PROPOSAL_MODEL, usage: null }]);
  });

  it('stops the step when the ledger refuses a bill: the message is failed and unsaved, and nothing after it is asked (#645)', async () => {
    const entries = unroutedDemo().slice(0, 2);
    const m = memoryProposalStore({ failLedger: true });
    const live = proposeReplyDouble(() => DEAL, { kind: 'gateway', usage: HAIKU_USAGE });
    const streak = emptyStreak();
    const gate = { flagOn: true, env: SYNTHETIC_ENV };
    // It resolves with the tally, so the sync and the tenant pass carry on.
    const tally = await proposeDeals(entries, ctx(live, m.store, { streak, gate }));
    expect(live.sent).toHaveLength(1);
    expect(tally).toMatchObject({ called: 1, failed: 1, deal: 0, costUsd: 0 });
    expect(streak).toEqual({ consecutive: 0, stopped: true, stoppedBy: 'ledger' });
    expect(m.rows()).toEqual([]);

    // A later page of the run returns at once, though the first message is still unsettled.
    const next = await proposeDeals(entries, ctx(live, m.store, { streak, gate }));
    expect(next).toMatchObject({ called: 0, failed: 0 });
    expect(live.sent).toHaveLength(1);
  });

  it('stops cleanly when the ledger takes the billed failure and refuses the retry: one row, the answer unsaved (#645)', async () => {
    const entries = unroutedDemo().slice(0, 2);
    const m = memoryProposalStore({ ledgerTakes: 1 });
    const live = proposeReplyDouble(() => DEAL, {
      kind: 'gateway',
      usage: HAIKU_USAGE,
      billedFailFirstFor: new Set([entries[0].item.contentHash]),
    });
    const streak = emptyStreak();
    const tally = await proposeDeals(entries, ctx(live, m.store, { streak, gate: { flagOn: true, env: SYNTHETIC_ENV } }));
    // Attempt 1 is on the ledger and in the cost; attempt 2's row was refused, so the step stops there.
    expect(live.sent).toHaveLength(2);
    expect(m.usage.map((u) => u.externalId)).toEqual(['msg_propose_double_1']);
    expect(tally).toMatchObject({ called: 1, failed: 1, deal: 0 });
    expect(tally.costUsd).toBeCloseTo((2000 * 0.1 + 100 * 0.5) / 1_000_000, 9);
    expect(streak).toEqual({ consecutive: 0, stopped: true, stoppedBy: 'ledger' });
    expect(m.rows()).toEqual([]);
  });
});

describe('proposeDeals: bounds, failures and the firm\'s own domains (#460 audit A2 to A4)', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ emailAddress: { name: `P ${i}`, address: `p@party-${i}.example` } }));

  it('caps party domains at 100 and a deal name at 80, so the table takes the row', async () => {
    const msg = message({ internetMessageId: `<wide-${++seq}@harbourline.example>`, toRecipients: many(140) });
    const m = memoryProposalStore({ candidates: [{ ref: `c:${KESTREL_ID}`, name: `Project ${'K'.repeat(120)}`, candidateId: KESTREL_ID }] });
    const reply: ProposalReply = { ...DEAL, deal: { ref: `c:${KESTREL_ID}` } };
    const tally = await proposeDeals(route(dedupeObservations([sighted(msg)]).items), ctx(proposeReplyDouble(() => reply), m.store));
    expect(tally).toMatchObject({ deal: 1, failed: 0 });
    const [row] = m.rows();
    expect(row.partyDomains).toHaveLength(100);
    expect(row.dealName!.length).toBe(80);
  });

  it('counts a row the store refuses as failed and carries on with the next message', async () => {
    const first = message({ internetMessageId: `<refused-${++seq}@harbourline.example>` });
    const second = message({ internetMessageId: `<kept-${++seq}@harbourline.example>`, subject: 'Another note' });
    const refusedKey = messageKey(first.internetMessageId!);
    const m = memoryProposalStore({ refuseSave: (row) => row.messageKey === refusedKey });
    const entries = route(dedupeObservations([sighted(first), sighted(second)]).items);
    const tally = await proposeDeals(entries, ctx(proposeReplyDouble(() => NOT_DEAL), m.store));
    expect(tally).toMatchObject({ called: 2, failed: 1, notDeal: 1 });
    expect(m.rows().map((r) => r.messageKey)).toEqual([messageKey(second.internetMessageId!)]);
  });

  it('drops the firm\'s own domains from the parties, so a message with no outside party has none', async () => {
    const inside = message({
      internetMessageId: `<inside-${++seq}@bank.example>`,
      from: { emailAddress: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' } },
    });
    const outside = message({ internetMessageId: `<outside-${++seq}@harbourline.example>`, subject: 'From the buyer' });
    const m = memoryProposalStore();
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(
      route(dedupeObservations([sighted(inside), sighted(outside)]).items),
      ctx(transport, m.store, { internalDomains: new Set(['BANK.example']) }),
    );
    expect(transport.sent.map((s) => s.input.domains)).toEqual([[], ['harbourline.example']]);
    expect(m.rows().map((r) => r.partyDomains)).toEqual([[], ['harbourline.example']]);
  });

  it('waits about 2s, then 8s, between retries', async () => {
    const waits: number[] = [];
    const entries = route(dedupeObservations([sighted(message({ internetMessageId: `<wait-${++seq}@harbourline.example>` }))]).items);
    await proposeDeals(
      entries,
      ctx(proposeReplyDouble(() => DEAL, { alwaysFail: true }), memoryProposalStore().store, { sleep: async (ms) => void waits.push(ms) }),
    );
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    expect(waits).toEqual([2_000, 8_000]);
  });

  it.each([
    ['a plan without ZDR (403), at once', 'permission_denied', 1, []],
    ['no ZDR provider (400), once it outlasts its retries', 'no_providers_available', 3, [...ZDR_RETRY_DELAYS_MS]],
  ] as const)('stops the run on %s, and asks nothing after it (#462, D106)', async (_label, zdrReason, calls, delays) => {
    const entries = route(
      dedupeObservations(
        Array.from({ length: 3 }, (_, i) => sighted(message({ internetMessageId: `<zdr-${++seq}-${i}@harbourline.example>`, subject: `Zdr ${seq}` }))),
      ).items,
    );
    const sent: string[] = [];
    const refusing: ModelTransport = {
      kind: 'recorded',
      async send(req) {
        sent.push(req.contentHash);
        return { ok: false, outcome: 'failed', code: 'zdr_unavailable', zdrReason, transport: 'recorded', latencyMs: 0 };
      },
    };
    const waits: number[] = [];
    const streak = emptyStreak();
    const m = memoryProposalStore();
    const tally = await proposeDeals(entries, ctx(refusing, m.store, { streak, sleep: async (ms) => void waits.push(ms) }));
    expect(sent).toHaveLength(calls);
    expect(waits).toEqual(delays);
    expect(tally).toMatchObject({ called: 1, failed: 1 });
    expect(streak).toEqual({ consecutive: 0, stopped: true, stoppedBy: 'zdr_unavailable' });
    expect(m.rows()).toEqual([]);
  });

  it('carries on when a no-provider ZDR refusal clears on the retry (#625, D106)', async () => {
    const entries = route(
      dedupeObservations(
        Array.from({ length: 2 }, (_, i) => sighted(message({ internetMessageId: `<blip-${++seq}-${i}@harbourline.example>`, subject: `Blip ${seq}` }))),
      ).items,
    );
    const replies = proposeReplyDouble(() => DEAL);
    let refusals = 1;
    const blip: ModelTransport = {
      kind: 'recorded',
      async send(req) {
        if (refusals-- > 0) return { ok: false, outcome: 'failed', code: 'zdr_unavailable', zdrReason: 'no_providers_available', transport: 'recorded', latencyMs: 0 };
        return replies.send(req);
      },
    };
    const waits: number[] = [];
    const streak = emptyStreak();
    const m = memoryProposalStore();
    const tally = await proposeDeals(entries, ctx(blip, m.store, { streak, sleep: async (ms) => void waits.push(ms) }));
    expect(waits).toEqual([ZDR_RETRY_DELAYS_MS[0]]);
    expect(tally).toMatchObject({ called: 2, failed: 0, deal: 2 });
    expect(streak).toEqual({ consecutive: 0, stopped: false });
  });

  it(`stops calling after ${MAX_CONSECUTIVE_FAILURES} failed calls in a row, across pages, and a success resets the count`, async () => {
    const page = (n: number) =>
      route(
        dedupeObservations(
          Array.from({ length: n }, (_, i) => sighted(message({ internetMessageId: `<down-${++seq}-${i}@harbourline.example>`, subject: `Note ${seq}` }))),
        ).items,
      );
    const streak = emptyStreak();
    const failing = proposeReplyDouble(() => DEAL, { alwaysFail: true });
    const m = memoryProposalStore();
    const first = await proposeDeals(page(12), ctx(failing, m.store, { streak }));
    expect(first).toMatchObject({ called: 12, failed: 12 });
    expect(streak).toEqual({ consecutive: 12, stopped: false });

    const second = await proposeDeals(page(12), ctx(failing, m.store, { streak }));
    expect(second).toMatchObject({ called: MAX_CONSECUTIVE_FAILURES - 12, failed: MAX_CONSECUTIVE_FAILURES - 12 });
    expect(streak.stopped).toBe(true);
    expect(failing.sent).toHaveLength(MAX_CONSECUTIVE_FAILURES * MAX_ATTEMPTS);

    const third = await proposeDeals(page(3), ctx(proposeReplyDouble(() => DEAL), m.store, { streak }));
    expect(third).toMatchObject({ called: 0 });

    const fresh = emptyStreak();
    fresh.consecutive = MAX_CONSECUTIVE_FAILURES - 1;
    await proposeDeals(page(1), ctx(proposeReplyDouble(() => NOT_DEAL), m.store, { streak: fresh }));
    expect(fresh).toEqual({ consecutive: 0, stopped: false });
  });
});

describe('proposeDeals: the information barrier on known deals (review M1)', () => {
  const A_SOURCE = SOURCE;
  const B_SOURCE = OTHER_SOURCE;
  const A_ONLY_ID = '4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b7c';

  it('never offers owner B a candidate only A can see, or a deal the model named in A\'s mailbox, in the prompt or the row', async () => {
    const m = memoryProposalStore({
      owners: { [A_SOURCE]: 'owner-a', [B_SOURCE]: 'owner-b' },
      candidates: [
        { ref: `c:${A_ONLY_ID}`, name: 'Project Albatross', candidateId: A_ONLY_ID, visibleTo: ['owner-a'] },
        { ref: `c:${KESTREL_ID}`, name: 'Project Kestrel', candidateId: KESTREL_ID },
      ],
    });
    // A's mailbox: the model names a new deal there.
    const aMsg = message({ internetMessageId: `<a-only-${++seq}@harbourline.example>` });
    await proposeDeals(route(dedupeObservations([sighted(aMsg, A_SOURCE)]).items), ctx(proposeReplyDouble(() => DEAL), m.store));
    expect(m.rows()).toMatchObject([{ contentSourceId: A_SOURCE, dealKey: 'm:project-heron' }]);

    // B's mailbox: the model answers with the name of A's deals, as a new name.
    const bMsg = message({ internetMessageId: `<b-mail-${++seq}@harbourline.example>`, subject: 'Albatross update' });
    const bTransport = proposeReplyDouble(() => ({ ...DEAL, deal: { new_name: 'Project Albatross' } }));
    await proposeDeals(route(dedupeObservations([sighted(bMsg, B_SOURCE)]).items), ctx(bTransport, m.store, { sourceId: B_SOURCE }));

    const offered = bTransport.sent[0].input.candidates;
    expect(offered).toEqual([{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel' }]);
    expect(JSON.stringify(offered)).not.toMatch(/Albatross|Heron/);
    // Named by B's own mail, the deal stays B's model-named deal: never linked to A's candidate.
    const bRow = m.rows().find((r) => r.contentSourceId === B_SOURCE)!;
    expect(bRow).toMatchObject({ dealKey: 'm:project-albatross', candidateId: null });

    // A, by contrast, is offered both its candidate and its own model-named deal.
    const aTransport = proposeReplyDouble(() => NOT_DEAL);
    const aMsg2 = message({ internetMessageId: `<a-next-${++seq}@harbourline.example>`, subject: 'Next' });
    await proposeDeals(route(dedupeObservations([sighted(aMsg2, A_SOURCE)]).items), ctx(aTransport, m.store));
    expect(aTransport.sent[0].input.candidates.map((c) => c.name)).toEqual(['Project Albatross', 'Project Kestrel', 'Project Heron']);
  });
});

// G-01 (#173), slice 5: a team inbox's mail reaches a model only inside an audited pass. The in-memory store models the
// SQL definers and the writer's team branch (tests/helpers/memoryProposalStore.ts).
describe('proposeDeals: the team pass (G-01 #173)', () => {
  const FIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const unroutedPage = (n: number, tag: string) =>
    route(
      dedupeObservations(
        Array.from({ length: n }, (_, i) => sighted(message({ internetMessageId: `<${tag}-${++seq}-${i}@harbourline.example>`, subject: `${tag} ${seq}` }))),
      ).items,
    );

  /** A team inbox source with its firm approved in both halves, unless the test says otherwise. */
  function teamRun(over: Parameters<typeof memoryProposalStore>[0] = {}, passes: { firmIds?: string[]; now?: () => number } = {}) {
    const m = memoryProposalStore({ teamSources: { [SOURCE]: FIRM }, approvedFirms: [FIRM], now: passes.now, ...over });
    const sources = passesFor(DEV_TENANT_ID, m.store, { firmIds: passes.firmIds ?? [FIRM], now: passes.now });
    const at = { sourceId: SOURCE, runId: RUN };
    const page = (entries: RoutedItem[], transport: ModelTransport) => proposeDeals(entries, ctx(transport, m.store, { sources }));
    return { m, sources, at, page };
  }

  it('opens the pass before the first call, renews it on each later page, and closes it with the outcome and counts', async () => {
    const { m, sources, at, page } = teamRun();
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await page(unroutedPage(1, 'p1'), transport);
    await page(unroutedPage(1, 'p2'), transport);
    // The pass is open before any row is written; a later page renews it instead of beginning again.
    expect(m.log).toEqual(['begin', 'save', 'renew', 'save']);
    expect(m.passes()).toMatchObject([{ sourceId: SOURCE, runId: RUN, firmId: FIRM, path: 'recorded', open: true }]);
    await sources.end(at, 'complete');
    expect(m.log.at(-1)).toBe('end:complete');
    expect(m.passes()[0]).toMatchObject({ open: false, outcome: 'complete', counts: { asked: 2, deal: 0, notDeal: 2, invalid: 0, failed: 0 } });
    expect(transport.sent).toHaveLength(2);
    // Closed once: a second end sends nothing.
    await sources.end(at, 'error');
    expect(m.calls.endSource).toBe(1);
  });

  it('sends the firm list to SQL with the pass, which checks both halves again', async () => {
    const { m, page } = teamRun();
    const begin = vi.spyOn(m.store, 'beginSource');
    await page(unroutedPage(1, 'firms'), proposeReplyDouble(() => NOT_DEAL));
    expect(begin).toHaveBeenCalledWith(DEV_TENANT_ID, SOURCE, RUN, 'recorded', [FIRM]);
  });

  const REFUSALS: Array<[string, BeginResult, boolean]> = [
    ['the firm is not approved', { ok: false, code: 'team_not_approved' }, false],
    ['the inbox is refused', { ok: false, code: 'team_inbox_not_allowed' }, false],
    ['the source has no reader', { ok: false, code: 'no_reader' }, false],
    ['another run holds a fresh pass', { ok: false, code: 'pass_in_progress' }, false],
    // An unknown failure may have opened the pass before it answered: the close is sent, and SQL no-ops if none exists.
    ['the call fails in any other way', { ok: false, code: 'error' }, true],
  ];
  it.each(REFUSALS)('stops the source for the run, before anything is read or asked, when %s', async (_label, answer, closes) => {
    const { m, sources, at, page } = teamRun({ scriptedBegin: [answer] });
    const transport = proposeReplyDouble(() => DEAL);
    const first = await page(unroutedPage(2, 'refused'), transport);
    expect(first).toMatchObject({ called: 0, failed: 0 });
    expect(transport.sent).toEqual([]);
    expect(m.rows()).toEqual([]);
    // Begin comes before the settled-keys and known-deals reads: nothing of the source was touched.
    expect(m.calls).toMatchObject({ settledKeys: 0, candidates: 0, saveProposal: 0 });
    expect(sources.isStopped(SOURCE)).toBe(true);
    expect(sources.refused).toBe(1);

    // A later page of the same source never begins again.
    await page(unroutedPage(2, 'again'), transport);
    expect(m.calls.beginSource).toBe(1);
    expect(transport.sent).toEqual([]);

    await sources.end(at, 'complete');
    expect(m.log).toEqual(closes ? ['begin', 'end:error'] : ['begin']);
  });

  it('refuses a firm the reviewed list does not name, and a firm with no live approval row, through the real checks', async () => {
    const notListed = teamRun({}, { firmIds: [] });
    const t1 = proposeReplyDouble(() => DEAL);
    await notListed.page(unroutedPage(1, 'unlisted'), t1);
    expect(t1.sent).toEqual([]);
    expect(notListed.sources.isStopped(SOURCE)).toBe(true);

    const noRow = teamRun({ approvedFirms: [] });
    const t2 = proposeReplyDouble(() => DEAL);
    await noRow.page(unroutedPage(1, 'norow'), t2);
    expect(t2.sent).toEqual([]);
    expect(noRow.m.passes()).toEqual([]);
    expect(noRow.sources.refused).toBe(1);
  });

  it('treats a store that throws on begin as a refusal', async () => {
    const { m, sources, page } = teamRun();
    m.store.beginSource = async () => {
      throw new Error('socket hang up');
    };
    const transport = proposeReplyDouble(() => DEAL);
    await page(unroutedPage(1, 'throws'), transport);
    expect(transport.sent).toEqual([]);
    expect(sources.isStopped(SOURCE)).toBe(true);
  });

  it('does not begin after the step has stopped, or on a page with no unrouted mail', async () => {
    const stoppedStreak = { consecutive: MAX_CONSECUTIVE_FAILURES, stopped: true };
    const a = teamRun();
    await proposeDeals(unroutedPage(1, 'streak'), ctx(proposeReplyDouble(() => DEAL), a.m.store, { sources: a.sources, streak: stoppedStreak }));
    expect(a.m.log).toEqual([]);

    const b = teamRun();
    const routed = routeByFirmRules(demoItems(DEMO_LATE_DIR), { scope: 'unscoped' }).filter((r) => r.routes.length > 0);
    expect(routed.length).toBeGreaterThan(0);
    await b.page(routed, proposeReplyDouble(() => DEAL));
    expect(b.m.log).toEqual([]);
  });

  it('stops sending when the writer refuses a row, counts no failed row, and closes the pass as revoked', async () => {
    const { m, sources, at, page } = teamRun();
    // The switch is turned off while the first call is in flight: the writer's 42501 reaches the step as the save.
    const transport = proposeReplyDouble(() => {
      m.approvals.delete(FIRM);
      return NOT_DEAL;
    });
    const tally = await page(unroutedPage(3, 'revoked'), transport);
    expect(transport.sent).toHaveLength(1);
    expect(tally).toMatchObject({ called: 1, failed: 0, notDeal: 0 });
    expect(m.rows()).toEqual([]);
    expect(sources.isStopped(SOURCE)).toBe(true);
    expect(sources.refused).toBe(1);

    // The rest of the run: no further begin, renew or call for this source.
    await page(unroutedPage(2, 'later'), transport);
    expect(transport.sent).toHaveLength(1);
    expect(m.calls.renewSource).toBe(0);

    await sources.end(at, 'complete');
    expect(m.passes()[0]).toMatchObject({ open: false, outcome: 'revoked' });
  });

  it('a row failing for any other reason is a failed row, and the source carries on', async () => {
    const { sources, page } = teamRun({ refuseSave: () => true });
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const tally = await page(unroutedPage(2, 'other'), transport);
    expect(tally).toMatchObject({ called: 2, failed: 2 });
    expect(sources.isStopped(SOURCE)).toBe(false);
  });

  it('a renew the SQL refuses mid-run stops the source: revoked when the approval went, with nothing sent after it', async () => {
    const { m, sources, at, page } = teamRun({ scriptedRenew: [{ ok: false, code: 'team_not_approved' }] });
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await page(unroutedPage(2, 'first'), transport);
    expect(transport.sent).toHaveLength(2);
    await page(unroutedPage(2, 'second'), transport);
    expect(transport.sent).toHaveLength(2);
    expect(sources.isStopped(SOURCE)).toBe(true);
    await sources.end(at, 'complete');
    expect(m.passes()[0]).toMatchObject({ open: false, outcome: 'revoked' });
  });

  it('checks the lease in memory before each call and renews it only when it is about to lapse', async () => {
    let clock = Date.parse('2026-10-22T12:00:00Z');
    const now = () => clock;
    const { m, page } = teamRun({}, { now });
    // Each call takes 20 minutes. The lease is 30, renewed 2 minutes early.
    const transport = proposeReplyDouble(() => {
      clock += 20 * 60_000;
      return NOT_DEAL;
    });
    await page(unroutedPage(3, 'lease'), transport);
    // Call 1 at +0 and call 2 at +20 ride the first lease; call 3 at +40 would send under a lapsed one, so it renews first.
    expect(m.log).toEqual(['begin', 'save', 'save', 'renew', 'save']);
    expect(transport.sent).toHaveLength(3);
  });

  it('a person\'s mailbox holds no pass: one begin answers personal for the run, then no renew and no end', async () => {
    const m = memoryProposalStore({ approvedFirms: [FIRM] });
    const sources = new SourcePasses({ tenantId: DEV_TENANT_ID, store: m.store, firmIds: [FIRM], path: 'recorded' });
    const transport = proposeReplyDouble(() => NOT_DEAL);
    const tally = await proposeDeals(unroutedPage(2, 'personal'), ctx(transport, m.store, { sources }));
    await proposeDeals(unroutedPage(1, 'personal-2'), ctx(transport, m.store, { sources }));
    await sources.end({ sourceId: SOURCE, runId: RUN }, 'complete');
    expect(tally).toMatchObject({ called: 2, notDeal: 2 });
    expect(m.calls).toMatchObject({ beginSource: 1, renewSource: 0, endSource: 0 });
    expect(m.passes()).toEqual([]);
  });

  // Review F7: what kind of source it is comes from SQL's answer at begin, never from the caller.
  it.each([
    ['claims a person\'s mailbox (team: false)', { team: false }],
    ['says nothing (team: undefined)', { team: undefined }],
    ['passes no claim at all', {}],
  ])('a team inbox of an unapproved firm sends nothing when the caller %s', async (_label, claim) => {
    const m = memoryProposalStore({ teamSources: { [SOURCE]: FIRM }, approvedFirms: [] });
    const sources = passesFor(DEV_TENANT_ID, m.store, { firmIds: [] });
    const transport = proposeReplyDouble(() => DEAL);
    const tally = await proposeDeals(unroutedPage(2, 'claim'), { ...ctx(transport, m.store, { sources }), ...claim } as ProposeContext);
    expect(transport.sent).toEqual([]);
    expect(tally).toMatchObject({ called: 0 });
    expect(m.calls).toMatchObject({ beginSource: 1, settledKeys: 0, candidates: 0, saveProposal: 0 });
    expect(m.passes()).toEqual([]);
    expect(sources.isStopped(SOURCE)).toBe(true);
  });

  it('an approved team inbox handed as a person\'s mailbox still opens its audited pass before the first call', async () => {
    const { m } = teamRun();
    const sources = passesFor(DEV_TENANT_ID, m.store, { firmIds: [FIRM] });
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(unroutedPage(2, 'disguised'), { ...ctx(transport, m.store, { sources }), team: false } as ProposeContext);
    expect(m.log).toEqual(['begin', 'save', 'save']);
    expect(m.passes()).toMatchObject([{ sourceId: SOURCE, runId: RUN, open: true }]);
    expect(transport.sent).toHaveLength(2);
  });

  // Review F9: a retry chain can outlast the lease margin, so the lease is judged again before each retry.
  it('judges the lease again before a retry: a wait that runs into the margin renews first, and a refused renew sends no retry', async () => {
    let clock = Date.parse('2026-10-22T12:00:00Z');
    const now = () => clock;
    const { m, sources } = teamRun({ now, scriptedRenew: [{ ok: false, code: 'team_not_approved' }] }, { now });
    const transport = proposeReplyDouble(() => NOT_DEAL, { alwaysFail: true });
    // Each retry wait lasts 29 minutes, so the first wait ends inside the last two minutes of the 30-minute lease.
    const tally = await proposeDeals(
      unroutedPage(2, 'retry'),
      ctx(transport, m.store, {
        sources,
        sleep: async () => {
          clock += 29 * 60_000;
        },
      }),
    );
    expect(transport.sent).toHaveLength(1);
    expect(m.log).toEqual(['begin', 'renew']);
    expect(sources.isStopped(SOURCE)).toBe(true);
    expect(tally).toMatchObject({ called: 1, failed: 1 });
  });

  it('a retry whose lease is renewed in time is sent', async () => {
    let clock = Date.parse('2026-10-22T12:00:00Z');
    const now = () => clock;
    const { m, sources } = teamRun({ now }, { now });
    const first = unroutedPage(1, 'renewed');
    const failing = proposeReplyDouble(() => NOT_DEAL, { failFirstFor: new Set([first[0].item.contentHash]) });
    await proposeDeals(
      first,
      ctx(failing, m.store, {
        sources,
        sleep: async () => {
          clock += 29 * 60_000;
        },
      }),
    );
    expect(failing.sent).toHaveLength(2);
    expect(m.log).toEqual(['begin', 'renew', 'save']);
  });
});

describe('proposeDeals: a dismissed model-named deal (G-02a #173)', () => {
  const page = (id: string, subject: string, sourceId = SOURCE) =>
    route(dedupeObservations([sighted(message({ internetMessageId: `<${id}-${++seq}@harbourline.example>`, subject }), sourceId)]).items);

  it('leaves a dismissed m: name out of the prompt, and a newer proposal of the key brings it back', async () => {
    const m = memoryProposalStore();
    await proposeDeals(page('heron', 'One'), ctx(proposeReplyDouble(() => DEAL), m.store));
    expect(m.rows()).toMatchObject([{ contentSourceId: SOURCE, dealKey: 'm:project-heron' }]);

    // The owner dismisses Heron on this source: the next run does not offer it, so the model names it afresh.
    m.dismiss(DEV_TENANT_ID, SOURCE, 'm:project-heron');
    const after = proposeReplyDouble(() => DEAL);
    const tally = await proposeDeals(page('heron-again', 'Two'), ctx(after, m.store));
    expect(after.sent[0].input.candidates).toEqual([]);
    expect(JSON.stringify(after.sent[0].input.candidates)).not.toMatch(/Heron/);
    // Its answer is a newer proposal of the same key, made after the dismissal.
    expect(tally).toMatchObject({ deal: 1, newNames: 1 });
    expect(m.rows().filter((r) => r.dealKey === 'm:project-heron')).toHaveLength(2);

    // So the run after lists Heron again.
    const next = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(page('next', 'Three'), ctx(next, m.store));
    expect(next.sent[0].input.candidates).toEqual([{ ref: 'm:project-heron', name: 'Project Heron' }]);
  });

  it('judges a dismissal per source: one on another mailbox of the same owner leaves this one\'s list alone', async () => {
    const m = memoryProposalStore({ owners: { [SOURCE]: 'owner-a', [OTHER_SOURCE]: 'owner-a' } });
    await proposeDeals(page('heron-a', 'One'), ctx(proposeReplyDouble(() => DEAL), m.store));
    await proposeDeals(page('heron-b', 'One', OTHER_SOURCE), ctx(proposeReplyDouble(() => DEAL), m.store, { sourceId: OTHER_SOURCE }));
    m.dismiss(DEV_TENANT_ID, OTHER_SOURCE, 'm:project-heron');

    const here = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(page('next-a', 'Two'), ctx(here, m.store));
    expect(here.sent[0].input.candidates).toEqual([{ ref: 'm:project-heron', name: 'Project Heron' }]);
    const there = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(page('next-b', 'Two', OTHER_SOURCE), ctx(there, m.store, { sourceId: OTHER_SOURCE }));
    expect(there.sent[0].input.candidates).toEqual([]);
  });

  it('keeps offering a listed candidate whose proposals were dismissed: the dismissal never touches the candidate', async () => {
    const m = memoryProposalStore({ candidates: [{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel', candidateId: KESTREL_ID }] });
    m.dismiss(DEV_TENANT_ID, SOURCE, `c:${KESTREL_ID}`);
    const transport = proposeReplyDouble(() => NOT_DEAL);
    await proposeDeals(page('kestrel', 'One'), ctx(transport, m.store));
    expect(transport.sent[0].input.candidates).toEqual([{ ref: `c:${KESTREL_ID}`, name: 'Project Kestrel' }]);
  });
});
