import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '@/lib/constants/tables';

import { DEMO_TEAM_INBOX } from '../../scripts/discovery/lib/corpusSelect';
import { IB_DIRECTOR_EMAIL, MD_EMAIL } from '../auth/session';
import { extractDemoMail } from '../support/discoveryProcess';
import type { Evidence } from '../support/evidence';
import { devAuditChainLength, devAuditRowsSince, personaClient } from '../support/teamInbox';
import { zoomIntoCurrentStep } from '../support/rail';
import { candidateId } from './openCandidate';
import { requireEvidence, requirePage, type JourneyContext, type Step } from './types';

/**
 * The team inbox journey after the promotions (#173 slice 2): both team deals sit at the phases Storm placed them in,
 * the stage assessments stay invite-only, the CCO sees the flow, and the gaps verified up front keep their witnesses.
 * Every beat fails the journey on a miss. Only knownGapWitnesses annotates, and only for a gap whose witness passed:
 * when a gap is fixed its witness goes red, so the fix is noticed and the annotation goes with it.
 *
 * Deals are named by their candidate ("Project Kestrel") and found in state.promotedDeals. Phases and steps are
 * literals reviewed once against src/lib/rail/railData.generated.ts; nothing here derives them (no phaseForStep()).
 */

/** The phases by number, as the zoom bar names them (literals, like the steps above). */
const PHASE_SHORT_NAME: Record<number, string> = {
  1: 'Origination',
  2: 'Preparation',
  3: 'Marketing',
  4: 'Diligence',
  5: 'Signing',
};

const KESTREL = 'Project Kestrel';
const OSPREY = 'Project Osprey';
const TEAM_DEALS = [KESTREL, OSPREY] as const;
/** serverAudit.ts labels of the promotion's deal-scoped rows, as the Audit Trail renders them. */
const AUDIT_LABELS = ['Created the mandate', 'Promoted a candidate to this deal'];
/** src/lib/notifications/eventLabels.ts. */
const MAILBOX_CONNECTED_LABEL = 'Mailbox connected';
const DEAL_CREATED_LABEL = 'New mandate opened';

type CcoNotification = { event_type: string; payload: Record<string, unknown> | null; created_at: string };

function dealCode(ctx: JourneyContext, deal: string): string {
  const code = ctx.state.promotedDeals?.[deal];
  if (!code) throw new Error(`${deal} was not promoted earlier in this journey`);
  return code;
}

const asCco = (ctx: JourneyContext, who: string): Page => requirePage(ctx.ccoPage, who);
const ccoApi = (ctx: JourneyContext, who: string): Evidence => requireEvidence(ctx.ccoEvidence, who);

/** The CCO's own notifications written since the run began (GET /api/v1/notifications, newest first). */
async function ccoNotificationsSince(ctx: JourneyContext, who: string): Promise<CcoNotification[]> {
  const res = await ccoApi(ctx, who).request.get('/api/v1/notifications');
  expect(res.status(), 'GET /api/v1/notifications as the CCO').toBe(200);
  const { notifications } = (await res.json()) as { notifications: CcoNotification[] };
  return notifications.filter((n) => n.created_at >= ctx.since);
}

/**
 * A deal's place on the rail, as the MD reads it and as the database holds it. Each deal opens on a fresh page, so the
 * readout comes from a load of the deal, not from the promotion's receipt. The zoomed-in step's zoom-out control
 * must name the phase, and the deal's current_step_seq must equal the step's seq.
 */
export function dealsSitAtTheirPhases(deals: ReadonlyArray<{ deal: string; phase: number; seq: number }>): Step {
  const pages = new Map<string, Page>();
  return {
    name: 'dealsSitAtTheirPhases',

    async act(ctx) {
      for (const { deal } of deals) {
        const page = await ctx.page.context().newPage();
        pages.set(deal, page);
        await page.goto(`/projects/${encodeURIComponent(dealCode(ctx, deal))}/rail`);
      }
    },

    async assertUi() {
      try {
        for (const { deal, phase } of deals) {
          const page = pages.get(deal) as Page;
          const detail = await zoomIntoCurrentStep(page);
          const name = PHASE_SHORT_NAME[phase];
          await expect(detail.getByRole('button', { name: `Zoom out to ${name}` }), `${deal} sits in ${name}`).toBeVisible();
        }
      } finally {
        for (const page of pages.values()) await page.close();
        pages.clear();
      }
    },

    async verify(ctx) {
      for (const { deal, seq } of deals) {
        const { deal: row } = await ctx.evidence.getDeal(dealCode(ctx, deal));
        expect(row.current_step_seq, `${deal} sits at seq ${seq}`).toBe(seq);
      }
    },
  };
}

type AssessmentTally = { assessments: number; evidenceIds: number; unresolved: number };

/**
 * One persona's read of a candidate's stage assessments, under their own session: how many they see, how many distinct
 * evidence event ids those name, and how many of the ids the same session cannot resolve through milestone_events.
 * Counts only: no reason text, no event type.
 */
async function assessmentTally(db: SupabaseClient, candidate: string): Promise<AssessmentTally> {
  const assessed = await db.from(TABLE.STAGE_ASSESSMENTS).select('evidence_event_ids').eq('candidate_id', candidate);
  expect(assessed.error, 'read the stage assessments under the persona session').toBeNull();
  const rows = (assessed.data ?? []) as Array<{ evidence_event_ids: string[] | null }>;
  const ids = [...new Set(rows.flatMap((r) => r.evidence_event_ids ?? []))];
  let resolved = 0;
  if (ids.length > 0) {
    const events = await db.from(TABLE.MILESTONE_EVENTS).select('id').in('id', ids);
    expect(events.error, 'resolve the evidence events under the persona session').toBeNull();
    resolved = new Set(((events.data ?? []) as Array<{ id: string }>).map((e) => e.id)).size;
  }
  return { assessments: rows.length, evidenceIds: ids.length, unresolved: ids.length - resolved };
}

/**
 * Invite-only (owner, 2026-10-19): an assessment a person can read must not point at evidence they cannot read. The
 * extraction runs (guarded, on the recorded replies), then Morgan, who holds personal copies, and Storm, still a member
 * of the team inbox, each read both deals' assessments and resolve every evidence id in the same session. One id that
 * does not resolve is a leak and fails the journey. Storm must see at least one assessment with evidence, so the check
 * is never vacuous.
 */
export const assessmentsKeepInviteOnly: Step = {
  name: 'assessmentsKeepInviteOnly',

  async act() {
    extractDemoMail('assessmentsKeepInviteOnly');
  },
  async assertUi() {},

  async verify(ctx) {
    // Named by role, so the recorded counts can be copied into the gap list as they are (it names roles, never people).
    const sessions = [
      ['colleague', await personaClient('assessmentsKeepInviteOnly', IB_DIRECTOR_EMAIL)],
      ['md', await personaClient('assessmentsKeepInviteOnly', MD_EMAIL)],
    ] as const;
    const counts: string[] = [];
    let stormEvidence = 0;
    for (const [who, db] of sessions) {
      for (const deal of TEAM_DEALS) {
        const tally = await assessmentTally(db, candidateId(ctx, deal));
        expect(tally.unresolved, `${who} reads an assessment of ${deal} whose evidence they cannot read`).toBe(0);
        if (who === 'md') stormEvidence += tally.evidenceIds;
        counts.push(`${who} ${deal.replace('Project ', '').toLowerCase()} assessments=${tally.assessments} ids=${tally.evidenceIds} unresolved=${tally.unresolved}`);
      }
    }
    expect(stormEvidence, 'the extraction left Storm no assessment evidence to check').toBeGreaterThan(0);
    test.info().annotations.push({ type: 'invite-only', description: counts.join('; ') });
  },
};

/**
 * What compliance sees. The CCO's bell holds the connect once and a new mandate for each deal; both deals' Audit Trail
 * shows the promotion's rows; and every audit row of the run is on the dev tenant's verified hash chain: the chain grew
 * by at least the rows written since the journey began, and none of them is unchained.
 */
export const ccoSeesTheFlow: Step = {
  name: 'ccoSeesTheFlow',

  async act(ctx) {
    await asCco(ctx, 'ccoSeesTheFlow').goto(`/projects/${encodeURIComponent(dealCode(ctx, KESTREL))}/audit`);
  },

  async assertUi(ctx) {
    const page = asCco(ctx, 'ccoSeesTheFlow');
    for (const deal of TEAM_DEALS) {
      if (deal !== KESTREL) await page.goto(`/projects/${encodeURIComponent(dealCode(ctx, deal))}/audit`);
      const register = page.getByRole('region', { name: 'Audit Trail' });
      for (const label of AUDIT_LABELS) {
        await expect(register.getByText(label).first(), `${deal}: ${label}`).toBeVisible();
      }
    }
    await page.getByRole('button', { name: /^Notifications(, \d+ unread)?$/ }).click();
    const rows = page.getByRole('dialog', { name: 'Notifications' }).getByRole('listitem');
    // Counted in the page, so a failure prints the count, never the address a locator filter would name.
    const connectRows = () =>
      rows
        .filter({ hasText: MAILBOX_CONNECTED_LABEL })
        .evaluateAll((items, address) => items.filter((item) => item.textContent?.includes(address)).length, DEMO_TEAM_INBOX);
    await expect.poll(connectRows, { message: 'the connect, once' }).toBe(1);
    for (const deal of TEAM_DEALS) {
      // The bell names the deal by its codename ("Project Kestrel · <actor>"), never its code; verify reads the code.
      await expect(rows.filter({ hasText: DEAL_CREATED_LABEL }).filter({ hasText: `${deal} · ` }), `${deal}: a new mandate`).toHaveCount(1);
    }
    await page.keyboard.press('Escape');
  },

  async verify(ctx) {
    const notes = await ccoNotificationsSince(ctx, 'ccoSeesTheFlow');
    const connects = notes.filter((n) => n.event_type === 'mailbox_connected' && n.payload?.teamMailboxId === ctx.state.teamMailboxId);
    expect(connects.length, 'the CCO is told of the connect once').toBe(1);
    for (const deal of TEAM_DEALS) {
      const code = dealCode(ctx, deal);
      const created = notes.filter((n) => n.event_type === 'deal_created' && n.payload?.code === code);
      expect(created.length, `the CCO is told of ${deal} once`).toBe(1);
    }

    const before = ctx.state.auditChainBefore;
    if (!before) throw new Error('ccoSeesTheFlow needs the chain baseline the journey takes before its first beat');
    // Counted before the chain is read: a row written in between can only lengthen the chain, never this count.
    const written = (await devAuditRowsSince(ctx.since)) - before.sinceRows;
    const grown = devAuditChainLength('ccoSeesTheFlow') - before.chained;
    expect(written, 'the journey wrote audit rows').toBeGreaterThan(0);
    expect(grown, 'every audit row of the run is on the verified chain').toBeGreaterThanOrEqual(written);
    expect(await devAuditRowsSince(ctx.since, { unchained: true }), 'no audit row of the run is unchained').toBe(0);
  },
};

/**
 * The gaps verified before the rehearsal, each with a witness that passes while the gap holds (design R6):
 *   G-03  the firm-level team inbox audit rows reach no UI: Kestrel's trail, read by the CCO, holds none of them
 *   G-05  a team inbox that holds mail cannot be disconnected: the admin's Remove answers 409 not_removable
 * Each passing witness adds a known-gap annotation; a failing one fails the journey. G-04 (a Directory refusal
 * notifies no one) has no witness: this journey drives no Directory refusal, so "no other notification kind" would
 * pass whether or not the gap holds. The gap list carries it, not witnessed.
 */
export const knownGapWitnesses: Step = {
  name: 'knownGapWitnesses',

  async act() {},
  async assertUi() {},

  async verify(ctx) {
    const gaps = test.info().annotations;

    const { events } = await ccoApi(ctx, 'knownGapWitnesses').listAudit(dealCode(ctx, KESTREL));
    const teamRows = events.filter((e) => e.action.startsWith('discovery.team_mailbox_'));
    expect(teamRows.length, 'G-03 witness: team inbox rows on the deal trail').toBe(0);
    gaps.push({ type: 'known-gap', description: 'G-03: the team inbox audit rows have no UI (0 on the deal trail)' });

    const admin = requireEvidence(ctx.adminEvidence, 'knownGapWitnesses');
    const res = await admin.request.delete(`/api/v1/discovery/team-mailboxes/${ctx.state.teamMailboxId as string}`);
    expect(res.status(), 'G-05 witness: Remove of a team inbox that holds mail').toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe('not_removable');
    gaps.push({ type: 'known-gap', description: 'G-05: no disconnect for a team inbox that holds mail (409 not_removable)' });
  },
};
