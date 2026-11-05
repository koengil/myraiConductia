import { expect, type Page } from '@playwright/test';

import { MD_EMAIL } from '../auth/session';
import { DEMO_TEAM_INBOX } from '../../scripts/discovery/lib/corpusSelect';
import { assertSeededMailPath } from '../support/mailPath';
import { escapeRegExp } from '../support/regexp';
import {
  connectNotificationCount,
  liveMailboxAddresses,
  PERSONAL_SOURCES,
  runWorkerPass,
  teamAuditRows,
  teamSourceItemIds,
  teamSourceState,
} from '../support/teamInbox';
import type { Evidence } from '../support/evidence';
import { candidateId } from './openCandidate';
import { requireEvidence, requirePage, type JourneyContext, type Step } from './types';

/**
 * The beats of the team inbox journey (#581): the firm admin connects deals@, the worker checks and reads it, the admin
 * lets Storm read it, and Storm, then no one else, sees what it found. Admin acts run on ctx.adminPage; Storm is the
 * default page; Morgan, a colleague with personal copies of some of the same mail, is read through ctx.secondEvidence.
 *
 * Mail is named by subject and a candidate by its name, never by a count: the counts come from the fixture mail.
 */

const ADDRESS = DEMO_TEAM_INBOX;
const STORM = 'Storm Duncan';
const KESTREL = 'Project Kestrel';
const OSPREY = 'Project Osprey';
/** Kestrel mail only Storm's mailbox held in the demo corpus: with no personal source for Storm, it is team-only. */
const TEAM_ONLY_SUBJECTS = ['Project Kestrel: teaser', 'Project Kestrel: LOI signed'];
/** The Kestrel message the team inbox shares with Morgan's mailbox: the mixed candidate's common ground. */
const SHARED_SUBJECT = 'Project Kestrel: data room open';
/** A day within the connect window (the last 730 days), one year back. */
const FIRST_READ = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

const asAdmin = (ctx: JourneyContext, who: string): Page => requirePage(ctx.adminPage, who);
const card = (page: Page) => page.getByRole('region', { name: 'Team inboxes', exact: true });
const inboxRow = (page: Page) => card(page).locator('li[data-team-mailbox-id]').filter({ hasText: ADDRESS });

type ListedInbox = {
  id: string;
  address: string;
  checkStatus: string;
  backfillSince: string | null;
  members: Array<{ userId: string; email: string }>;
};

/** The admin's own read of the registration, as the card reads it. */
async function listedInbox(ctx: JourneyContext, who: string): Promise<ListedInbox> {
  const res = await requireEvidence(ctx.adminEvidence, who).request.get('/api/v1/discovery/team-mailboxes');
  expect(res.status(), 'GET /api/v1/discovery/team-mailboxes').toBe(200);
  const { teamMailboxes } = (await res.json()) as { teamMailboxes: ListedInbox[] };
  const found = teamMailboxes.find((inbox) => inbox.id === ctx.state.teamMailboxId);
  expect(found, 'the admin lists the registration').toBeTruthy();
  return found as ListedInbox;
}

async function candidateNames(evidence: Evidence): Promise<string[]> {
  const res = await evidence.request.get('/api/v1/discovery/candidates');
  expect(res.status(), 'GET /api/v1/discovery/candidates').toBe(200);
  return ((await res.json()) as { candidates: Array<{ name: string }> }).candidates.map((c) => c.name);
}

async function candidateItems(evidence: Evidence, id: string): Promise<Array<{ subject: string; own: boolean }>> {
  const res = await evidence.request.get(`/api/v1/discovery/candidates/${id}`);
  expect(res.status(), `GET candidate ${id}`).toBe(200);
  return ((await res.json()) as { candidate: { items: Array<{ subject: string; own: boolean }> } }).candidate.items;
}

/** Beat 1: the admin connects deals@ with a first-read window and the firm-mailbox attestation. It reads Checking the address. */
export const connectTeamInbox: Step = {
  name: 'connectTeamInbox',

  async act(ctx) {
    // First, before anything is connected: a stack seeded with every persona (or for the Graph path) fails here, untouched.
    await assertSeededMailPath();
    expect(await liveMailboxAddresses(), 'seed the stack with --personas morgan, so Storm has no personal source').toEqual(PERSONAL_SOURCES);
    const page = asAdmin(ctx, 'connectTeamInbox');
    await page.goto('/discovery');
    await expect(card(page).getByText('No team inboxes are connected.')).toBeVisible();
    await card(page).getByLabel('Team inbox address', { exact: true }).fill(ADDRESS);
    await card(page).getByLabel('First read from (optional)', { exact: true }).fill(FIRST_READ);
    await card(page).getByRole('checkbox').check();
    await card(page).getByRole('button', { name: 'Connect team inbox' }).click();
  },

  async assertUi(ctx) {
    const row = inboxRow(asAdmin(ctx, 'connectTeamInbox'));
    await expect(row.getByText('Checking the address', { exact: true })).toBeVisible();
    await expect(row).toContainText(`first read from ${FIRST_READ}`);
    ctx.state.teamMailboxId = (await row.getAttribute('data-team-mailbox-id')) as string;
  },

  async verify(ctx) {
    const inbox = await listedInbox(ctx, 'connectTeamInbox');
    expect(inbox.checkStatus).toBe('pending');
    expect(inbox.backfillSince).toBe(FIRST_READ);
    expect(inbox.address).toBe(ADDRESS);
    // The firm's admins and its CCO are told, and the audit row names ids and fixed codes, never the address.
    expect(await connectNotificationCount(inbox.id), 'the firm admins and the CCO are notified').toBeGreaterThan(0);
    const rows = (await teamAuditRows(ctx.since)).filter((r) => r.action === 'discovery.team_mailbox_connected');
    expect(rows, 'one connect audit row').toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ teamMailboxId: inbox.id });
  },
};

/**
 * Beat 2: the worker's first pass checks the address in the (fixture) Directory, before it reads the provider group,
 * and so reads the inbox on the same pass (audit item 10). The admin reads Ready.
 */
export const workerChecksTeamInbox: Step = {
  name: 'workerChecksTeamInbox',

  async act() {
    runWorkerPass('workerChecksTeamInbox');
  },

  async assertUi(ctx) {
    const page = asAdmin(ctx, 'workerChecksTeamInbox');
    await page.reload();
    await expect(inboxRow(page).getByText('Ready', { exact: true })).toBeVisible();
  },

  async verify(ctx) {
    const inbox = await listedInbox(ctx, 'workerChecksTeamInbox');
    expect(inbox.checkStatus).toBe('verified');
    const checked = (await teamAuditRows(ctx.since)).filter((r) => r.action === 'discovery.team_mailbox_checked');
    expect(checked.map((r) => r.detail)).toEqual([{ teamMailboxId: inbox.id, status: 'verified' }]);
  },
};

/**
 * Beat 3: the worker's next pass (a delta, which starts with the profile check) leaves the inbox read through the
 * guard, its first read finished. Nothing is shown to anyone yet.
 */
export const workerReadsTeamInbox: Step = {
  name: 'workerReadsTeamInbox',

  async act() {
    runWorkerPass('workerReadsTeamInbox');
  },
  async assertUi() {},

  async verify(ctx) {
    const source = await teamSourceState(ctx.state.teamMailboxId as string);
    expect(source.lastError, 'the guard let the read through').toBeNull();
    expect(source.backfillCompleted, 'the first read finished').toBe(true);
    expect(source.heldSubjects, 'the team source holds the Kestrel mail only Storm had').toEqual(expect.arrayContaining(TEAM_ONLY_SUBJECTS));
  },
};

/** Beat 3, continued: Storm is not a member yet, so he sees no proposed deal, though the worker has read the inbox. */
export const memberSeesNothingYet: Step = {
  name: 'memberSeesNothingYet',

  async act(ctx) {
    await ctx.page.goto('/discovery');
  },

  async assertUi(ctx) {
    await expect(ctx.page.getByRole('heading', { level: 1, name: 'Proposed deals' })).toBeVisible();
    await expect(ctx.page.getByText('No proposed deals.')).toBeVisible();
  },

  async verify(ctx) {
    expect(await candidateNames(ctx.evidence), 'no personal source and no membership: no candidate').toEqual([]);
  },
};

/** Beat 4: the admin lets Storm read the inbox from the card. */
export const addTeamMember: Step = {
  name: 'addTeamMember',

  async act(ctx) {
    const row = inboxRow(asAdmin(ctx, 'addTeamMember'));
    await row.getByLabel('Add a person', { exact: true }).selectOption({ label: `${STORM} (${MD_EMAIL})` });
    await row.getByRole('button', { name: 'Add', exact: true }).click();
  },

  async assertUi(ctx) {
    const member = inboxRow(asAdmin(ctx, 'addTeamMember')).locator('[data-team-member-id]');
    await expect(member).toHaveCount(1);
    await expect(member).toContainText(STORM);
  },

  async verify(ctx) {
    const inbox = await listedInbox(ctx, 'addTeamMember');
    const storm = inbox.members.find((m) => m.email === MD_EMAIL);
    expect(storm, 'the registration lists Storm').toBeTruthy();
    ctx.state.teamMemberId = storm?.userId;
    const added = (await teamAuditRows(ctx.since)).filter((r) => r.action === 'discovery.team_mailbox_member_added');
    expect(added.map((r) => r.detail)).toEqual([{ teamMailboxId: inbox.id, userId: storm?.userId }]);
  },
};

/**
 * Beat 4, continued: Storm, now a member, sees Kestrel and Osprey with no further job, and reads the team-only Kestrel mail
 * as his own. Falcon, Harbor and Cobra are not among them: they are no team message's candidates.
 */
export const memberSeesTeamCandidates: Step = {
  name: 'memberSeesTeamCandidates',

  async act(ctx) {
    await ctx.page.goto('/discovery');
  },

  async assertUi(ctx) {
    const { page } = ctx;
    const ids: Record<string, string> = {};
    for (const name of [KESTREL, OSPREY]) {
      const heading = page.getByRole('heading', { name: new RegExp(`^${escapeRegExp(name)}$`) });
      await expect(heading).toBeVisible();
      const row = page.locator('[data-candidate-id]').filter({ has: heading });
      ids[name] = (await row.getAttribute('data-candidate-id')) as string;
    }
    for (const other of ['Project Falcon', 'Project Harbor', 'Project Cobra']) {
      await expect(page.getByRole('heading', { name: other })).toHaveCount(0);
    }
    ctx.state.candidateIds = ids;
  },

  async verify(ctx) {
    const names = await candidateNames(ctx.evidence);
    expect(names).toEqual(expect.arrayContaining([KESTREL, OSPREY]));
    for (const other of ['Project Falcon', 'Project Harbor', 'Project Cobra']) expect(names).not.toContain(other);
    const items = await candidateItems(ctx.evidence, candidateId(ctx, KESTREL));
    for (const subject of [...TEAM_ONLY_SUBJECTS, SHARED_SUBJECT]) {
      expect(items.find((i) => i.subject === subject), `${subject}: Storm reads it as a member`).toMatchObject({ own: true });
    }
  },
};

/**
 * Beat 5: Morgan holds personal copies of some of the same mail, so he sees Kestrel too, but none of the team
 * inbox's messages: the shared message is his own, the team-only ones are not in his view at all.
 */
export const colleagueSeesNoTeamMessage: Step = {
  name: 'colleagueSeesNoTeamMessage',

  async act() {},
  async assertUi() {},

  async verify(ctx) {
    const morgan = requireEvidence(ctx.secondEvidence, 'colleagueSeesNoTeamMessage');
    expect(await candidateNames(morgan), 'Morgan sees the shared candidate through his own mail').toContain(KESTREL);
    const items = await candidateItems(morgan, candidateId(ctx, KESTREL));
    const subjects = items.map((i) => i.subject);
    expect(items.find((i) => i.subject === SHARED_SUBJECT), 'the shared message is Morgan\'s own').toMatchObject({ own: true });
    for (const subject of TEAM_ONLY_SUBJECTS) expect(subjects, `${subject} is a team message Morgan is not a member for`).not.toContain(subject);
  },
};

/**
 * Beat 7: the admin removes Storm. Both team candidates are promoted by now, so the proposed list says nothing (it
 * would be empty either way); instead Storm's own read of each candidate shows no team message: it is not visible to
 * him at all (404), or it is and lists no item he reads as his own and no item the team source holds, by item id (a
 * colleague's item carries no subject, so a subject check would pass on it). His seats on the two deals give him no
 * team mail. Failures print counts, never a subject or an address.
 */
export const removeTeamMember: Step = {
  name: 'removeTeamMember',

  async act(ctx) {
    const row = inboxRow(asAdmin(ctx, 'removeTeamMember'));
    await row.getByRole('button', { name: `Remove ${STORM} from ${ADDRESS}`, exact: true }).click();
    await row.getByRole('button', { name: `Confirm removal of ${STORM} from ${ADDRESS}`, exact: true }).click();
  },

  async assertUi(ctx) {
    await expect(inboxRow(asAdmin(ctx, 'removeTeamMember')).locator('[data-team-member-id]')).toHaveCount(0);
    await ctx.page.goto('/discovery');
    await expect(ctx.page.getByRole('heading', { level: 1, name: 'Proposed deals' })).toBeVisible();
    await expect(ctx.page.getByText('No proposed deals.')).toBeVisible();
  },

  async verify(ctx) {
    const inbox = await listedInbox(ctx, 'removeTeamMember');
    expect(inbox.members.length, 'members left on the registration').toBe(0);
    const teamItems = new Set(await teamSourceItemIds(inbox.id));
    expect(teamItems.size, 'the team source holds items, so the check below is not vacuous').toBeGreaterThan(0);
    for (const name of [KESTREL, OSPREY]) {
      const res = await ctx.evidence.request.get(`/api/v1/discovery/candidates/${candidateId(ctx, name)}`);
      expect([200, 404], `${name}: Storm's read once removed`).toContain(res.status());
      if (res.status() === 404) continue;
      const { items } = ((await res.json()) as { candidate: { items: Array<{ sourceItemId: string; own: boolean }> } }).candidate;
      expect(items.filter((i) => i.own).length, `${name}: items Storm reads as his own once removed`).toBe(0);
      expect(items.filter((i) => teamItems.has(i.sourceItemId)).length, `${name}: team source items Storm sees once removed`).toBe(0);
    }
    const rows = await teamAuditRows(ctx.since);
    const removed = rows.filter((r) => r.action === 'discovery.team_mailbox_member_removed');
    expect(removed.length, 'member_removed audit rows').toBe(1);
    expect(removed[0].detail).toMatchObject({ teamMailboxId: inbox.id, userId: ctx.state.teamMemberId });
    // Every audit row about the team inbox carries ids and fixed codes only: no address, no name.
    const naming = rows.filter((row) => /@|deals/i.test(JSON.stringify(row.detail))).map((row) => row.action);
    expect(naming, 'team inbox audit actions whose detail names an address').toEqual([]);
  },
};
