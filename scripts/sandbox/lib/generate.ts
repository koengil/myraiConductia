import { emailDomain } from './domains';
import type { FixtureCastMember, FixtureDeal, SandboxFixture, SandboxMessage, GenerationPlan, ManifestEntry } from './types';
import { castById } from './fixture';
import { placeholderAttachment } from './attachments';
import { intBetween, mulberry32, pick, type Rng } from './prng';

export const SANDBOX_HEADER_KEY = 'X-Conductia-Sandbox-Message-Key';
export const SANDBOX_HEADER_RUN = 'X-Conductia-Sandbox-Run-Tag';

export type GenerateOptions = {
  fixture: SandboxFixture;
  runStart: Date;
  runTag: string;
  seed: number;
  dealFilter?: string[];
};

type ThreadState = {
  threadKey: string;
  messageIds: string[];
  lastSubject: string;
};

type GenCtx = {
  fixture: SandboxFixture;
  cast: Map<string, FixtureCastMember>;
  runStart: Date;
  runTag: string;
  rng: Rng;
  messages: SandboxMessage[];
  threads: Map<string, ThreadState>;
  dealThreads: Map<string, Map<string, ThreadState>>;
};

function addr(member: FixtureCastMember): { name: string; address: string } {
  return { name: member.display_name, address: member.email };
}

function messageIdFor(domain: string, key: string): string {
  return `<sandbox.${key.replace(/[^a-zA-Z0-9._-]/g, '_')}@${domain}>`;
}

function dayDate(runStart: Date, day: number): Date {
  const d = new Date(runStart);
  d.setUTCDate(d.getUTCDate() + day);
  d.setUTCHours(9 + (day % 8), (day * 13) % 60, 0, 0);
  return d;
}

function dealParticipants(deal: FixtureDeal, cast: Map<string, FixtureCastMember>): FixtureCastMember[] {
  return Object.keys(deal.cast)
    .map((id) => cast.get(id))
    .filter((m): m is FixtureCastMember => Boolean(m));
}

function pushMessage(ctx: GenCtx, deal: FixtureDeal, draft: Omit<SandboxMessage, 'messageId' | 'customHeaders' | 'date'> & { date?: Date }): SandboxMessage {
  const messageId = messageIdFor(emailDomain(draft.from.address), draft.key);
  const date = draft.date ?? dayDate(ctx.runStart, draft.dayOffset);
  const msg: SandboxMessage = {
    ...draft,
    date,
    messageId,
    customHeaders: {
      [SANDBOX_HEADER_KEY]: draft.key,
      [SANDBOX_HEADER_RUN]: ctx.runTag,
    },
    tags: draft.tags ?? [],
  };
  ctx.messages.push(msg);
  const thread = ctx.threads.get(draft.threadKey) ?? { threadKey: draft.threadKey, messageIds: [], lastSubject: draft.subject };
  thread.messageIds.push(messageId);
  thread.lastSubject = draft.subject;
  ctx.threads.set(draft.threadKey, thread);
  const byDeal = ctx.dealThreads.get(deal.code) ?? new Map<string, ThreadState>();
  byDeal.set(draft.threadKey, thread);
  ctx.dealThreads.set(deal.code, byDeal);
  return msg;
}

function attachForDeal(deal: FixtureDeal, filename: string, rng: Rng): SandboxMessage['attachments'] {
  const { contentType, content } = placeholderAttachment(filename, rng, deal.code);
  return [{ filename, contentType, content }];
}

function expandTimeline(ctx: GenCtx, deal: FixtureDeal): void {
  const people = dealParticipants(deal, ctx.cast);
  for (let index = 0; index < deal.timeline.length; index += 1) {
    const event = deal.timeline[index]!;
    const threadKey = `${deal.code}:timeline:${event.event}`;
    const count = intBetween(ctx.rng, 5, 9);
    const attachmentName = deal.attachments[index % deal.attachments.length];
    for (let i = 0; i < count; i += 1) {
      const actor = pick(ctx.rng, people);
      const others = people.filter((p) => p.id !== actor.id);
      const primary = pick(ctx.rng, others);
      const ccPool = others.filter((p) => p.id !== primary.id);
      const cc = ctx.rng() > 0.55 ? [pick(ctx.rng, ccPool)] : [];
      const prev = ctx.threads.get(threadKey);
      const inReplyTo = prev && i > 0 ? prev.messageIds[prev.messageIds.length - 1] : undefined;
      const references = prev ? [...prev.messageIds] : undefined;
      const subject =
        i === 0
          ? `[${deal.code}] ${event.event.replace(/_/g, ' ')} — ${deal.target}`
          : `Re: [${deal.code}] ${event.event.replace(/_/g, ' ')} — ${deal.target}`;
      const bodyLines = [
        i === 0 ? event.desc : 'Following up on the note below.',
        '',
        `${actor.display_name} (${actor.role})`,
        actor.tone,
        '',
        'Next steps:',
        '- Confirm timeline',
        '- Share any open questions',
        '',
        actor.signature.trim(),
      ];
      pushMessage(ctx, deal, {
        key: `${deal.code}.timeline.${event.event}.${i}`,
        dealCode: deal.code,
        dayOffset: event.day + Math.min(i, 2),
        from: addr(actor),
        to: [addr(primary)],
        cc: cc.map(addr),
        subject,
        text: bodyLines.join('\n'),
        attachments: i === 0 && attachmentName ? attachForDeal(deal, attachmentName, ctx.rng) : [],
        inReplyTo,
        references,
        threadKey,
        tags: ['timeline', event.event],
        kind: 'timeline',
      });
    }
  }
}

function fillerMail(ctx: GenCtx, deal: FixtureDeal): void {
  const people = dealParticipants(deal, ctx.cast);
  const fillerCount = intBetween(ctx.rng, 12, 18);
  for (let i = 0; i < fillerCount; i += 1) {
    const actor = pick(ctx.rng, people);
    const peer = pick(ctx.rng, people.filter((p) => p.id !== actor.id));
    const day = intBetween(ctx.rng, 0, deal.timeline[deal.timeline.length - 1]?.day ?? 10);
    pushMessage(ctx, deal, {
      key: `${deal.code}.filler.${i}`,
      dealCode: deal.code,
      dayOffset: day,
      from: addr(actor),
      to: [addr(peer)],
      cc: ctx.rng() > 0.7 ? [addr(pick(ctx.rng, people))] : [],
      subject: `[${deal.code}] Quick update — ${deal.stage.replace(/_/g, ' ')}`,
      text: [`Hi ${peer.display_name.split(' ')[0]},`, '', pick(ctx.rng, actor.behaviours), '', 'Thanks,', actor.signature.trim()].join('\n'),
      attachments: [],
      threadKey: `${deal.code}:filler:${i}`,
      tags: ['filler'],
      kind: 'filler',
    });
  }
}

function applyTriggers(ctx: GenCtx, deal: FixtureDeal): void {
  if (deal.demo_safe) {
    for (const trigger of deal.triggers) {
      if (trigger.type === 'reply_chain') applyReplyChainTrigger(ctx, deal, trigger);
      else if (trigger.type === 'forward') applyForwardTrigger(ctx, deal, trigger);
    }
    return;
  }
  for (const trigger of deal.triggers) {
    switch (trigger.type) {
      case 'sensitive_content':
        applySensitiveTrigger(ctx, deal, trigger);
        break;
      case 'duplicate_thread':
        applyDuplicateTrigger(ctx, deal, trigger);
        break;
      case 'reply_chain':
        applyReplyChainTrigger(ctx, deal, trigger);
        break;
      case 'wrong_side_reply':
        applyWrongSideReply(ctx, deal, trigger);
        break;
      case 'wrong_recipient':
        applyWrongRecipientTrigger(ctx, deal, trigger);
        break;
      case 'forward':
        applyForwardTrigger(ctx, deal, trigger);
        break;
      case 'sensitive_forward':
        applySensitiveForwardTrigger(ctx, deal, trigger);
        break;
      default:
        break;
    }
  }
}

function applySensitiveTrigger(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actor = ctx.cast.get(typeof trigger.actor === 'string' ? trigger.actor : trigger.actor[0]!);
  if (!actor) return;
  const sam = ctx.cast.get('sam');
  const priya = ctx.cast.get('priya');
  const to = trigger.id === 'BF-T1' && sam ? [addr(sam)] : dealParticipants(deal, ctx.cast).slice(0, 2).map(addr);
  const body =
    trigger.id === 'KE-T2'
      ? 'Draft announcement — price of £14.25 per share (unannounced). Please review before board.'
      : 'Privileged LOI redline attached. Internal counsel comments only — do not forward.';
  pushMessage(ctx, deal, {
    key: `${deal.code}.trigger.${trigger.id}`,
    dealCode: deal.code,
    dayOffset: deal.timeline.at(-1)?.day ?? 10,
    from: addr(actor),
    to,
    cc: priya && trigger.id === 'BF-T1' ? [] : [],
    subject: `[${deal.code}] ${trigger.id} — confidential draft`,
    text: `${body}\n\n${actor.signature.trim()}`,
    attachments: attachForDeal(deal, deal.attachments.at(-1) ?? `${deal.code}_doc.pdf`, ctx.rng),
    threadKey: `${deal.code}:trigger:${trigger.id}`,
    triggerId: trigger.id,
    expectedOutcome: trigger.expected,
    tags: ['trigger', trigger.type, 'deliberate_mistake'],
    kind: 'trigger',
  });
}

function applyDuplicateTrigger(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actor = ctx.cast.get(typeof trigger.actor === 'string' ? trigger.actor : trigger.actor[0]!);
  if (!actor) return;
  const file = deal.attachments.find((a) => a.toLowerCase().includes('cim')) ?? deal.attachments[0]!;
  const attach = attachForDeal(deal, file, ctx.rng);
  for (let copy = 0; copy < 2; copy += 1) {
    pushMessage(ctx, deal, {
      key: `${deal.code}.trigger.${trigger.id}.${copy}`,
      dealCode: deal.code,
      dayOffset: (deal.timeline.find((e) => e.event === 'cim')?.day ?? 7) + copy,
      from: addr(actor),
      to: dealParticipants(deal, ctx.cast)
        .filter((p) => p.org !== actor.org)
        .slice(0, 1)
        .map(addr),
      cc: [],
      subject: `[${deal.code}] CIM / materials (${copy === 0 ? 'original' : 'resend'})`,
      text: `${copy === 0 ? 'Sharing the CIM as discussed.' : 'Resending the CIM — same file as earlier today.'}\n\n${actor.signature.trim()}`,
      attachments: attach,
      threadKey: `${deal.code}:trigger:${trigger.id}:${copy}`,
      triggerId: trigger.id,
      expectedOutcome: trigger.expected,
      tags: ['trigger', trigger.type, 'deliberate_mistake'],
      kind: 'trigger',
    });
  }
}

function applyReplyChainTrigger(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actorIds = Array.isArray(trigger.actor) ? trigger.actor : [trigger.actor];
  const actors = actorIds.map((id) => ctx.cast.get(id)).filter((m): m is FixtureCastMember => Boolean(m));
  if (actors.length === 0) return;
  const threadKey = `${deal.code}:trigger:${trigger.id}`;
  const hops = trigger.id === 'BF-T3' ? 6 : 4;
  for (let i = 0; i < hops; i += 1) {
    const actor = actors[i % actors.length]!;
    const others = actors.filter((a) => a.id !== actor.id);
    const toMember = others[i % others.length] ?? actors[0]!;
    const prev = ctx.threads.get(threadKey);
    pushMessage(ctx, deal, {
      key: `${deal.code}.trigger.${trigger.id}.${i}`,
      dealCode: deal.code,
      dayOffset: (deal.timeline.find((e) => e.event.includes('diligence') || e.event.includes('term'))?.day ?? 12) + Math.floor(i / 2),
      from: addr(actor),
      to: [addr(toMember)],
      cc: [],
      subject: i === 0 ? `[${deal.code}] Q&A thread (${trigger.id})` : `Re: [${deal.code}] Q&A thread (${trigger.id})`,
      text: [`${i + 1}/${hops}: ${pick(ctx.rng, actor.behaviours)}`, '', actor.signature.trim()].join('\n'),
      attachments: i === 0 ? attachForDeal(deal, deal.attachments[0]!, ctx.rng) : [],
      inReplyTo: prev?.messageIds.at(-1),
      references: prev ? [...prev.messageIds] : undefined,
      threadKey,
      triggerId: trigger.id,
      expectedOutcome: trigger.expected,
      tags: ['trigger', trigger.type],
      kind: 'trigger',
    });
  }
}

function applyWrongRecipientTrigger(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actor = ctx.cast.get(typeof trigger.actor === 'string' ? trigger.actor : trigger.actor[0]!);
  if (!actor) return;
  if (trigger.id === 'KE-T3') {
    const bluefinchThread = ctx.dealThreads.get('BLUEFINCH')?.values().next().value as ThreadState | undefined;
    const sam = ctx.cast.get('sam');
    const victoria = ctx.cast.get('victoria');
    if (!sam || !victoria || !bluefinchThread) return;
    pushMessage(ctx, deal, {
      key: `${deal.code}.trigger.${trigger.id}`,
      dealCode: deal.code,
      dayOffset: deal.timeline.at(-2)?.day ?? 12,
      from: addr(victoria),
      to: [addr(sam)],
      cc: [],
      subject: 'Re: [BLUEFINCH] status — Kestrel signing timeline',
      text: 'Sam — ignore the Kestrel signing date in my last note; wrong thread.\n\nV.',
      attachments: [],
      inReplyTo: bluefinchThread.messageIds.at(-1),
      references: [...bluefinchThread.messageIds],
      threadKey: 'BLUEFINCH:timeline:ioi',
      triggerId: trigger.id,
      expectedOutcome: trigger.expected,
      tags: ['trigger', trigger.type, 'deliberate_mistake'],
      kind: 'trigger',
    });
    return;
  }
  const alex = ctx.cast.get('alex');
  const walled = deal.walled_off?.[0] ?? 'alex';
  const wrong = ctx.cast.get(walled) ?? alex;
  if (!wrong) return;
  pushMessage(ctx, deal, {
    key: `${deal.code}.trigger.${trigger.id}`,
    dealCode: deal.code,
    dayOffset: deal.timeline.at(-2)?.day ?? 10,
    from: addr(actor),
    to: [addr(pick(ctx.rng, dealParticipants(deal, ctx.cast).filter((p) => p.id !== actor.id)))],
    cc: [addr(wrong)],
    subject: `[${deal.code}] Board pack / internal update (${trigger.id})`,
    text: `Please review — cc'd ${wrong.display_name} for visibility.\n\n${actor.signature.trim()}`,
    attachments: attachForDeal(deal, deal.attachments.at(-1) ?? `${deal.code}.pdf`, ctx.rng),
    threadKey: `${deal.code}:trigger:${trigger.id}`,
    triggerId: trigger.id,
    expectedOutcome: trigger.expected,
    tags: ['trigger', trigger.type, 'deliberate_mistake'],
    kind: 'trigger',
  });
}

function forwardEmlAttachment(params: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): SandboxMessage['attachments'] {
  const raw = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    params.body,
  ].join('\r\n');
  return [
    {
      filename: 'forwarded.eml',
      contentType: 'message/rfc822',
      content: new TextEncoder().encode(raw),
    },
  ];
}

function applyForwardTrigger(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actor = ctx.cast.get(typeof trigger.actor === 'string' ? trigger.actor : trigger.actor[0]!);
  if (!actor) return;
  const priya = ctx.cast.get('priya');
  const alex = ctx.cast.get('alex');
  const to = trigger.id === 'KE-T4' && priya ? [addr(priya)] : alex ? [addr(alex)] : dealParticipants(deal, ctx.cast).slice(1, 2).map(addr);
  const file =
    deal.attachments.find((a) => a.includes('SPA') || a.includes('Teaser')) ?? deal.attachments[0]!;
  const innerSubject = `[${deal.code}] ${file}`;
  pushMessage(ctx, deal, {
    key: `${deal.code}.trigger.${trigger.id}`,
    dealCode: deal.code,
    dayOffset: deal.timeline.find((e) => e.event.includes('spa') || e.event.includes('teaser'))?.day ?? 5,
    from: addr(actor),
    to,
    cc: [],
    subject: `[${deal.code}] Fwd: materials (${trigger.id})`,
    text: ['Please see the forwarded message attached.', '', actor.signature.trim()].join('\n'),
    attachments: [
      ...forwardEmlAttachment({
        from: actor.email,
        to: to[0]?.address ?? actor.email,
        subject: innerSubject,
        body: trigger.desc,
      }),
      ...attachForDeal(deal, file, ctx.rng),
    ],
    threadKey: `${deal.code}:trigger:${trigger.id}`,
    triggerId: trigger.id,
    expectedOutcome: trigger.expected,
    tags: ['trigger', trigger.type, ...(trigger.expected !== 'allowed' ? ['deliberate_mistake'] as const : [])],
    kind: 'trigger',
  });
}

function applySensitiveForwardTrigger(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actor = ctx.cast.get(typeof trigger.actor === 'string' ? trigger.actor : trigger.actor[0]!);
  const sam = ctx.cast.get('sam');
  if (!actor || !sam) return;
  pushMessage(ctx, deal, {
    key: `${deal.code}.trigger.${trigger.id}`,
    dealCode: deal.code,
    dayOffset: deal.timeline.find((e) => e.event === 'cim')?.day ?? 9,
    from: addr(actor),
    to: [addr(sam)],
    cc: [],
    subject: `[${deal.code}] Fwd: carve-out CIM (external share)`,
    text: `Sam — thought you might find this interesting.\n\n${actor.signature.trim()}`,
    attachments: attachForDeal(deal, deal.attachments.find((a) => a.includes('CIM')) ?? deal.attachments[0]!, ctx.rng),
    threadKey: `${deal.code}:trigger:${trigger.id}`,
    triggerId: trigger.id,
    expectedOutcome: trigger.expected,
    tags: ['trigger', trigger.type, 'deliberate_mistake'],
    kind: 'trigger',
  });
}

function applyWrongSideReply(ctx: GenCtx, deal: FixtureDeal, trigger: FixtureDeal['triggers'][number]): void {
  const actor = ctx.cast.get(typeof trigger.actor === 'string' ? trigger.actor : trigger.actor[0]!);
  const internalThread = Array.from(ctx.threads.keys()).find((k) => k.includes(`${deal.code}:timeline`));
  const thread = internalThread ? ctx.threads.get(internalThread) : undefined;
  if (!actor || !thread || !internalThread) return;
  pushMessage(ctx, deal, {
    key: `${deal.code}.trigger.${trigger.id}`,
    dealCode: deal.code,
    dayOffset: deal.timeline.find((e) => e.event === 'diligence')?.day ?? 16,
    from: addr(actor),
    to: dealParticipants(deal, ctx.cast)
      .filter((p) => deal.cast[p.id]?.side === 'sell' || p.org === 'firm_a')
      .slice(0, 2)
      .map(addr),
    cc: [],
    subject: 'Re: internal seller thread — buyer follow-up',
    text: 'Apologies — replied on the forwarded internal chain by mistake.\n\n' + actor.signature.trim(),
    attachments: [],
    inReplyTo: thread.messageIds.at(-1),
    references: [...thread.messageIds],
    threadKey: internalThread,
    triggerId: trigger.id,
    expectedOutcome: trigger.expected,
    tags: ['trigger', trigger.type, 'deliberate_mistake'],
    kind: 'trigger',
  });
}

export function generatePlan(options: GenerateOptions): GenerationPlan {
  const deals = options.fixture.deals.filter((d) => !options.dealFilter?.length || options.dealFilter.includes(d.code));
  const ctx: GenCtx = {
    fixture: options.fixture,
    cast: castById(options.fixture),
    runStart: options.runStart,
    runTag: options.runTag,
    rng: mulberry32(options.seed),
    messages: [],
    threads: new Map(),
    dealThreads: new Map(),
  };

  for (const deal of deals) {
    expandTimeline(ctx, deal);
    fillerMail(ctx, deal);
    applyTriggers(ctx, deal);
  }

  ctx.messages.sort((a, b) => a.date.getTime() - b.date.getTime() || a.key.localeCompare(b.key));

  const manifest: ManifestEntry[] = ctx.messages.map((m) => ({
    key: m.key,
    deal: m.dealCode,
    triggerId: m.triggerId,
    expected: m.expectedOutcome,
    tags: m.tags,
    subject: m.subject,
    from: m.from.address,
    to: m.to.map((t) => t.address),
    messageId: m.messageId,
    threadKey: m.threadKey,
    attachmentNames: m.attachments.map((a) => a.filename),
  }));

  assertDeliberateMistakeTags(ctx.messages);

  return { messages: ctx.messages, manifest };
}

const NON_MISTAKE_OUTCOMES = new Set(['allowed', 'single_thread', 'dedupe_merge']);

/** Every trigger with a screening outcome must carry deliberate_mistake in tags and manifest. */
export function assertDeliberateMistakeTags(messages: SandboxMessage[]): void {
  for (const message of messages) {
    if (!message.triggerId || !message.expectedOutcome) continue;
    if (NON_MISTAKE_OUTCOMES.has(message.expectedOutcome)) continue;
    if (!message.tags.includes('deliberate_mistake')) {
      throw new Error(`sandbox generator: ${message.key} (${message.triggerId}) missing deliberate_mistake tag`);
    }
  }
}

export function assertVolume(plan: GenerationPlan, min = 200, max = 320): void {
  if (plan.messages.length < min || plan.messages.length > max) {
    throw new Error(`expected ${min}-${max} messages, got ${plan.messages.length}`);
  }
}
