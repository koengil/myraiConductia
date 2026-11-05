// Live demo for the agent orchestrator spine (feat/agent-orchestrator-spine).
//
//   npm run demo:spine
//
// Runs three jobs through the real Orchestrator and prints, for each, the
// states it walked, what every leashed agent saw/did/why, the compliance
// verdict, the human gates, the token spend, and the terminal state. Then it
// replays the happy run FROM THE AUDIT LOG ALONE to prove the trail is the
// source of truth. No UI, no network - this is the spine, governed end to end.
//
// Three paths, on purpose:
//   1. HAPPY   → COMPLETE   (plan confirmed, draft cleared, signed off)
//   2. BLOCKED              (a promissory draft never leaves the firm)
//   3. HALTED              (a rogue agent that pulled out-of-envelope data)

import { DEAL_ROLE } from '../src/lib/constants/roles';
import { DOCUMENT_CLASSIFICATION } from '../src/lib/constants/documents';
import {
  Orchestrator,
  InMemoryJobStore,
  reconstruct,
  ResearchAgent,
  type RunContext,
  type ActorClearance,
  type DealDocument,
  type Job,
  type CapabilityAgent,
  type AgentInput,
  type AgentResult,
  type ResearchOutput,
} from '../src/lib/orchestration';

// --- tiny ANSI helpers (no deps) -------------------------------------------
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};
const paint = (c: keyof typeof C, s: string) => `${C[c]}${s}${C.reset}`;
const rule = (label = '') =>
  console.log(paint('gray', `\n${'─'.repeat(78)}${label ? ` ${label} ` : ''}`));
const terminalColor = (t?: string) =>
  t === 'COMPLETE' ? 'green' : t === 'FAILED' ? 'yellow' : 'red';

// --- fixtures (mirror tests/orchestration/helpers.ts) -----------------------
function buildJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    goal: 'Prepare the teaser for Atlassian',
    dealId: 'deal-atlassian',
    requestingActorId: 'actor-md',
    completionCondition: 'A compliance-cleared teaser exists',
    stakes: 'high',
    brief: {
      sellerName: 'Atlassian',
      sector: 'Software',
      headline: 'Category-defining collaboration software.',
      ...(overrides.brief ?? {}),
    },
    ...overrides,
  };
}

const MD_ACTOR: ActorClearance = {
  actorId: 'actor-md',
  dealId: 'deal-atlassian',
  dealRole: DEAL_ROLE.MD,
  phase: 1,
};

const DOCUMENTS: DealDocument[] = [
  { id: 'd-public', dealId: 'deal-atlassian', name: 'Market read', classification: DOCUMENT_CLASSIFICATION.PUBLIC, minPhase: 0, body: 'public' },
  { id: 'd-conf', dealId: 'deal-atlassian', name: 'Financials', classification: DOCUMENT_CLASSIFICATION.CONFIDENTIAL, minPhase: 0, body: 'confidential' },
];

const ctx = (): RunContext => ({ actor: MD_ACTOR, documents: DOCUMENTS });

// A rogue node that reports seeing an artifact it was never handed. The sealed
// envelope makes that impossible; the supervisor's monitor must halt it.
class RogueResearchAgent implements CapabilityAgent<ResearchOutput> {
  readonly name = 'RogueResearchAgent';
  async run(input: AgentInput): Promise<AgentResult<ResearchOutput>> {
    const saw = [...input.envelope.documents.map((d) => d.id), 'd-mnpi-not-in-envelope'];
    input.report({ agent: this.name, saw, did: 'read board minutes it was never given', why: 'n/a' });
    return {
      result: { comps: [], marketRead: 'leaked' },
      auditRecord: { saw, did: 'pulled out-of-scope data', why: 'n/a', modelUsed: input.model, tokens: 10 },
      status: 'complete',
      completionAssertion: 'n/a',
    };
  }
}

// --- pretty printers --------------------------------------------------------
function printRun(orch: Orchestrator, events: Parameters<typeof reconstruct>[0]) {
  const run = reconstruct(events);
  console.log(paint('bold', '  states:   ') + run.states.join(paint('gray', ' → ')));
  for (const a of run.agents) {
    console.log(
      `  ${paint('cyan', a.agent)} ${paint('gray', `[${a.model}, ${a.tokens} tok]`)}`,
    );
    console.log(`    saw: ${a.saw.length ? a.saw.join(', ') : paint('gray', '(none)')}`);
    console.log(`    did: ${a.did}`);
    console.log(`    why: ${paint('dim', a.why)}`);
  }
  if (run.complianceDecision)
    console.log(`  compliance: ${paint(run.complianceDecision === 'block' ? 'red' : 'green', run.complianceDecision)}`);
  if (run.gatesApproved.length)
    console.log(`  gates approved: ${run.gatesApproved.join(', ')}`);
  console.log(`  tokens: ${run.totalTokens} ${paint('gray', `(meter: ${orch.meter.total()})`)}`);
  console.log(
    `  terminal: ${paint(terminalColor(run.terminal), run.terminal ?? '-')}` +
      (run.completed ? paint('green', '  ✓ completed') : ''),
  );
}

// --- the three paths --------------------------------------------------------
async function happy() {
  rule('1 · HAPPY  →  COMPLETE');
  console.log(paint('dim', '  high-stakes teaser: plan is confirmed, draft clears, MD signs off.\n'));
  const orch = new Orchestrator({ store: new InMemoryJobStore() });
  const job = buildJob();

  const afterStart = await orch.start(job, ctx());
  console.log(`  paused at gate → ${paint('yellow', afterStart.awaitingGate ?? '-')} (state ${afterStart.state})`);
  await orch.approve(job.id, 'plan', ctx());
  const afterPlan = await orch.load(job.id);
  console.log(`  paused at gate → ${paint('yellow', afterPlan?.awaitingGate ?? '-')} (state ${afterPlan?.state})`);
  const rec = await orch.approve(job.id, 'signoff', ctx());

  printRun(orch, rec.events);
  console.log(paint('gray', '\n  artifact that left the firm:'));
  console.log(
    (rec.artifact ?? '')
      .split('\n')
      .map((l) => paint('gray', '  │ ') + l)
      .join('\n'),
  );
  return rec;
}

async function blocked() {
  rule('2 · BLOCKED  (the draft never leaves)');
  console.log(paint('dim', '  same workflow, but the brief headline is promissory language.\n'));
  const orch = new Orchestrator({ store: new InMemoryJobStore() });
  const job = buildJob({
    brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'I guarantee the board seat.' },
  });

  await orch.start(job, ctx());
  const rec = await orch.approve(job.id, 'plan', ctx());

  printRun(orch, rec.events);
  const verdict = rec.events.find((e) => e.type === 'COMPLIANCE_VERDICT');
  console.log(`  reasons: ${paint('red', JSON.stringify(verdict?.detail.reasons))}`);
  console.log(`  rewrite: ${paint('yellow', String(verdict?.detail.rewrite ?? '-'))}`);
  console.log(`  artifact: ${rec.artifact ? rec.artifact : paint('red', 'none - nothing left the firm')}`);
  return rec;
}

async function halted() {
  rule('3 · HALTED  (rogue agent killed mid-run)');
  console.log(paint('dim', '  a node reports seeing an artifact outside its sealed envelope.\n'));
  const orch = new Orchestrator({
    store: new InMemoryJobStore(),
    researchAgent: new RogueResearchAgent(),
  });
  const job = buildJob({ stakes: 'low' }); // low stakes skips the plan gate, reaches RESEARCH directly

  const rec = await orch.start(job, ctx());

  printRun(orch, rec.events);
  const halt = rec.events.find((e) => e.type === 'AGENT_HALTED');
  console.log(`  halt reason: ${paint('red', String(halt?.detail.reason))}`);
  console.log(`  draft reached: ${rec.draft ? 'yes' : paint('green', 'no - stopped before drafting')}`);
  console.log(`  metered tokens: ${paint('green', String(orch.meter.total()))} ${paint('gray', '(a halted agent is never metered)')}`);
  return rec;
}

// --- audit replay (the wow) -------------------------------------------------
function replay(events: Parameters<typeof reconstruct>[0]) {
  rule('AUDIT REPLAY  ·  the happy run, rebuilt from the event log alone');
  const run = reconstruct(events);
  console.log(paint('dim', '  Nothing below is read from the JobRecord - only its ordered AuditEvents.\n'));
  console.log(`  ${paint('bold', '#')}  ${paint('bold', 'event')}`);
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const extra =
      e.type === 'AGENT_REPORTED'
        ? paint('gray', ` ${e.detail.agent} · ${e.detail.model} · ${e.detail.tokens} tok`)
        : e.type === 'COMPLIANCE_VERDICT'
          ? paint('gray', ` ${e.detail.decision}`)
          : e.type === 'GATE_APPROVED'
            ? paint('gray', ` ${e.detail.gate}`)
            : '';
    console.log(`  ${String(e.seq).padStart(2)}  ${paint('cyan', e.type.padEnd(18))} ${paint('gray', e.state)}${extra}`);
  }
  console.log(
    `\n  reconstructed: ${run.agents.length} agents · ${run.totalTokens} tokens · ` +
      `compliance ${run.complianceDecision} · gates [${run.gatesApproved.join(', ')}] · ` +
      paint(terminalColor(run.terminal), run.terminal ?? '-'),
  );
}

async function main() {
  console.log(paint('bold', '\nAgent orchestrator spine - live demo'));
  console.log(paint('dim', 'Deterministic conductor · sealed envelopes · compliance over the graph · human sign-off.'));

  const happyRec = await happy();
  await blocked();
  await halted();
  replay(happyRec.events);

  rule();
  console.log(paint('green', '✓ ') + 'Three paths, one spine. The moat now governs agents, not just messages.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
