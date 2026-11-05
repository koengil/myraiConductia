import { describe, expect, it } from 'vitest';

import { DEAL_RAIL, MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { GENERATED_STEPS } from '@/lib/rail/railData.generated';

/*
 * Step text reaches the banker (the zoomed step, its About tooltip, template
 * step details). The source ledger's own version notes ("v9 ...", "RAG
 * readiness") are engineering notes, never step copy (S6-13). Neither are its
 * roadmap and build-number notes ("the OS later productizes...", "OS Build
 * #16", "An Operating System build"), nor ledger seq numbers ("Seq 30"; the UI
 * counts display steps, and io.inputs keep their seqs for "Draws on"), and
 * the actor the banker reads is Conductia, never "the agent" (glossary, D49;
 * S6R3-07, S6R3-R1 I-2).
 */

const ENGINEERING_NOTE = /\bv9\b|\bRAG\b/;

function strings(value: unknown, path: string, out: { path: string; text: string }[]) {
  if (typeof value === 'string') out.push({ path, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  }
  return out;
}

/** The step fields the UI shows: the step view, its About tooltip, Move, the skill library. */
const VOICE_BREAK = /\bthe agent\b|\bagent\b|\bthe OS\b|productiz|\bOS Build\b|\bOperating System\b|\bSeq\s*\d|\bv9\b|\bWGL\b|&amp;/i;

type VisibleStep = {
  id: string;
  title?: string;
  name?: string;
  description?: string;
  whyBetter?: string;
  note?: string;
  approvalBy?: string;
  compliance?: string[];
  io?: { outputs?: { what: string }[] };
};

function visibleText(step: VisibleStep): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const push = (field: string, text: string | undefined) => {
    if (text) out.push({ path: `${step.id}.${field}`, text });
  };
  push('title', step.title);
  push('name', step.name);
  push('description', step.description);
  push('whyBetter', step.whyBetter);
  push('note', step.note);
  push('approvalBy', step.approvalBy);
  step.compliance?.forEach((c, i) => push(`compliance[${i}]`, c));
  step.io?.outputs?.forEach((o, i) => push(`io.outputs[${i}].what`, o.what));
  return out;
}

describe('step text the UI shows names Conductia and carries no roadmap note', () => {
  it.each([
    ['the full rail', orderedSteps(DEAL_RAIL) as VisibleStep[]],
    ['the MVP rail', orderedSteps(MVP_DEAL_RAIL) as VisibleStep[]],
    ['the generated catalog', GENERATED_STEPS as VisibleStep[]],
  ])('no visible step text on %s carries "the agent", a roadmap or build note, or a ledger seq', (_name, steps) => {
    const hits = steps.flatMap(visibleText).filter((s) => VOICE_BREAK.test(s.text));
    expect(hits).toEqual([]);
  });
});

describe('catalog step text carries no engineering notes', () => {
  it.each([
    ['the full rail', orderedSteps(DEAL_RAIL)],
    ['the MVP rail', orderedSteps(MVP_DEAL_RAIL)],
  ])('no step on %s mentions v9 or RAG', (_name, steps) => {
    const hits = steps.flatMap((step) => strings(step, step.id, [])).filter((s) => ENGINEERING_NOTE.test(s.text));
    expect(hits).toEqual([]);
  });

  it('no generated catalog step mentions v9 or RAG', () => {
    const hits = GENERATED_STEPS.flatMap((step) => strings(step, step.id, [])).filter((s) =>
      ENGINEERING_NOTE.test(s.text),
    );
    expect(hits).toEqual([]);
  });
});
