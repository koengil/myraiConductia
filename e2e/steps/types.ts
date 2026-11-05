import type { BrowserContext, Page } from '@playwright/test';
import type { Evidence } from '../support/evidence';
import type { NavigationWatch } from '../support/navigationWatch';

export type StorageStateJar = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Everything a later step needs from an earlier one. */
export type JourneyState = {
  leadName?: string;
  leadCompanyId?: string;
  /** The `{company}` body of the 201 from POST /api/v1/companies (registerLead*). */
  registeredCompany?: { id: string; name: string; type: string };
  /** The firm colleague chosen from the lead relationship combobox. */
  relationshipPersonName?: string;
  /** The target-side stakeholder added on the lead's maps. */
  stakeholderName?: string;
  dealCode?: string;
  dealCodename?: string;
  dealId?: string;
  auditEventIds?: string[];
  auditRowTexts?: string[];
  auditVisibleCount?: number;
  documentName?: string;
  dealFolderDocumentName?: string;
  dealFolderDocumentId?: string;
  auditIdsBeforeOpen?: string[];
  downloadFilename?: string;
  mailSubject?: string;
  stepSeqBefore?: number;
  /** The rail's "N of M · Phase P" readout text captured before advancing. */
  railReadoutBefore?: string;
  /** The bank-internal colleague queued as a Gate 0 chip (step 2). */
  colleagueEmail?: string;
  /** The external director invited from Team (step 3). */
  directorEmail?: string;
  recipientEmail?: string;
  /** The director's invite row id, from GET /api/v1/invites. */
  inviteId?: string;
  /** The Supabase action link, read out of the stub inbox (step 4). */
  inviteAcceptUrl?: string;
  /** The six-digit challenge, read out of the stub inbox (step 4). */
  inviteVerificationCode?: string;
  /** The base32 TOTP secret read off /two-factor (step 6). */
  mfaSecret?: string;
  /** The disclosure phase the inviter confirmed, carried to the granted seat. */
  inviteePhase?: number;
  /** The invite row superseded by a resend or a revoke. */
  previousInviteId?: string;
  /** The action link delivered before the current one. */
  previousInviteAcceptUrl?: string;
  /** The six-digit challenge delivered before the current one. */
  previousInviteVerificationCode?: string;
  /** The seeded bank member seated on the deal by grantMemberSeat. */
  memberEmail?: string;
  memberId?: string;
  memberName?: string;
  /** The deal MD's own roster name, for the someone-else's-step assertions. */
  mdName?: string;
  /** The MD's own name and mandate target, read from /api/v1/me. */
  mdFullName?: string;
  /** The second identity's cookie jar, captured before it signs out. */
  preSignOutState?: StorageStateJar;
  /** The company whose employee access the permission journey moves. */
  companyId?: string;
  /** The non-director employee whose permissions are requested and revoked. */
  employeeUserId?: string;
  employeeEmail?: string;
  employeeName?: string;
  manualStepWork?: string;
  stepDocumentName?: string;
  completedStepTitle?: string;
  skippedStepTitle?: string;
  skipApprover?: string;
  skipReason?: string;
  /** Deal discovery: each proposed deal's candidate id by its name, read off /discovery. */
  candidateIds?: Record<string, string>;
  /** The team inbox the admin connected (team-inbox journey), and the colleague the admin let read it. */
  teamMailboxId?: string;
  teamMemberId?: string;
  /** Every deal promoteCandidate opened, its code by the candidate's name (dealCode holds the latest only). */
  promotedDeals?: Record<string, string>;
  /**
   * The dev tenant's audit chain before the journey wrote anything: its verified length, and how many of its rows
   * were already at or after `since`. ccoSeesTheFlow measures the chain's growth against it.
   */
  auditChainBefore?: { chained: number; sinceRows: number };
};

export type JourneyContext = {
  page: Page;
  evidence: Evidence;
  runId: string;
  /** Lower bound for every audit assertion in this run. */
  since: string;
  state: JourneyState;
  /**
   * The firm admin's page. Present only for journeys that perform a
   * company-management act; the MD spine never sets it.
   */
  adminPage?: Page;
  adminEvidence?: Evidence;
  /**
   * The invitee's page — a context with NO storage state. Its session comes
   * entirely from the real acceptance path, which is the point.
   */
  inviteePage?: Page;
  /**
   * A seeded bank member's page. Present only for journeys that assert what a
   * non-MD may do on a step; the MD spine never sets it.
   */
  memberPage?: Page;
  memberEvidence?: Evidence;
  /**
   * A context with NO storage state, for the signed-out perimeter.
   */
  anonymousPage?: Page;
  /**
   * A second seeded identity, so an assertion that the profile is not fixture
   * data cannot pass vacuously against the fixture persona's own account.
   */
  secondPage?: Page;
  secondEvidence?: Evidence;
  externalPage?: Page;
  externalEvidence?: Evidence;
  /**
   * The firm's CCO, an overseer with no seat on the deals. Present only for the team inbox journey, which shows
   * the flow to compliance.
   */
  ccoPage?: Page;
  ccoEvidence?: Evidence;
  /**
   * A seated employee who holds less than the director does. Their page stays
   * open across the director's decisions, which is what the live-propagation
   * journey proves.
   */
  employeePage?: Page;
  employeeEvidence?: Evidence;
  employeeNav?: NavigationWatch;
};

/**
 * Narrows an optional context field to a live value or throws.
 *
 * A step that instead wrote `if (!page) return;` inside assertUi() or
 * verify() would make a mis-wired context (the wrong journey, a forgotten
 * ctx field) pass vacuously rather than fail: an assertion function that
 * returns early without asserting anything is indistinguishable, to the test
 * runner, from one that asserted successfully. Throwing here converts that
 * silent pass into a loud, attributable failure at the point of use.
 */
export function requirePage(page: Page | undefined, step: string): Page {
  if (!page) throw new Error(`${step} requires this context's page`);
  return page;
}

/** Same rationale as requirePage, for the request-context evidence fields. */
export function requireEvidence(evidence: Evidence | undefined, step: string): Evidence {
  if (!evidence) throw new Error(`${step} requires this context's evidence`);
  return evidence;
}

/** Same rationale as requirePage, for the navigation watch. */
export function requireNav(nav: NavigationWatch | undefined, step: string): NavigationWatch {
  if (!nav) throw new Error(`${step} requires this context's navigation watch`);
  return nav;
}

/**
 * A journey is an ordered list of steps. Each step's verify() runs only after
 * its assertUi() passes, so a failure reports the earliest true cause rather
 * than a cascade.
 */
export type Step = {
  name: string;
  act(ctx: JourneyContext): Promise<void>;
  assertUi(ctx: JourneyContext): Promise<void>;
  verify(ctx: JourneyContext): Promise<void>;
};
