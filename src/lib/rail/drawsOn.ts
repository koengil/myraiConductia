import type { RailStep } from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/**
 * "Draws on": the steps a step's brief names as its inputs ("Pitchbook
 * Drafting (Seq 21)", "Seq 34/37", "Seq 15, 17, 19, 18, 55").
 *
 * These are source references in the step brief, not gates. Nothing waits on
 * them: some point forward (Pitchbook Drafting cites League Table
 * Submission), a deal entered partway leaves earlier ones before its entry,
 * and custom steps carry none. So the step detail lists them with the
 * referenced step's status, a forward one as "Later step", and never says
 * blocked or waiting. Whether real dependencies block or only warn is a
 * question for Storm ("Do dependencies block, or only warn?"), and storing
 * them is handoff entry E4 (Step dependencies, per-step dates and "started"
 * facts).
 *
 * Only the inputs are read: a description's "handed to Seq 30" is an output,
 * and a tool's "(Seq 18)" names an application, not work this step uses.
 */

const SEQ_REF = /\bSeq\s+(\d+(?:\s*(?:,|\/|&|and)\s*\d+)*)/gi;

/** Canonical seqs a step brief's inputs cite, in first-cited order, without its own. */
export function citedSeqs(step: Pick<RailStep, 'seq' | 'io'>): number[] {
  const seqs: number[] = [];
  for (const input of step.io.inputs) {
    for (const text of [input.source, input.what]) {
      for (const match of text.matchAll(SEQ_REF)) {
        for (const n of match[1].match(/\d+/g) ?? []) {
          const seq = Number(n);
          if (seq !== step.seq && !seqs.includes(seq)) seqs.push(seq);
        }
      }
    }
  }
  return seqs;
}

export type DrawsOnRef = {
  seq: number;
  /** The step on this deal's rail, or null when it is not on it (removed). */
  step: ProjectRailStep | null;
  /** Its name: the rail step's title, else the catalog's. */
  title: string;
  /** Sits after this step on the rail. */
  later: boolean;
};

/** The steps `step` draws on, resolved against this deal's rail. */
export function drawsOnFor(
  step: ProjectRailStep,
  steps: readonly ProjectRailStep[],
  titleOf: (step: ProjectRailStep) => string,
  catalogTitle: (seq: number) => string | undefined,
): DrawsOnRef[] {
  const brief = step.catalog;
  if (!brief) return [];
  const here = steps.indexOf(step);
  return citedSeqs(brief).flatMap((seq) => {
    const index = steps.findIndex((s) => s.seq === seq);
    const onRail = index >= 0 ? steps[index] : null;
    const title = onRail ? titleOf(onRail) : catalogTitle(seq);
    if (!title) return [];
    const later = onRail ? index > here : seq > (step.seq ?? brief.seq);
    return [{ seq, step: onRail, title, later }];
  });
}
