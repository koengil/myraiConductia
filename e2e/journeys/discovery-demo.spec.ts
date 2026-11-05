import { expect, test } from '../support/fixtures';
import { repliesFile } from '../support/recording';
import { acceptEvidenceSuggestion } from '../steps/acceptEvidenceSuggestion';
import { importLateMail } from '../steps/importLateMail';
import { mergeCandidates } from '../steps/mergeCandidates';
import { openCandidate } from '../steps/openCandidate';
import { openDealThread } from '../steps/openDealThread';
import { openDiscovery } from '../steps/openDiscovery';
import { promoteCandidate } from '../steps/promoteCandidate';
import { rerunDiscovery } from '../steps/rerunDiscovery';
import { setStation } from '../steps/setStation';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The deal-discovery demo, beat by beat (design phases 6 to 12). Storm Duncan
 * watches seeded synthetic mail become proposed deals with a step, a reason
 * and cited evidence; corrects them; promotes Project Kestrel into a real deal
 * under Gate 0's controls; and sees the rail's evidence marker follow late mail.
 *
 * It mutates discovery state (Harbor is merged, Kestrel is promoted), so it runs
 * in its own Playwright project after every other journey (T6), and a second run
 * needs a freshly reset stack. The replies come from the owner's recording when
 * extract.v1.json exists and from the stub otherwise (e2e/support/recording.ts):
 * beats 2, 3 and 7 assert an extracted step and carry a pending annotation
 * while only the stub exists. Assertions use rail titles and dates, never email
 * counts, because the counts come from the recorded model output.
 *
 * Between beats 4 and 6 discovery runs again from a full re-read (rerunDiscovery):
 * the merge, the step and the history must all still stand when Storm promotes.
 *
 * Beat 5 (the owner's triage confirms a tentative reply) joins in phase 7,
 * before beat 6.
 *
 * Hermetic only: it needs the seeded demo corpus and the local stack's service key.
 */
test.skip(Boolean(process.env.E2E_BASE_URL), 'needs the demo corpus from seed-discovery and a local stack');

const JOURNEY: Step[] = [
  openDiscovery, // beat 1: Kestrel, Harbor, Osprey, Falcon visible; Cobra absent
  openCandidate('Project Kestrel', {
    beat: 'beat 2',
    station: 'Diligence · Step 44 · LOI Review',
    reasonIncludes: 'LOI signed on Sep 18, 2026',
    ownExcerpt: true,
    // No colleagueRow here: every Kestrel item Storm can see is in his own mailbox. The one
    // colleague-only reply (bidq-003, Alex) is a tentative link, which beat 5 (phase 7) confirms.
  }), // beat 2
  openCandidate('Project Osprey', {
    beat: 'beat 3',
    station: 'Signing · Step 53 · Closing Checklist',
    closed: true,
  }), // beat 3
  mergeCandidates({
    merged: 'Project Harbor',
    survivor: 'Project Kestrel',
    reason: 'Client internal name for Kestrel',
  }), // beat 4
  setStation({
    candidate: 'Project Kestrel',
    station: 44,
    title: 'LOI Review',
    reason: 'LOI countersigned 18 Sep',
  }), // beat 4: history row and discovery.correction audit
  // The corrections must survive discovery running again, before the deal is promoted on them.
  rerunDiscovery({
    survivor: 'Project Kestrel',
    merged: 'Project Harbor',
    mergedSubjects: ['Project Harbor: scoping call', 'Project Harbor: financial summary', 'Project Harbor: exclusivity letter'],
    overrideStepId: 'p4-s48',
    station: 44,
    title: 'LOI Review',
    reason: 'LOI countersigned 18 Sep',
    reasonIncludes: 'LOI signed on Sep 18, 2026',
  }), // beat 4 holds after a full re-read and a re-extraction
  // beat 5 joins in phase 7, before beat 6
  promoteCandidate({
    candidate: 'Project Kestrel',
    codename: 'Project Kestrel',
    target: 'Northwind Robotics',
    station: 44,
    title: 'LOI Review',
    seq: 48,
    approver: 'Avery Lindqvist',
  }), // beat 6: receipt, rail at step 44
  openDealThread({ subject: 'Project Kestrel' }), // #339: read a deal thread, open a reply, send nothing
  importLateMail, // beat 7: child processes on the local stack
  acceptEvidenceSuggestion({ station: 47, title: 'Signing / Announcement Prep', seq: 51 }), // beat 7: cursor seq 51, advance audit
];

test('the deal-discovery demo, beat by beat', async ({ page, evidence, runId, since }, testInfo) => {
  test.slow();
  testInfo.annotations.push({ type: 'replies', description: `${repliesFile().kind}: ${repliesFile().path}` });

  const state: JourneyState = {};
  const ctx: JourneyContext = { page, evidence, runId, since, state };

  for (const step of JOURNEY) {
    await test.step(`${step.name} · act`, () => step.act(ctx));
    await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
    await test.step(`${step.name} · verify`, () => step.verify(ctx));
  }
  expect(state.dealCode, 'the journey promoted no deal').toBeTruthy();
});
