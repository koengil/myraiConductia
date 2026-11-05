import { request as playwrightRequest } from '@playwright/test';

import { ADMIN_STATE_PATH, CCO_EMAIL, IB_DIRECTOR_EMAIL, seededStorageState } from '../auth/session';
import { newCollectedContext } from '../support/cspViolations';
import { Evidence } from '../support/evidence';
import { expect, test } from '../support/fixtures';
import { devAuditChainLength, devAuditRowsSince } from '../support/teamInbox';
import { promoteCandidate } from '../steps/promoteCandidate';
import {
  addTeamMember,
  colleagueSeesNoTeamMessage,
  connectTeamInbox,
  memberSeesNothingYet,
  memberSeesTeamCandidates,
  removeTeamMember,
  workerChecksTeamInbox,
  workerReadsTeamInbox,
} from '../steps/teamInbox';
import {
  assessmentsKeepInviteOnly,
  ccoSeesTheFlow,
  dealsSitAtTheirPhases,
  knownGapWitnesses,
} from '../steps/teamInboxOversight';
import type { JourneyContext, JourneyState, Step } from '../steps/types';

/**
 * The admin-managed team inbox, beat by beat (#581, phase 12): the Oct 30 story, "connect an Ignatious team inbox,
 * find the deals, place a phase on each", offline.
 *
 *   1  the firm admin connects deals@ with a first-read window: Checking the address
 *   2  the worker checks the address in the (fixture) Directory and, the check done before the group, reads it: Ready
 *   3  a second pass leaves the inbox read through the mailbox guard; Storm, not yet a member, sees nothing
 *   4  the admin lets Storm read it; Storm sees Kestrel and Osprey, and reads the team-only Kestrel mail
 *   5  Morgan, who holds personal copies of some of that mail, sees Kestrel but none of the team's messages
 *   6  Storm promotes Kestrel and Osprey and places each at a phase (the entry step), as a member of the inbox;
 *      a fresh load of each deal reads Phase 4 and Phase 5 (#173)
 *      the assessments stay invite-only: Morgan and Storm resolve every evidence id they are shown
 *      the CCO sees the connect and both deals in the bell and on each deal's Audit Trail, on a verified chain
 *      the gaps verified up front (G-03, G-05) keep their witnesses, as known-gap annotations (G-04 has none)
 *   7  the admin removes Storm; he reads no team message on either candidate
 *
 * Phases are placed by promotion: model proposals are owner-scoped until a team inbox has its own (the runbook). The
 * mail is the demo Gmail twin read by the real worker in fixture mode (no credential, no network).
 *
 * It mutates discovery state (a team inbox is connected, Kestrel and Osprey are promoted), so it runs in its own Playwright
 * project on its own reset stack, seeded for the Gmail replay with Morgan alone (see playwright.config.ts):
 *
 *   seed-discovery --google-replay --corpus demo --phase seeded --personas morgan
 *
 * Storm has no personal source, so everything he sees comes from his membership. Hermetic only. Under the #173
 * rehearsal (scripts/rehearsal/rehearse.sh e2e sets REHEARSAL_STACK) every helper that reaches the database or spawns
 * a script refuses any stack but w9-m365cap (e2e/support/discoveryProcess.ts).
 */
test.skip(Boolean(process.env.E2E_BASE_URL), 'needs the seeded Gmail replay stack and its service key');

const JOURNEY: Step[] = [
  connectTeamInbox, // beat 1
  workerChecksTeamInbox, // beat 2
  workerReadsTeamInbox, // beat 3: a second pass (delta) leaves the read as the first pass made it
  memberSeesNothingYet, // beat 3
  addTeamMember, // beat 4
  memberSeesTeamCandidates, // beat 4
  colleagueSeesNoTeamMessage, // beat 5
  promoteCandidate({
    candidate: 'Project Kestrel',
    codename: 'Project Kestrel',
    target: 'Northwind Robotics',
    station: 44,
    title: 'LOI Review',
    seq: 48,
    approver: 'Avery Lindqvist',
  }), // beat 6: a member promotes a candidate whose evidence is team mail
  promoteCandidate({
    candidate: 'Project Osprey',
    codename: 'Project Osprey',
    target: 'Fairhaven Marine',
    station: 53,
    title: 'Closing Checklist',
    seq: 57,
    approver: 'Avery Lindqvist',
  }), // beat 6: the second team deal, at a later phase
  // Literals from src/lib/rail/railData.generated.ts (p4-s48 LOI Review, p5-s57 Closing Checklist), never derived.
  dealsSitAtTheirPhases([
    { deal: 'Project Kestrel', phase: 4, seq: 48 },
    { deal: 'Project Osprey', phase: 5, seq: 57 },
  ]),
  assessmentsKeepInviteOnly, // beat 6: read as Morgan and as Storm, while Storm is still a member
  ccoSeesTheFlow, // beat 6: what compliance sees
  knownGapWitnesses, // G-03, G-05
  removeTeamMember, // beat 7
];

test('the team inbox demo, beat by beat', async ({ page, evidence, runId, since, browser, baseURL }, testInfo) => {
  test.slow();

  // The firm admin and Morgan each get their own context: neither session's cookies can leak into Storm's page.
  // Playwright films only the contexts it creates, so the admin's page records its own video: the connect, the
  // check and the member grant happen there, and Storm's video alone would miss them.
  const adminContext = await newCollectedContext(browser, {
    storageState: ADMIN_STATE_PATH,
    baseURL,
    recordVideo: { dir: testInfo.outputPath('admin-video'), size: { width: 1280, height: 720 } },
  });
  const adminPage = await adminContext.newPage();
  const adminApi = await playwrightRequest.newContext({ baseURL, storageState: ADMIN_STATE_PATH });
  const morganApi = await playwrightRequest.newContext({
    baseURL,
    storageState: await seededStorageState(IB_DIRECTOR_EMAIL, baseURL),
  });
  // The CCO's page films the compliance beat, as the admin's films the connect.
  const ccoState = await seededStorageState(CCO_EMAIL, baseURL);
  const ccoContext = await newCollectedContext(browser, {
    storageState: ccoState,
    baseURL,
    recordVideo: { dir: testInfo.outputPath('cco-video'), size: { width: 1280, height: 720 } },
  });
  const ccoPage = await ccoContext.newPage();
  const ccoApi = await playwrightRequest.newContext({ baseURL, storageState: ccoState });

  const state: JourneyState = {};
  const ctx: JourneyContext = {
    page,
    evidence,
    adminPage,
    adminEvidence: new Evidence(adminApi),
    secondEvidence: new Evidence(morganApi),
    ccoPage,
    ccoEvidence: new Evidence(ccoApi),
    runId,
    since,
    state,
  };

  try {
    // The dev tenant's chain before the journey writes anything: its verified length first, then the rows already at
    // or after `since`. ccoSeesTheFlow counts the rows first and reads the chain last, so every row it counts was
    // written between the two chain reads: a healthy chain always covers them.
    const chained = devAuditChainLength('the team inbox journey');
    state.auditChainBefore = { chained, sinceRows: await devAuditRowsSince(since) };

    for (const step of JOURNEY) {
      await test.step(`${step.name} · act`, () => step.act(ctx));
      await test.step(`${step.name} · assertUi`, () => step.assertUi(ctx));
      await test.step(`${step.name} · verify`, () => step.verify(ctx));
    }
    expect(state.teamMailboxId, 'the journey connected no team inbox').toBeTruthy();
    expect(state.dealCode, 'the journey promoted no deal').toBeTruthy();
    expect(Object.keys(state.promotedDeals ?? {}).sort(), 'the journey promoted both team deals').toEqual(['Project Kestrel', 'Project Osprey']);
  } finally {
    await ccoApi.dispose();
    await morganApi.dispose();
    await adminApi.dispose();
    await ccoContext.close();
    await adminContext.close();
    for (const [name, filmed] of [['admin video', adminPage], ['cco video', ccoPage]] as const) {
      const video = filmed.video();
      if (video) await testInfo.attach(name, { path: await video.path(), contentType: 'video/webm' });
    }
  }
});
