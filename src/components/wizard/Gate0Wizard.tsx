'use client';

import * as React from 'react';

import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { SmartLookupCard } from '@/components/onboarding/SmartLookupCard';
import { getApi } from '@/lib/api';
import type { TeamMember } from '@/lib/api/types';
import { logAudit } from '@/lib/audit/store';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { useFlag } from '@/lib/flags/FlagsContext';
import { searchCompanies } from '@/lib/companies/directory';
import { useLeadCatalog } from '@/lib/leads/useLeadCatalog';
import { prefetchLeadCatalog } from '@/lib/leads/leadCatalog';
import {
  COMPANY_ROLE,
  DEAL_ROLE,
  DEAL_ROLE_LABELS,
  DEPARTMENT_LABELS,
  type Department,
  INTERNAL_ASSIGNABLE_DEAL_ROLES,
  resolvePreferredDealRole,
  type DealRole,
} from '@/lib/constants/roles';
import {
  addInvite,
  applyCreateResult,
  INVITE_DEAL_ROLES,
  INVITE_STATE_LABELS,
  markCreating,
  removeInvite,
  type InviteChip,
  type InviteCreateResult,
  type InviteDealRole,
} from '@/components/wizard/inviteQueue';
import { Button } from '@/components/atoms/Button';
import { EntryStepSelect, entryStepLabel } from '@/components/deals/EntryStepSelect';
import { RailTemplatePicker } from '@/components/wizard/RailTemplatePicker';
import {
  RailTemplateRequestError,
  readRailTemplate,
  readTemplateCreation,
  resumeTemplateCreation,
} from '@/lib/railTemplates/client';
import type { TemplateSelection } from '@/lib/railTemplates/types';
import { DEFAULT_PROJECT_ID } from '@/lib/project/resolveProjectId';
import {
  MVP_DEAL_RAIL,
  firstStepAfterGate0,
  orderedSteps,
} from '@/lib/rail/dealRail';
import {
  FIXTURE_GATE0_NOTIFY_RECIPIENTS,
  MISSING_CCO_LABEL,
  GATE0_STEP_IDS,
  type Gate0NotifyRecipient,
} from '@/lib/rail/gate0';
import { ribbonStatus } from '@/components/rail/railRunState';
import { stashGate0Receipt } from '@/lib/deals/gate0Receipt';
import { useSession } from '@/lib/session/store';

/** A bank colleague from GET /api/v1/companies/{bankId}/members (wall-filtered
 *  server-side: research/trading and external users are never returned). */
type RosterMember = {
  id: string;
  full_name: string;
  display_name: string | null;
  email: string;
  department: string | null;
  firm_role: string | null;
  company_role: string | null;
  preferred_deal_role: string | null;
};
import type { CodenameThemeProposal } from '@/lib/gate0/codenameTypes';
import {
  codenameMasksCompany,
  createDeal,
  DEALS_EVENT,
  type SearchableCompany,
} from '@/lib/rail/deals';
import { preflightInvite } from '@/lib/team/invitePreflight';
import { TRY_AGAIN_COPY } from '@/components/deals/DealsUnavailable';

/**
 * Gate0Wizard — the mandate intake gate (develop-design vision spec §4.3).
 *
 * Five sub-steps mirroring the ledger's GATE0_ACTIONS plus the Seq 6 conflicts
 * approval, in the flow order the spec sets: code name (mask validation +
 * deterministic suggestions, the same logic as the pre-mandate insight flow) →
 * conflicts approval (the senior-partner attestation that the firm is allowed to
 * pursue the mandate: approver + date + confirmation, recorded to the audit log)
 * → team & permissions (role checklist from the fixture personas) → notify
 * compliance (the tenant CCO, by name; create_deal_gate0 fans the notice) →
 * lifecycle entry point (the MVP rail only, pick the entering
 * step; the first execution-rail step by default, and the Gate 0 steps
 * and the pre-project New Business Development steps are not offered).
 *
 * Completing the gate writes a FixtureDeal (localStorage; the POST
 * /api/v1/deals swap stays mechanical) with `gate0Complete: true` and the
 * chosen `entryStepSeq`, then lands on the Rail at the entry step.
 *
 * Accent discipline: everything is token-driven so the conductor can re-skin
 * values at integration. `--accent` is the single accent (primary actions,
 * selection, focus); the sub-step 3 receipt uses the positive/compliance
 * tokens; everything else stays on neutral inks and hairlines. Serif step
 * titles.
 */

type WizardStepKey = 'codename' | 'conflicts' | 'team' | 'notify' | 'entry';

type WizardStep = {
  key: WizardStepKey;
  /** Short stepper label. */
  short: string;
  /** Serif step title. */
  title: string;
  /** The plain name of the Gate 0 action this sub-step mirrors (the
   *  stepper's title and the section's accessible name). */
  action: string;
};

// GATE0_ACTIONS (ledger order, src/lib/rail/dealRail): [0] assign a team ·
// [1] create a code name · [2] notify compliance and management · [3] confirm
// the lifecycle entry. The ledger's wording ("Assign a team (select team
// members/permissions)") is not user copy, so each sub-step names its action
// in plain sentence case.
// The wizard runs them in the spec's flow order — code name first, so every
// later artifact (attestation, membership, notification) is minted under the
// mask. The conflicts approval (Seq 6, "are we allowed to have a deal with
// this company?") sits between code name and team: it gates everything after
// it, and recording it after the code name files the record under the mask.

const WIZARD_STEPS: readonly WizardStep[] = [
  {
    key: 'codename',
    short: 'Code name',
    title: 'Create the code name',
    action: 'Create the code name',
  },
  {
    key: 'conflicts',
    short: 'Conflicts',
    title: 'Record the conflicts approval',
    action: "Record the senior partner's conflicts approval",
  },
  {
    key: 'team',
    short: 'Team',
    title: 'Assign the team',
    action: 'Assign the deal team',
  },
  {
    key: 'notify',
    short: 'Notify',
    title: 'Notify Compliance',
    action: 'Notify Compliance and management',
  },
  {
    key: 'entry',
    short: 'Entry point',
    title: 'Confirm the lifecycle entry point',
    action: 'Confirm where the deal enters the rail',
  },
];

/** What each deal role does, in one plain line: never permission slugs. */
const DEAL_ROLE_DUTY: Record<DealRole, string> = {
  [DEAL_ROLE.MD]: 'Runs the deal and signs off.',
  [DEAL_ROLE.DEAL_TEAM]: 'Works the deal day to day.',
  [DEAL_ROLE.LEGAL]: 'Reviews the documents and agreements.',
  [DEAL_ROLE.READ_ONLY]: 'Sees the deal and changes nothing.',
  [DEAL_ROLE.SELLER]: 'The seller, outside the firm.',
  [DEAL_ROLE.BUYER]: 'A buyer, outside the firm.',
};

/** A department code as its sentence-case name ("ib" → "Investment banking"). */
function departmentName(code: string): string {
  const label = DEPARTMENT_LABELS[code as Department];
  if (!label) return code;
  return label.charAt(0) + label.slice(1).toLowerCase();
}

/** Wizard sub-steps rendered in the modal: all five, the entry point last. */
const VISIBLE_WIZARD_STEPS = WIZARD_STEPS;

/** The steps a deal can enter at: everything after the Gate 0 steps (04 onward). */
const ENTRY_STEPS = orderedSteps(MVP_DEAL_RAIL).slice(GATE0_STEP_IDS.length);

/** Map a POST /api/v1/deals failure to a decisive, MD-facing message. No
 *  em-dashes in visible copy (brand voice). */
function errorMessageFor(status: number): string {
  switch (status) {
    case 422:
      return 'The code name must not contain the target name. Rename it and try again.';
    case 409:
      return 'That code name is already in use on a live deal. Pick another.';
    case 400:
      return 'The mandate details are incomplete. Review and try again.';
    case 401:
      return 'Your session expired. Sign in again to create the mandate.';
    case 403:
      return 'You are not permitted to create deals. Ask a director to grant Create deals.';
    case 503:
      return 'The service is unavailable right now. Try again shortly.';
    default:
      return status >= 500
        ? 'Something went wrong creating the mandate. Try again.'
        : 'The mandate could not be created. Review the details and try again.';
  }
}

const STALE_RAIL_TEXT =
  'This saved rail changed. Review the updated rail and try again.';
const UNIDENTIFIED_TEXT =
  'Conductia has not confirmed your identity yet. Try again in a moment.';
const PENDING_MANDATE_TEXT =
  'This mandate was submitted and is still open. Resume it to finish, or abandon it and start over.';
const PENDING_INVITES_TEXT =
  'Queued invitations were not restored. Invite anyone remaining from Team once the mandate opens.';
const RESUMING_TEXT = 'Finishing this mandate.';
const NETWORK_TEXT = 'Network error. Check your connection and try again.';

type PendingCommand = {
  requestId: string;
  codename: string;
  railName: string | null;
  recovered: boolean;
};

type TemplateFailureBody = {
  error?: string;
  code?: string;
} | null;

function railTemplateCreationKey(actorId: string): string {
  return `rail-template-create:${actorId}`;
}

function readPendingCreation(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePendingCreation(key: string, requestId: string): void {
  try {
    window.sessionStorage.setItem(key, requestId);
  } catch {
    return;
  }
}

function clearPendingCreation(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    return;
  }
}

function commandIsGone(status: number, code?: string | null): boolean {
  return status === 404 || status === 403 || code === 'codename_taken';
}

function complianceVerdictOf(
  value: string | undefined,
): 'compliant' | 'hold' | 'blocked' {
  return value === 'hold' || value === 'blocked' ? value : 'compliant';
}

/**
 * Fire one queued invitation against POST /api/v1/invites and digest the
 * response into the pure queue's InviteCreateResult. Runs only after the deal
 * create succeeded (the invite needs the real deal id). Bank-internal seats
 * only; companyRole is always 'member' from this surface.
 */
async function postQueuedInvite(
  chip: InviteChip,
  companyId: string,
  dealId: string,
): Promise<InviteCreateResult> {
  try {
    const preflight = await preflightInvite({
      email: chip.email,
      companyId,
      companyRole: COMPANY_ROLE.MEMBER,
      dealId,
      dealRole: chip.role,
    });
    if (preflight.kind === 'error') {
      return {
        kind: 'error',
        message:
          preflight.message ??
          (preflight.status ? `Domain check failed (${preflight.status})` : 'The email-domain check returned an invalid response.'),
      };
    }
    if (preflight.kind === 'confirm' && !chip.domainConfirmation) {
      return { kind: 'error', message: 'The email-domain decision must be confirmed again.' };
    }
    if (
      preflight.kind === 'confirm' &&
      preflight.classification !== chip.domainConfirmation?.classification
    ) {
      return { kind: 'error', message: 'The email-domain classification changed.' };
    }
    const res = await fetch('/api/v1/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: chip.email,
        companyId,
        companyRole: COMPANY_ROLE.MEMBER,
        dealId,
        dealRole: chip.role,
        confirmationId: preflight.kind === 'confirm' ? preflight.id : undefined,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      invite?: { id: string; deliveryStatus?: string };
      existingUser?: { id: string; accessGranted?: boolean };
      error?: string;
      inviteId?: string;
    };
    if (res.status === 201 && body.invite) {
      return {
        kind: 'created',
        inviteId: body.invite.id,
        deliveryStatus: body.invite.deliveryStatus === 'sent' ? 'sent' : 'unsent',
      };
    }
    if (res.status === 200 && body.existingUser) {
      return {
        kind: 'existing',
        accessGranted: body.existingUser.accessGranted === true,
      };
    }
    if (res.status === 409) {
      return { kind: 'duplicate', inviteId: body.inviteId };
    }
    return {
      kind: 'error',
      message: typeof body.error === 'string' ? body.error : undefined,
    };
  } catch {
    return { kind: 'error' };
  }
}

/** Local calendar date as YYYY-MM-DD (never UTC — `toISOString()` would pin an
 *  MD east of UTC to yesterday's date in the morning). */
function localDateIso(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Fixture permission line per persona role — the "permissions" half of the
 *  team checklist. Illustrative; the real grant is a deal_memberships row. */
const ROLE_PERMISSIONS: Record<TeamMember['role'], string> = {
  MD: 'Owner. Approvals and external sign-off.',
  CFO: 'Financials. Valuation and data room folders.',
  'M&A Advisor': 'Process. Buyer outreach and trackers.',
  VP: 'Runs the workstream. Materials and buyer list.',
  Associate: 'Execution. Models, trackers, and Q&A.',
  Analyst: 'Support. Research, comps, and updates.',
};

/**
 * LeadTypeahead — Gate 0 step 1's lead selector (Task 3). A project is created
 * by SELECTING an existing lead, never by typing a free-text name, so the
 * codename mask check and the deal's target link are both anchored to a real
 * company row. Source mirrors the wizard's existing flag split (the `team`
 * sub-step below): flag-on searches the real in-tenant leads
 * (`GET /api/v1/companies?type=client`); flag-off searches the fixture company
 * directory (`src/lib/companies/directory.ts`), same as the rest of the demo
 * flow.
 */
function LeadTypeahead({
  apiCreateEnabled,
  value,
  onChange,
}: {
  apiCreateEnabled: boolean;
  value: SearchableCompany | null;
  onChange: (company: SearchableCompany | null) => void;
}) {
  const [query, setQuery] = React.useState('');
  // Flag-off: the fixture directory search is synchronous, so it is derived
  // directly (no effect / setState-in-effect needed).
  const localOptions = React.useMemo(
    () =>
      apiCreateEnabled || value
        ? []
        : searchCompanies(query).map((c) => ({ id: c.id, name: c.name, sector: c.sector })),
    [apiCreateEnabled, query, value],
  );
  // Flag-on: leads come from the prefetched tenant catalog (see leadCatalog.ts).
  const leadCatalog = useLeadCatalog();
  const catalogLeads = leadCatalog.status === 'ready' ? leadCatalog.leads : [];
  const catalogLoading =
    apiCreateEnabled &&
    !value &&
    (leadCatalog.status === 'idle' || leadCatalog.status === 'loading');
  const catalogError = apiCreateEnabled && !value && leadCatalog.status === 'error';

  React.useEffect(() => {
    if (apiCreateEnabled && !value) void prefetchLeadCatalog();
  }, [apiCreateEnabled, value]);

  const remoteOptions = React.useMemo(() => {
    if (!apiCreateEnabled) return [];
    const q = query.trim().toLowerCase();
    if (!q) return catalogLeads;
    return catalogLeads.filter((c) => c.name.toLowerCase().includes(q));
  }, [apiCreateEnabled, catalogLeads, query]);

  const options = apiCreateEnabled ? remoteOptions : localOptions;

  if (value) {
    return (
      <div className="flex max-w-[360px] flex-col gap-1">
        <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
          Lead
        </span>
        <div className="flex items-center justify-between gap-[var(--space-2)] rounded-[var(--radius-input)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)]">
          <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
            {value.name}
          </span>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              onChange(null);
            }}
            className="text-[length:var(--text-xs)] font-medium text-[var(--accent-dark)] underline underline-offset-4 hover:opacity-80"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-[360px] flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
          Lead
        </span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a registered lead…"
          className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] outline-none focus:ring-2 focus:ring-[var(--ink)]"
        />
      </label>
      {catalogLoading ? (
        <p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          <span
            aria-hidden="true"
            className="size-3 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]"
          />
          Loading leads…
        </p>
      ) : options.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Matching companies"
          className="flex max-h-52 flex-col gap-1 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-1 shadow-[var(--shadow-ambient)]"
        >
          {options.map((opt) => (
            <li key={opt.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => onChange(opt)}
                className="w-full rounded-[var(--radius-button)] px-[var(--space-2)] py-1 text-left text-[length:var(--text-sm)] text-[var(--ink)] hover:bg-[var(--surface-subtle)]"
              >
                {opt.name}
              </button>
            </li>
          ))}
        </ul>
      ) : catalogError ? (
        <p className="text-[length:var(--text-xs)] text-[var(--negative)]">
          Could not load leads. Try again.
        </p>
      ) : query.trim() ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          No {apiCreateEnabled ? 'lead' : 'company'} matches &ldquo;{query.trim()}&rdquo;.
          {apiCreateEnabled ? ' Register it on the Leads page first.' : ''}
        </p>
      ) : apiCreateEnabled ? (
        <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          No leads registered yet. Add one on the Leads page first, then it appears here.
        </p>
      ) : null}
    </div>
  );
}

export interface Gate0WizardProps {
  /** Called when the user backs out of the gate (dialog close). */
  onCancel?: () => void;
  /**
   * Called once the deal is created and the router has been sent to the new
   * rail. The host closes the dialog here: the wizard lives in the persistent
   * shell, so a client navigation does NOT unmount it — without this it would
   * stay stuck on "Creating…" over the new deal.
   */
  onComplete?: () => void;
}

export function Gate0Wizard({ onCancel, onComplete }: Gate0WizardProps) {
  const router = useRouter();
  const apiCreateEnabled = useFlag('gate0_api_create');
  const onboardingEnabled = useFlag('platform_onboarding');
  // Invite-by-email needs BOTH: the invite lifecycle (platform_onboarding) and
  // a real created deal to attach to (gate0_api_create). Either flag off keeps
  // today's behavior exactly.
  const inviteByEmailEnabled = apiCreateEnabled && onboardingEnabled;
  const savedRailsFlag = useFlag('rail_templates');
  const projectRailFlag = useFlag('project_rail_model');
  const railTemplatesEnabled =
    apiCreateEnabled && savedRailsFlag && projectRailFlag;
  const { dispatch } = useSession();
  const [stepIndex, setStepIndex] = React.useState(0);

  // --- Sub-step 1 · lead selection + code name (reuses the insight flow's
  // mask logic) — Task 3: the target is SELECTED from an existing lead, never
  // typed free-text. ----------------------------------------------------------
  const [selectedCompany, setSelectedCompany] = React.useState<SearchableCompany | null>(null);
  const [codename, setCodename] = React.useState('');
  const [themeProposals, setThemeProposals] = React.useState<CodenameThemeProposal[]>([]);
  const [selectedThemeIndex, setSelectedThemeIndex] = React.useState(0);
  const [suggestSource, setSuggestSource] = React.useState<'llm' | 'fallback' | null>(
    null,
  );
  const [suggestError, setSuggestError] = React.useState<string | null>(null);
  const [suggestStatus, setSuggestStatus] = React.useState<
    'idle' | 'loading' | 'ready'
  >('idle');

  const selectedTheme = themeProposals[selectedThemeIndex];
  const suggestions = selectedTheme?.suggestions ?? [];
  const codenameTheme = selectedTheme?.label ?? '';
  const hasGeneratedThemes = themeProposals.length > 0;
  const generationSeq = React.useRef(0);

  const applyCodenameThemes = React.useCallback(
    (themes: CodenameThemeProposal[], source: 'llm' | 'fallback') => {
      setThemeProposals(themes);
      setSelectedThemeIndex(0);
      setCodename(themes[0]?.suggestions[0] ?? '');
      setSuggestSource(source);
      setSuggestStatus('ready');
    },
    [],
  );

  const fetchCodenameThemes = React.useCallback(
    async (company: SearchableCompany, offset: number, seq: number) => {
      setSuggestStatus('loading');
      setSuggestError(null);

      try {
        const res = await fetch('/api/v1/codenames/suggest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            companyId: company.id,
            name: company.name,
            sector: company.sector || 'Private company',
            offset,
          }),
        });
        if (seq !== generationSeq.current) return;
        if (!res.ok) {
          setSuggestStatus('ready');
          setSuggestError('Could not generate themes. Try again.');
          return;
        }
        const data = (await res.json()) as {
          themes?: CodenameThemeProposal[];
          source?: 'llm' | 'fallback';
        };
        if (seq !== generationSeq.current) return;
        if (data.themes?.length) {
          applyCodenameThemes(data.themes, data.source === 'llm' ? 'llm' : 'fallback');
          return;
        }
        setSuggestStatus('ready');
        setSuggestError('Could not generate themes. Try again.');
      } catch {
        if (seq !== generationSeq.current) return;
        setSuggestStatus('ready');
        setSuggestError('Could not generate themes. Try again.');
      }
    },
    [applyCodenameThemes],
  );

  React.useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- codename state resets when lead selection changes */
    if (!selectedCompany) {
      generationSeq.current += 1;
      setCodename('');
      setThemeProposals([]);
      setSelectedThemeIndex(0);
      setSuggestSource(null);
      setSuggestError(null);
      setSuggestStatus('idle');
      return;
    }

    generationSeq.current += 1;
    const seq = generationSeq.current;
    setCodename('');
    setThemeProposals([]);
    setSelectedThemeIndex(0);
    setSuggestSource(null);
    setSuggestError(null);
    void fetchCodenameThemes(selectedCompany, 0, seq);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedCompany, fetchCodenameThemes]);

  async function regenerateCodenames() {
    if (!selectedCompany || suggestStatus === 'loading') return;
    const offset = Math.floor(Math.random() * 100) + 1;
    generationSeq.current += 1;
    const seq = generationSeq.current;
    await fetchCodenameThemes(selectedCompany, offset, seq);
  }

  function selectTheme(index: number) {
    setSelectedThemeIndex(index);
    const next = themeProposals[index]?.suggestions[0];
    if (next) setCodename(next);
  }
  const hasTarget = selectedCompany !== null;
  const masks = selectedCompany ? codenameMasksCompany(codename, selectedCompany) : true;
  const codenameValid = hasTarget && codename.trim().length > 0 && masks;

  // --- Sub-step 2 · conflicts approval (Seq 6 attestation) ------------------
  // The check runs off-platform today (deliberately human-led); the wizard
  // records the attestation — approver + date + confirmation — and the create
  // writes it to the deal and the append-only audit log. No expiry, but the
  // date is recorded so a staleness policy can be layered on later.
  const [conflictsApprover, setConflictsApprover] = React.useState('');
  // The approver field is a custom combobox (a native <datalist> popup
  // mispositions inside this dialog), so it owns its own open state.
  const [approverListOpen, setApproverListOpen] = React.useState(false);
  const [conflictsDate, setConflictsDate] = React.useState(() => localDateIso());
  // COMPLIANCE: the attestation answers "are we allowed to have a deal with
  // THIS company?" The confirmation is keyed to the company it was given for,
  // so going Back and changing the target voids it by construction; approver +
  // date persist, the checkbox must be re-affirmed for the new target.
  const [attestedForCompanyId, setAttestedForCompanyId] = React.useState<
    string | null
  >(null);
  const conflictsAttested = attestedForCompanyId === selectedCompany?.id;
  const todayIso = localDateIso();
  const conflictsValid =
    conflictsApprover.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(conflictsDate) &&
    conflictsDate <= todayIso &&
    conflictsAttested;

  // --- Sub-step 3 · team & permissions (fixture personas via the seam) -----
  const [team, setTeam] = React.useState<TeamMember[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    let cancelled = false;
    // The new mandate has no deal yet — propose the sandbox deal team as the
    // default roster (the MD edits from here).
    void getApi()
      .getTeam(DEFAULT_PROJECT_ID)
      .then((members) => {
        if (cancelled) return;
        setTeam(members);
        // The full fixture team is the proposed default; the MD stays locked.
        setSelected(new Set(members.map((m) => m.id)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const mdId = team.find((m) => m.role === 'MD')?.id;

  function toggleMember(id: string) {
    if (id === mdId) return; // the logged-in MD is always on the deal
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // --- Sub-step 3 (flag on) · the real bank roster from the platform spine ---
  // Locked seat = the authenticated creator (not fixture Storm); colleagues are
  // opt-in with a deal_role selector. Fixture path above stays for flag-off.
  const { state: currentUserState } = useCurrentUser();
  const creator =
    currentUserState.status === 'ready' ? currentUserState.data.user : null;
  const [roster, setRoster] = React.useState<RosterMember[]>([]);
  // Roster load status — an empty roster and a failed fetch must be distinct so
  // the MD never sees "no colleagues" when the load actually errored. 'idle'
  // doubles as in-flight (before the async fetch resolves); only the async
  // callbacks below move it to 'ready'/'error' (no synchronous set-in-effect).
  const [rosterStatus, setRosterStatus] = React.useState<
    'idle' | 'ready' | 'error'
  >('idle');
  // userId -> chosen deal role. Presence in the map = selected onto the deal.
  const [memberRoles, setMemberRoles] = React.useState<Record<string, DealRole>>(
    {},
  );

  React.useEffect(() => {
    if (!apiCreateEnabled) return;
    const bankId = creator?.company_id;
    if (!bankId) return;
    let cancelled = false;

    // The roster is the gating fetch (a failure is a real error). Each role
    // reads as one plain line (DEAL_ROLE_DUTY), so no permission list is read.
    void fetch(`/api/v1/companies/${bankId}/members`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`roster: ${r.status}`);
        return (await r.json()) as { members?: RosterMember[] };
      })
      .then((membersRes) => {
        if (cancelled) return;
        setRoster(membersRes.members ?? []);
        setRosterStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setRoster([]);
        setRosterStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [apiCreateEnabled, creator?.company_id]);

  function toggleRealMember(id: string) {
    if (id === creator?.id) return; // the creator is the locked MD seat
    const preferred = onboardingEnabled
      ? resolvePreferredDealRole(roster.find((member) => member.id === id)?.preferred_deal_role)
      : null;
    setMemberRoles((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = preferred ?? DEAL_ROLE.DEAL_TEAM;
      return next;
    });
  }

  function setRealMemberRole(id: string, role: DealRole) {
    setMemberRoles((prev) => (prev[id] ? { ...prev, [id]: role } : prev));
  }

  function rosterDisplayName(member: RosterMember): string {
    return member.display_name || member.full_name || member.email;
  }

  const [liveNotifyOfficers, setLiveNotifyOfficers] = React.useState<
    Gate0NotifyRecipient[] | null
  >(null);
  // A failed lookup is not "no CCO" (#250): it gets its own message and a
  // retry. Create stays blocked because the recipients are unknown.
  const [notifyLoadFailed, setNotifyLoadFailed] = React.useState(false);
  const [notifyAttempt, setNotifyAttempt] = React.useState(0);
  const notifyOfficers = apiCreateEnabled
    ? liveNotifyOfficers
    : [...FIXTURE_GATE0_NOTIFY_RECIPIENTS];

  React.useEffect(() => {
    if (!apiCreateEnabled) return;
    const bankId = creator?.company_id;
    if (!bankId) return;
    let cancelled = false;
    void fetch(`/api/v1/companies/${bankId}/notify-recipients`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`notify-recipients: ${r.status}`);
        return (await r.json()) as { recipients?: Gate0NotifyRecipient[] };
      })
      .then((body) => {
        if (!cancelled) setLiveNotifyOfficers(body.recipients ?? []);
      })
      .catch(() => {
        if (!cancelled) setNotifyLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiCreateEnabled, creator?.company_id, notifyAttempt]);

  // --- Sub-step 3 (platform_onboarding on) · invite by email ----------------
  // Bank-internal colleagues who are not on the platform yet. The deal does
  // not exist until create succeeds, so invitations queue locally as chips and
  // fire against POST /api/v1/invites inside complete(), after the create
  // returns the deal id. Transitions live in the pure inviteQueue module.
  const [inviteQueue, setInviteQueue] = React.useState<InviteChip[]>([]);
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<InviteDealRole>(
    DEAL_ROLE.DEAL_TEAM,
  );
  const [inviteFormError, setInviteFormError] = React.useState<string | null>(
    null,
  );
  const [inviteDomainDecision, setInviteDomainDecision] = React.useState<{
    id: string;
    classification: 'mismatch' | 'personal' | 'unverified';
    expiresAt: string;
    snapshot: string;
  } | null>(null);
  const [checkingInvite, setCheckingInvite] = React.useState(false);

  async function queueInvite() {
    const bankId = creator?.company_id;
    if (!bankId) {
      setInviteFormError('Your company could not be resolved.');
      return;
    }
    const snapshot = JSON.stringify({
      email: inviteEmail.trim().toLowerCase(),
      role: inviteRole,
      companyId: bankId,
    });
    setCheckingInvite(true);
    setInviteFormError(null);
    try {
      let decision = inviteDomainDecision?.snapshot === snapshot ? inviteDomainDecision : null;
      if (!decision) {
        const preflight = await preflightInvite({
          email: inviteEmail,
          companyId: bankId,
          companyRole: COMPANY_ROLE.MEMBER,
        });
        if (preflight.kind === 'error') {
          setInviteFormError(
            preflight.message ??
              (preflight.status
                ? `Domain check failed (${preflight.status})`
                : 'The email-domain check returned an invalid response.'),
          );
          return;
        }
        if (preflight.kind === 'confirm') {
          decision = {
            id: preflight.id,
            classification: preflight.classification,
            expiresAt: preflight.expiresAt,
            snapshot,
          };
          setInviteDomainDecision(decision);
          return;
        }
      }

      const result = addInvite(
        inviteQueue,
        inviteEmail,
        inviteRole,
        decision
          ? {
              id: decision.id,
              classification: decision.classification,
              expiresAt: decision.expiresAt,
            }
          : undefined,
      );
      if (!result.ok) {
        setInviteFormError(result.error);
        return;
      }
      setInviteQueue(result.queue);
      setInviteEmail('');
      setInviteDomainDecision(null);
    } catch {
      setInviteFormError('The email-domain check failed. Try again.');
    } finally {
      setCheckingInvite(false);
    }
  }

  // --- Completion ------------------------------------------------------------
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [railTemplate, setRailTemplate] =
    React.useState<TemplateSelection | null>(null);
  const [pickerNonce, setPickerNonce] = React.useState(0);
  const [pendingCommand, setPendingCommand] =
    React.useState<PendingCommand | null>(null);
  const [resuming, setResuming] = React.useState(false);
  const [recoveryNonce, setRecoveryNonce] = React.useState(0);
  const chosenRail = railTemplatesEnabled ? railTemplate : null;
  const defaultEntrySeq = firstStepAfterGate0()?.seq ?? 8;
  const [entrySeq, setEntrySeq] = React.useState(defaultEntrySeq);
  const actorId = creator?.id ?? null;
  const creationKey =
    actorId === null ? null : railTemplateCreationKey(actorId);

  React.useEffect(() => {
    if (!railTemplatesEnabled || creationKey === null) return;
    const requestId = readPendingCreation(creationKey);
    if (requestId === null) return;
    let active = true;
    void (async () => {
      try {
        const view = await readTemplateCreation(requestId);
        if (!active) return;
        const railName = await readRailTemplate(view.selection.templateId)
          .then((template) => template.name)
          .catch(() => null);
        if (!active) return;
        setPendingCommand({
          requestId,
          codename: view.input.codename,
          railName,
          recovered: true,
        });
      } catch (failure) {
        if (!active) return;
        const gone =
          failure instanceof RailTemplateRequestError &&
          commandIsGone(failure.status);
        if (gone) clearPendingCreation(creationKey);
      }
    })();
    return () => {
      active = false;
    };
  }, [railTemplatesEnabled, creationKey, recoveryNonce]);

  function abandonPending() {
    if (creationKey !== null) clearPendingCreation(creationKey);
    setPendingCommand(null);
    setError(null);
  }

  async function resumePending() {
    if (pendingCommand === null || resuming) return;
    setResuming(true);
    setError(null);
    try {
      const receipt = await resumeTemplateCreation(pendingCommand.requestId);
      const verdict = complianceVerdictOf(receipt.screening?.verdict);
      dispatch({ type: 'SET_COMPLIANCE', status: ribbonStatus(verdict) });
      stashGate0Receipt(receipt.deal.code, {
        verdict,
        recipients: receipt.notified?.length ?? 0,
        at: receipt.notified?.[0]?.at ?? null,
      });
      if (creationKey !== null) clearPendingCreation(creationKey);
      setPendingCommand(null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(DEALS_EVENT));
      }
      router.push(`/projects/${receipt.deal.code}/rail?new=1`);
      onComplete?.();
    } catch (failure) {
      const known = failure instanceof RailTemplateRequestError ? failure : null;
      if (known !== null && commandIsGone(known.status, known.code)) {
        if (creationKey !== null) clearPendingCreation(creationKey);
        setPendingCommand(null);
      }
      setError(known === null ? NETWORK_TEXT : known.message);
      setResuming(false);
    }
  }

  function failTemplateCreate(status: number, body: TemplateFailureBody) {
    const coded = typeof body?.code === 'string';
    const message = body?.error?.trim() ?? '';
    if (body?.code === 'stale_template') {
      setRailTemplate(null);
      setPickerNonce((value) => value + 1);
      setStepIndex(0);
      if (creationKey !== null) clearPendingCreation(creationKey);
      setPendingCommand(null);
      setError(STALE_RAIL_TEXT);
      return;
    }
    if (body?.code === 'idempotency_conflict') {
      setRecoveryNonce((value) => value + 1);
    } else if (commandIsGone(status, body?.code)) {
      if (creationKey !== null) clearPendingCreation(creationKey);
      setPendingCommand(null);
    }
    const decisive = coded || /notify/i.test(message);
    setError(decisive && message ? message : errorMessageFor(status));
  }

  const step = VISIBLE_WIZARD_STEPS[stepIndex];
  const isLast = stepIndex === VISIBLE_WIZARD_STEPS.length - 1;
  // A saved rail opens at its own first step and the server ignores the
  // choice, so the request carries the default rather than a stale selection.
  const postGate0EntrySeq = chosenRail !== null ? defaultEntrySeq : entrySeq;
  const entryStep = ENTRY_STEPS.find((s) => s.seq === postGate0EntrySeq);
  // Roster names matching the current approver text (case-insensitive), for the
  // "Approved by" combobox suggestions. Empty text matches the whole roster.
  const approverQuery = conflictsApprover.trim().toLowerCase();
  const approverMatches = roster.filter((member) =>
    rosterDisplayName(member).toLowerCase().includes(approverQuery),
  );
  const notifyBlocksCreate =
    apiCreateEnabled &&
    Boolean(creator?.company_id) &&
    (notifyOfficers === null || notifyOfficers.length === 0);

  // Notify blocks Next while no one will receive the notice, so the reason
  // it shows sits beside the blocked button rather than a bare disabled
  // Create two sub-steps later.
  const canAdvance =
    step.key === 'codename'
      ? codenameValid
      : step.key === 'conflicts'
        ? conflictsValid
        : step.key === 'notify'
          ? !notifyBlocksCreate
          : true;

  function next() {
    if (!canAdvance) return;
    setStepIndex((i) => Math.min(i + 1, VISIBLE_WIZARD_STEPS.length - 1));
  }

  function back() {
    setStepIndex((i) => Math.max(i - 1, 0));
  }

  async function complete() {
    if (creating || !codenameValid || !selectedCompany || !conflictsValid) return;
    if (notifyBlocksCreate) return;
    if (chosenRail !== null && creationKey === null) {
      setError(UNIDENTIFIED_TEXT);
      return;
    }
    setCreating(true);
    setError(null);
    const selectedTeam = team
      .filter((m) => selected.has(m.id))
      .map((m) => ({ id: m.id, role: m.role }));
    const conflictsAttestation = {
      approvedBy: conflictsApprover.trim(),
      approvedOn: conflictsDate,
    };
    const creatorName =
      currentUserState.status === 'ready'
        ? currentUserState.data.user.display_name ||
          currentUserState.data.user.full_name ||
          'Storm Duncan'
        : 'Storm Duncan';

    if (!apiCreateEnabled) {
      // Fixture path (flag off): unchanged demo behavior — persist locally and
      // land on the rail at the code-name slug. The mandate opens clean, so the
      // shell ribbon goes green (spec §4.3). The attestation is recorded to the
      // demo audit store (the API path writes it to the real audit_log).
      const deal = createDeal(selectedCompany, codename, {
        entryStepSeq: postGate0EntrySeq,
        gate0Complete: true,
        team: selectedTeam,
        conflictsAttestation,
        createdBy: creatorName,
      });
      logAudit(
        'platform',
        'Recorded conflicts approval',
        `Approved by ${conflictsAttestation.approvedBy} on ${conflictsAttestation.approvedOn}`,
        { deal: deal.codename },
      );
      dispatch({ type: 'SET_COMPLIANCE', status: 'clear' });
      router.push(`/projects/${deal.id}/rail?new=1`);
      onComplete?.();
      return;
    }

    // Flag on: the real transactional create via the platform spine. The
    // creator is seated as MD server-side from the session; the selected
    // colleagues ride along as members (the creator is excluded — the RPC seats
    // them). COMPLIANCE: the URL carries the deal CODE, never the target name.
    const members = Object.entries(memberRoles)
      .filter(([id]) => id !== creator?.id)
      .map(([userId, dealRole]) => ({ userId, dealRole }));
    try {
      // Refresh every queued decision before the irreversible deal create. A
      // changed classification requires an explicit review instead of silently
      // sending with stale consent.
      let confirmedInviteQueue = inviteQueue;
      if (inviteByEmailEnabled && inviteQueue.length > 0 && creator?.company_id) {
        for (const chip of inviteQueue) {
          const preflight = await preflightInvite({
            email: chip.email,
            companyId: creator.company_id,
            companyRole: COMPANY_ROLE.MEMBER,
          });
          if (preflight.kind === 'error' && preflight.status !== null) {
            setError(preflight.message ?? 'An invitation email-domain check failed.');
            setCreating(false);
            return;
          }
          if (
            preflight.kind === 'error' ||
            (preflight.kind === 'confirm' &&
              preflight.classification !== chip.domainConfirmation?.classification)
          ) {
            setError(
              `Review the email-domain decision for ${chip.email} before opening the mandate.`,
            );
            setCreating(false);
            return;
          }
          confirmedInviteQueue = confirmedInviteQueue.map((candidate) =>
            candidate.email === chip.email
              ? {
                  ...candidate,
                  domainConfirmation:
                    preflight.kind === 'confirm'
                      ? {
                          id: preflight.id,
                          classification: preflight.classification,
                          expiresAt: preflight.expiresAt,
                        }
                      : undefined,
                }
              : candidate,
          );
        }
        setInviteQueue(confirmedInviteQueue);
      }
      let templateFields: {
        requestId?: string;
        railTemplate?: TemplateSelection;
      } = {};
      if (chosenRail !== null && creationKey !== null) {
        const templateRequestId =
          pendingCommand?.requestId ??
          readPendingCreation(creationKey) ??
          crypto.randomUUID();
        writePendingCreation(creationKey, templateRequestId);
        setPendingCommand({
          requestId: templateRequestId,
          codename: codename.trim(),
          railName: null,
          recovered: false,
        });
        templateFields = {
          requestId: templateRequestId,
          railTemplate: chosenRail,
        };
      }
      const res = await fetch('/api/v1/deals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          codename: codename.trim(),
          codenameTheme,
          targetCompanyId: selectedCompany.id,
          entryStepSeq: postGate0EntrySeq,
          members,
          conflictsAttestation,
          ...templateFields,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as TemplateFailureBody;
        if (chosenRail !== null) {
          failTemplateCreate(res.status, body);
          setCreating(false);
          return;
        }
        const apiError = body?.error?.trim() ?? '';
        setError(/notify/i.test(apiError) ? apiError : errorMessageFor(res.status));
        setCreating(false);
        return;
      }
      const data = (await res.json()) as {
        deal: { id: string; code: string };
        notified?: Array<{ userId: string; at: string }>;
        screening?: { verdict: 'compliant' | 'hold' | 'blocked' };
      };
      const verdict = data.screening?.verdict ?? 'compliant';
      // Honest receipt: drive the shell ribbon from the verdict the server
      // actually returned (the MNPI screen that really ran), not a fabricated
      // pass.
      dispatch({ type: 'SET_COMPLIANCE', status: ribbonStatus(verdict) });
      // Queued email invitations fire NOW: after the create succeeded (the
      // invite rows need the real deal id) and before the close, so the
      // close-on-success contract (#112) still holds and no invite is lost to
      // the unmount. A failed invite never fails the mandate; the per-invite
      // delivery outcome rides the receipt below and the retry path is the
      // deal's Team.
      let inviteOutcomes = confirmedInviteQueue;
      if (inviteByEmailEnabled && confirmedInviteQueue.length > 0 && creator?.company_id) {
        const bankId = creator.company_id;
        for (const chip of confirmedInviteQueue) {
          if (chip.state !== 'queued') continue;
          inviteOutcomes = markCreating(inviteOutcomes, chip.email);
          setInviteQueue(inviteOutcomes);
          const result = await postQueuedInvite(chip, bankId, data.deal.id);
          inviteOutcomes = applyCreateResult(inviteOutcomes, chip.email, result);
          setInviteQueue(inviteOutcomes);
        }
      }
      // Hand the real receipt (screen verdict + who was notified, when + the
      // invite delivery outcomes) to the rail landing, which renders it on
      // ?new=1 (G20). The creator isn't a notification recipient, so this is
      // the only honest source for them.
      stashGate0Receipt(data.deal.code, {
        verdict,
        recipients: data.notified?.length ?? 0,
        at: data.notified?.[0]?.at ?? null,
        ...(inviteOutcomes.length > 0
          ? {
              invites: inviteOutcomes.map((chip) => ({
                email: chip.email,
                state: chip.state,
              })),
            }
          : {}),
      });
      if (creationKey !== null) clearPendingCreation(creationKey);
      setPendingCommand(null);
      // Let the deal-list surfaces (sidebar, command center) refetch so the new
      // deal appears without a page reload (useDeals listens for DEALS_EVENT).
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(DEALS_EVENT));
      }
      router.push(`/projects/${data.deal.code}/rail?new=1`);
      onComplete?.();
    } catch {
      setError(NETWORK_TEXT);
      setCreating(false);
    }
  }

  const recoveredCommand =
    pendingCommand !== null && pendingCommand.recovered ? pendingCommand : null;

  if (recoveredCommand !== null) {
    return (
      <div aria-label="Gate 0 wizard" className="flex flex-col gap-[var(--space-4)]">
        <PendingMandate
          codename={recoveredCommand.codename}
          railName={recoveredCommand.railName}
          busy={resuming}
          onResume={() => void resumePending()}
          onAbandon={abandonPending}
        />
        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-input)] bg-[var(--negative-fill)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div aria-label="Gate 0 wizard" className="flex flex-col gap-[var(--space-4)]">
      {/* Header + stepper */}
      <header>
        <ol
          aria-label="Gate 0 progress"
          className="flex flex-wrap items-center gap-[var(--space-2)]"
        >
          {VISIBLE_WIZARD_STEPS.map((s, i) => {
            const done = i < stepIndex;
            const active = i === stepIndex;
            return (
              <li
                key={s.key}
                title={s.action}
                aria-current={active ? 'step' : undefined}
                className="flex items-center gap-[var(--space-2)]"
              >
                <span
                  aria-hidden="true"
                  className={[
                    'flex size-5 items-center justify-center rounded-full font-mono text-[10px] font-semibold',
                    active
                      ? 'bg-[var(--ink)] text-white'
                      : done
                        ? 'bg-[var(--positive-fill)] text-[var(--positive-deep)]'
                        : 'bg-[var(--surface-subtle)] text-[var(--ink-tertiary)]',
                  ].join(' ')}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span
                  className={[
                    'text-[length:var(--text-xs)] font-medium',
                    active
                      ? 'text-[var(--ink)]'
                      : done
                        ? 'text-[var(--ink-secondary)]'
                        : 'text-[var(--ink-tertiary)]',
                  ].join(' ')}
                >
                  {s.short}
                </span>
                {i < VISIBLE_WIZARD_STEPS.length - 1 ? (
                  <span aria-hidden="true" className="h-px w-4 bg-[var(--stroke)]" />
                ) : null}
              </li>
            );
          })}
        </ol>
      </header>

      {/* Active sub-step */}
      <section aria-label={step.action}>
        <h2 className="text-[length:var(--text-lg)] font-semibold tracking-tight text-[var(--ink)]">
          {step.title}
        </h2>

        <div className="mt-[var(--space-3)]">
          {step.key === 'codename' ? (
            <div className="flex flex-col gap-[var(--space-3)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                The code name masks the target across every external
                communication, so it cannot contain the target&rsquo;s name.
              </p>
              <LeadTypeahead
                apiCreateEnabled={apiCreateEnabled}
                value={selectedCompany}
                onChange={setSelectedCompany}
              />
              {hasTarget ? (
                <>
              <div className="flex max-w-[360px] flex-col gap-1">
                <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                  Code name
                </span>
                <div className="flex gap-[var(--space-2)]">
                  <input
                    type="text"
                    value={codename}
                    onChange={(e) => setCodename(e.target.value)}
                    aria-invalid={!masks}
                    aria-label="Code name"
                    placeholder="Project Meridian"
                    className={[
                      'min-w-0 flex-1 rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] font-mono text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] outline-none',
                      masks
                        ? 'focus:ring-2 focus:ring-[var(--ink)]'
                        : 'ring-2 ring-[var(--negative)] focus:ring-offset-2 focus:ring-offset-[var(--surface)]',
                    ].join(' ')}
                  />
                  <button
                    type="button"
                    onClick={() => void regenerateCodenames()}
                    disabled={suggestStatus === 'loading' || !hasGeneratedThemes}
                    className="inline-flex shrink-0 items-center gap-[var(--space-1)] rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Sparkles
                      size={16}
                      strokeWidth={1.75}
                      aria-hidden="true"
                      className="text-[var(--ai)]"
                    />
                    {suggestStatus === 'loading' ? 'Generating…' : 'Regenerate'}
                  </button>
                </div>
              </div>
              {!masks ? (
                <p className="text-[length:var(--text-xs)] text-[var(--negative)]">
                  The code name cannot contain the target&rsquo;s name. Pick a
                  suggestion below or rename it.
                </p>
              ) : null}
              {suggestError ? (
                <p className="text-[length:var(--text-xs)] text-[var(--negative)]">
                  {suggestError}
                </p>
              ) : null}
              {hasGeneratedThemes ? (
                <>
              <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {suggestSource === 'llm'
                  ? 'Themes inspired by the lead\u2019s sector.'
                  : 'Standard themes. AI was unavailable for this request.'}
              </p>
              <div className="mb-[var(--space-2)] flex flex-wrap items-center gap-[var(--space-2)]">
                <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  Theme:
                </span>
                {themeProposals.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => selectTheme(i)}
                    aria-pressed={selectedThemeIndex === i}
                    className={[
                      'rounded-[var(--radius-pill)] border px-[var(--space-3)] py-1 text-[length:var(--text-xs)] font-medium transition-colors',
                      selectedThemeIndex === i
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-dark)]'
                        : 'border-[var(--stroke)] text-[var(--ink-secondary)] hover:border-[var(--ink-tertiary)]',
                    ].join(' ')}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                {suggestions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => setCodename(name)}
                    aria-pressed={codename === name}
                    className={[
                      'rounded-[var(--radius-pill)] border px-[var(--space-3)] py-1 font-mono text-[length:var(--text-xs)] font-medium transition-colors',
                      codename === name
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent-dark)]'
                        : 'border-[var(--stroke)] text-[var(--ink)] hover:border-[var(--accent)] hover:text-[var(--accent-dark)]',
                    ].join(' ')}
                  >
                    {name}
                  </button>
                ))}
              </div>
                </>
              ) : null}
                </>
              ) : null}
              {railTemplatesEnabled ? (
                <RailTemplatePicker
                  key={pickerNonce}
                  value={railTemplate}
                  onChange={setRailTemplate}
                />
              ) : null}
            </div>
          ) : null}

          {step.key === 'conflicts' ? (
            <div className="flex flex-col gap-[var(--space-3)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                A mandate cannot exist without a senior partner answering one
                question on the record: are we allowed to have a deal with this
                company? The conflicts checklist runs off the platform today.
                Record the approval here; it is written to the audit log with
                the mandate.
              </p>
              {/* Pick a teammate from the loaded roster or type any name: the
               *  approver may be a senior partner who is not a platform user,
               *  so the roster is a suggestion list, not a hard constraint. The
               *  stored value stays the name string (deals.conflicts_approved_by
               *  is text; binding to a user id is deferred to D40). A custom
               *  combobox rather than a native <datalist> so the suggestions
               *  anchor under the input inside this dialog. */}
              <div className="flex max-w-[360px] flex-col gap-1">
                <label
                  htmlFor="conflict-approver-input"
                  className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]"
                >
                  Approved by
                </label>
                <div className="relative">
                  <input
                    id="conflict-approver-input"
                    type="text"
                    role="combobox"
                    aria-expanded={approverListOpen && approverMatches.length > 0}
                    aria-controls="conflict-approver-listbox"
                    aria-autocomplete="list"
                    autoComplete="off"
                    value={conflictsApprover}
                    onChange={(e) => {
                      setConflictsApprover(e.target.value);
                      setApproverListOpen(true);
                    }}
                    onFocus={() => setApproverListOpen(true)}
                    onBlur={() => setApproverListOpen(false)}
                    placeholder="Senior partner name"
                    className="w-full rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] outline-none focus:ring-2 focus:ring-[var(--ink)]"
                  />
                  {approverListOpen && approverMatches.length > 0 ? (
                    <ul
                      id="conflict-approver-listbox"
                      role="listbox"
                      className="absolute left-0 right-0 top-full z-10 mt-1 max-h-[180px] list-none overflow-y-auto rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] p-1 shadow-[var(--shadow-ambient)]"
                    >
                      {approverMatches.map((member) => {
                        const label = rosterDisplayName(member);
                        return (
                          <li key={member.id}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={conflictsApprover === label}
                              // onMouseDown (not onClick) so the selection lands
                              // before the input's onBlur closes the list.
                              onMouseDown={(e) => {
                                e.preventDefault();
                                setConflictsApprover(label);
                                setApproverListOpen(false);
                              }}
                              className="block w-full rounded-[var(--radius-input)] px-[var(--space-2)] py-[var(--space-1)] text-left text-[length:var(--text-sm)] text-[var(--ink)] hover:bg-[var(--surface-subtle)]"
                            >
                              {label}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </div>
                <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                  Pick a name from the deal team or type the senior partner who
                  gave the approval.
                </span>
              </div>
              <label className="flex max-w-[360px] flex-col gap-1">
                <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                  Approved on
                </span>
                <input
                  type="date"
                  value={conflictsDate}
                  max={todayIso}
                  onChange={(e) => setConflictsDate(e.target.value)}
                  className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] outline-none focus:ring-2 focus:ring-[var(--ink)]"
                />
              </label>
              <label className="flex max-w-[440px] items-start gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
                <input
                  type="checkbox"
                  checked={conflictsAttested}
                  onChange={(e) =>
                    setAttestedForCompanyId(e.target.checked ? (selectedCompany?.id ?? null) : null)
                  }
                  aria-label="Confirm the conflicts approval"
                  className="mt-1 size-4 accent-[var(--accent)]"
                />
                <span className="text-[length:var(--text-sm)] text-[var(--ink)]">
                  I confirm the conflicts checklist was completed and the
                  approval above is on record.
                </span>
              </label>
              <p className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                The approval does not expire. The date is recorded so it can be
                re-checked at mandate activation.
              </p>
            </div>
          ) : null}

          {step.key === 'team' && !apiCreateEnabled ? (
            <div className="flex flex-col gap-[var(--space-3)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                Membership grants deal-scoped access under {codename.trim() || 'the code name'}.
                Every grant is logged. The Managing Director stays on the deal.
              </p>
              <ul className="flex flex-col gap-[var(--space-2)]">
                {team.map((member) => {
                  const locked = member.id === mdId;
                  const checked = selected.has(member.id);
                  return (
                    <li key={member.id}>
                      <label
                        className={[
                          'flex items-start gap-[var(--space-3)] rounded-[var(--radius-card)] border p-[var(--space-3)] transition-colors',
                          checked
                            ? 'border-[var(--stroke)] bg-[var(--surface)]'
                            : 'border-[var(--stroke)] bg-[var(--surface-subtle)] opacity-70',
                        ].join(' ')}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => toggleMember(member.id)}
                          aria-label={`${member.name} · ${member.role}`}
                          className="mt-1 size-4 accent-[var(--accent)]"
                        />
                        <span className="flex flex-col">
                          <span className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                            {member.name}
                            <span className="ml-2 rounded-[var(--radius-pill)] bg-[var(--surface-subtle)] px-2 py-0.5 text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
                              {member.role}
                              {locked ? ' · you' : ''}
                            </span>
                          </span>
                          <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                            {ROLE_PERMISSIONS[member.role]}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {step.key === 'team' && apiCreateEnabled ? (
            <div className="flex flex-col gap-[var(--space-3)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                Add colleagues at your firm to the deal under{' '}
                {codename.trim() || 'the code name'}. Every grant is logged. You stay
                on as Managing Director.{' '}
                {inviteByEmailEnabled
                  ? 'Invitations send when the mandate is created. Every invite is logged.'
                  : 'Invite by email comes later.'}
              </p>
              <ul className="flex flex-col gap-[var(--space-2)]">
                {creator ? (
                  <li>
                    <div className="flex items-start gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--accent)] bg-[var(--surface)] p-[var(--space-3)]">
                      <input
                        type="checkbox"
                        checked
                        disabled
                        aria-label={`${creator.display_name || creator.full_name} · Managing Director`}
                        className="mt-1 size-4 accent-[var(--accent)]"
                      />
                      <span className="flex flex-col">
                        <span className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                          {creator.display_name || creator.full_name}{' '}
                          <span className="ml-1 rounded-[var(--radius-pill)] bg-[var(--surface-subtle)] px-2 py-0.5 text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
                            {DEAL_ROLE_LABELS[DEAL_ROLE.MD]} · you
                          </span>
                        </span>
                        <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                          {DEAL_ROLE_DUTY[DEAL_ROLE.MD]}
                        </span>
                      </span>
                    </div>
                  </li>
                ) : null}

                {roster
                  .filter((member) => member.id !== creator?.id)
                  .map((member) => {
                    const role = memberRoles[member.id];
                    const checked = Boolean(role);
                    return (
                      <li key={member.id}>
                        <div
                          className={[
                            'flex items-start gap-[var(--space-3)] rounded-[var(--radius-card)] border p-[var(--space-3)] transition-colors',
                            checked
                              ? 'border-[var(--stroke)] bg-[var(--surface)]'
                              : 'border-[var(--stroke)] bg-[var(--surface-subtle)] opacity-70',
                          ].join(' ')}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRealMember(member.id)}
                            aria-label={rosterDisplayName(member)}
                            className="mt-1 size-4 accent-[var(--accent)]"
                          />
                          <span className="flex flex-1 flex-col gap-1">
                            <span className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                              {rosterDisplayName(member)}
                              {member.department ? (
                                <>
                                  {' '}
                                  <span className="ml-1 rounded-[var(--radius-pill)] bg-[var(--surface-subtle)] px-2 py-0.5 text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
                                    {departmentName(member.department)}
                                  </span>
                                </>
                              ) : null}
                            </span>
                            {checked ? (
                              <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                                {DEAL_ROLE_DUTY[role]}
                              </span>
                            ) : null}
                          </span>
                          <label className="flex flex-col gap-1">
                            <span className="sr-only">
                              Deal role for {rosterDisplayName(member)}
                            </span>
                            <select
                              value={role ?? DEAL_ROLE.DEAL_TEAM}
                              disabled={!checked}
                              onChange={(e) =>
                                setRealMemberRole(member.id, e.target.value as DealRole)
                              }
                              aria-label={`Deal role for ${rosterDisplayName(member)}`}
                              className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-2)] py-1 text-[length:var(--text-xs)] text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--ink)] disabled:opacity-50"
                            >
                              {INTERNAL_ASSIGNABLE_DEAL_ROLES.map((r) => (
                                <option key={r} value={r}>
                                  {DEAL_ROLE_LABELS[r]}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                      </li>
                    );
                  })}

                {rosterStatus === 'idle' && creator?.company_id ? (
                  <li className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    Loading your colleagues…
                  </li>
                ) : rosterStatus === 'error' ? (
                  <li
                    role="alert"
                    className="rounded-[var(--radius-input)] bg-[var(--negative-fill)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--negative-deep)]"
                  >
                    Could not load your colleagues. You can still open the deal as
                    Managing Director and add the team later.
                  </li>
                ) : roster.filter((m) => m.id !== creator?.id).length === 0 ? (
                  <li className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                    {inviteByEmailEnabled
                      ? 'No colleagues at your firm have joined yet. Queue email invitations below; the deal opens with you as Managing Director.'
                      : 'No colleagues at your firm have joined yet. You can invite them by email later; for now the deal opens with you as Managing Director.'}
                  </li>
                ) : null}
              </ul>

              {inviteByEmailEnabled ? (
                <div className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
                  <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                    Invite by email
                  </p>
                  <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                    Colleagues at your firm only. Outside parties get access
                    from the Data Room once the deal exists.
                  </p>
                  <div className="flex flex-wrap items-end gap-[var(--space-2)]">
                    <label className="flex min-w-[200px] flex-1 flex-col gap-1">
                      <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                        Email
                      </span>
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => {
                          setInviteEmail(e.target.value);
                          setInviteFormError(null);
                          setInviteDomainDecision(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void queueInvite();
                          }
                        }}
                        placeholder="colleague@bank.com"
                        className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] outline-none focus:ring-2 focus:ring-[var(--ink)]"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="sr-only">Deal role for the invitation</span>
                      <select
                        value={inviteRole}
                        onChange={(e) => {
                          setInviteRole(e.target.value as InviteDealRole);
                          setInviteDomainDecision(null);
                        }}
                        aria-label="Deal role for the invitation"
                        className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-2)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] outline-none focus:ring-2 focus:ring-[var(--ink)]"
                      >
                        {INVITE_DEAL_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {DEAL_ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => void queueInvite()}
                      disabled={checkingInvite}
                      className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)]"
                    >
                      {checkingInvite
                        ? 'Checking'
                        : inviteDomainDecision
                          ? 'Confirm and add'
                          : 'Check and add invitation'}
                    </button>
                  </div>

                  <SmartLookupCard
                    email={inviteEmail}
                    dealId={null}
                    companyId={creator?.company_id ?? null}
                    surface="gate0"
                  />

                  {inviteDomainDecision ? (
                    <div role="alert" className="rounded-[var(--radius-input)] bg-[var(--hold-tint)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink)]">
                      {inviteDomainDecision.classification === 'mismatch'
                        ? 'This email domain does not match your company record.'
                        : inviteDomainDecision.classification === 'personal'
                          ? 'This is a personal email address, not a company address.'
                          : 'Your company has no verified email domain.'}{' '}
                      Confirm the recipient before queuing the invitation.
                    </div>
                  ) : null}
                  {inviteFormError ? (
                    <p
                      role="alert"
                      className="text-[length:var(--text-xs)] text-[var(--negative)]"
                    >
                      {inviteFormError}
                    </p>
                  ) : null}
                  {inviteQueue.length > 0 ? (
                    <ul
                      aria-label="Queued invitations"
                      className="flex flex-wrap gap-[var(--space-2)]"
                    >
                      {inviteQueue.map((chip) => (
                        <li
                          key={chip.email}
                          className="flex items-center gap-[var(--space-2)] rounded-[var(--radius-pill)] border border-[var(--stroke)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-1"
                        >
                          <span className="text-[length:var(--text-xs)] font-medium text-[var(--ink)]">
                            {chip.email}
                          </span>
                          <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                            {DEAL_ROLE_LABELS[chip.role]}
                          </span>
                          {chip.state === 'queued' ? (
                            <button
                              type="button"
                              onClick={() =>
                                setInviteQueue(removeInvite(inviteQueue, chip.email))
                              }
                              aria-label={`Remove the invitation for ${chip.email}`}
                              className="text-[length:var(--text-xs)] font-medium text-[var(--ink-tertiary)] transition-colors hover:text-[var(--negative)]"
                            >
                              Remove
                            </button>
                          ) : (
                            <span
                              className={[
                                'rounded-[6px] px-[var(--space-2)] py-0.5 text-[length:var(--text-xs)] font-medium',
                                chip.state === 'sent' ||
                                chip.state === 'access-granted' ||
                                chip.state === 'access-existing'
                                  ? 'bg-[var(--positive-fill)] text-[var(--positive-deep)]'
                                  : chip.state === 'failed' ||
                                      chip.state === 'created-email-failed'
                                    ? 'bg-[var(--negative-fill)] text-[var(--negative-deep)]'
                                    : 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)]',
                              ].join(' ')}
                            >
                              {INVITE_STATE_LABELS[chip.state]}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {step.key === 'notify' ? (
            <div className="flex flex-col gap-[var(--space-3)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                On create, a Gate 0 notice goes to compliance under the code name.
                The notice is screened for MNPI before it is logged. Nothing
                identifies the target.
              </p>
              <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)]">
                <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)]">
                  Will notify on create
                </p>
                {notifyLoadFailed ? (
                  <div role="alert" className="mt-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)]">
                    <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                      The notice recipients could not be loaded. The mandate
                      cannot be created until they are.
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setNotifyLoadFailed(false);
                        setNotifyAttempt((n) => n + 1);
                      }}
                    >
                      {TRY_AGAIN_COPY}
                    </Button>
                  </div>
                ) : notifyOfficers === null ? (
                  <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                    Looking up who will receive the notice.
                  </p>
                ) : notifyOfficers.length === 0 ? (
                  <div
                    role="status"
                    className="mt-[var(--space-3)] rounded-[var(--radius-input)] border border-[var(--hold)] bg-[var(--hold-tint)] p-[var(--space-3)]"
                  >
                    <p className="text-[length:var(--text-sm)] font-semibold text-[var(--hold-deep)]">
                      {MISSING_CCO_LABEL}
                    </p>
                    <p className="mt-1 text-[length:var(--text-sm)] leading-relaxed text-[var(--hold-deep)]">
                      Assign Receive new-mandate notices on Roles, or seat a
                      bank director. The mandate cannot be created until someone
                      will receive this notice.
                    </p>
                  </div>
                ) : (
                  <ul className="mt-[var(--space-3)] flex flex-col gap-[var(--space-2)]">
                    {notifyOfficers.map((officer) => (
                      <li
                        key={officer.id ?? officer.name}
                        className="flex items-center justify-between gap-[var(--space-3)] text-[length:var(--text-sm)]"
                      >
                        <span className="text-[var(--ink)]">
                          {officer.name}
                          {officer.role ? (
                            <span className="ml-2 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                              {officer.role}
                            </span>
                          ) : null}
                        </span>
                        <span className="font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                          Pending create
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-2)] font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                  Gate 0 notice · {codename.trim() || 'Code name pending'} · will open the mandate
                </p>
              </div>
              <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                The screened result and the exact recipients are recorded when you
                create the mandate.
              </p>
            </div>
          ) : null}

          {step.key === 'entry' ? (
            <div className="flex max-w-[440px] flex-col gap-[var(--space-3)]">
              <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                Choose the step the mandate opens at. A deal already in
                flight can enter further along the rail.
              </p>
              <EntryStepSelect
                steps={ENTRY_STEPS}
                value={postGate0EntrySeq}
                onChange={setEntrySeq}
                disabled={chosenRail !== null}
              />
              <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
                {chosenRail !== null
                  ? 'A saved rail opens at its first step.'
                  : entryStep
                    ? `Opens at step ${entryStepLabel(entryStep)}.${
                        postGate0EntrySeq === defaultEntrySeq
                          ? ''
                          : ' Earlier steps are labeled "Before this deal started" and stay reference only.'
                      }`
                    : null}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      {/* Create failure (flag-on API path). Decisive, actionable, retryable. */}
      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-input)] bg-[var(--negative-fill)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]"
        >
          {error}
        </p>
      ) : null}

      {/* Footer — back / next. One accent primary CTA per view. */}
      <footer className="flex items-center justify-start gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
        {isLast ? (
          <button
            type="button"
            onClick={complete}
            disabled={
              creating ||
              !codenameValid ||
              !conflictsValid ||
              notifyBlocksCreate
            }
            className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-white transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
          >
            {creating ? 'Creating…' : 'Create the mandate'}
          </button>
        ) : (
          <button
            type="button"
            onClick={next}
            disabled={!canAdvance}
            className="rounded-[var(--radius-button)] bg-[var(--ink)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-white transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
          >
            Next
          </button>
        )}
        {stepIndex !== 0 && pendingCommand !== null ? (
          <button
            type="button"
            onClick={abandonPending}
            className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)]"
          >
            Abandon and start over
          </button>
        ) : stepIndex === 0 ? (
          onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)]"
            >
              Cancel
            </button>
          ) : (
            <span aria-hidden="true" />
          )
        ) : (
          <button
            type="button"
            onClick={back}
            className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-base)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)]"
          >
            Back
          </button>
        )}
      </footer>
    </div>
  );
}

function PendingMandate({
  codename,
  railName,
  busy,
  onResume,
  onAbandon,
}: {
  codename: string;
  railName: string | null;
  busy: boolean;
  onResume: () => void;
  onAbandon: () => void;
}) {
  return (
    <section
      aria-label="Mandate in progress"
      className="flex flex-col gap-[var(--space-3)]"
    >
      <h2 className="text-[length:var(--text-lg)] font-semibold tracking-tight text-[var(--ink)]">
        Mandate in progress
      </h2>
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {PENDING_MANDATE_TEXT}
      </p>
      <p className="font-mono text-[length:var(--text-sm)] text-[var(--ink)]">
        Code name {codename}.
      </p>
      {railName === null ? null : (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Saved rail {railName}.
        </p>
      )}
      <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
        {PENDING_INVITES_TEXT}
      </p>
      {busy ? (
        <p
          role="status"
          aria-live="polite"
          className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
        >
          {RESUMING_TEXT}
        </p>
      ) : null}
      <div className="flex items-center gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
        <Button onClick={onResume} disabled={busy} aria-busy={busy}>
          Resume the mandate
        </Button>
        <Button variant="secondary" onClick={onAbandon} disabled={busy}>
          Abandon and start over
        </Button>
      </div>
    </section>
  );
}

export default Gate0Wizard;
