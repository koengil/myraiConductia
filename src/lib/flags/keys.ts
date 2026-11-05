// The canonical catalogue of feature flags.
//
// This registry is the single source of truth for WHICH flags exist. `FlagKey`
// is derived from it, so every flag lookup is type-checked at compile time (no
// stringly-typed flags, per conventions.md). The seed materialises this same
// registry into each Supabase project; adding a flag = add an entry here and the
// seed picks it up. The DB row owns the runtime ENABLED state; this registry
// owns the flag's EXISTENCE and metadata.

export interface FlagDefinition {
  /** Human-readable purpose; mirrored to `feature_flags.description` by the seed. */
  description: string;
}

export const FLAG_REGISTRY = {
  gate0_api_create: {
    description:
      'Route the Gate 0 wizard through POST /api/v1/deals (real transactional create) instead of the localStorage fixture path.',
  },
  mail_channel: {
    description:
      'The compliance email client server surface (screen, outbox, inbox, inbound webhook, mailbox connect). Off = every mail route 404s: the server-side kill switch for a channel that can send real external email.',
  },
  mail_jev_second_opinion: {
    description:
      'Jev (TypeSafe AI, through the AI Gateway) as a second opinion on a send-time rule flag (D82, proposed). Also needs AI_GATEWAY_API_KEY and a valid JEV_SECOND_OPINION_* policy. Off = a rule flag always stands and Jev is never called.',
  },
  teaser_sandbox_runner: {
    description:
      'The sandbox Teaser runner on rail seq 36: an in-browser demo on fixed Atlassian content that reads nothing from the deal it is opened on. Off = seq 36 runs its bound skill like every other skill step. Keep it off in production (PL-14, D-7).',
  },
  platform_onboarding: {
    description:
      'Buyer/seller onboarding: invite lifecycle + accept page, room-split data room over firm storage, phase controls, and the external scoped shell. Off = new routes 404 and changed surfaces keep pre-onboarding behavior.',
  },
  company_access_management: {
    description:
      'Company-scoped roles, direct grants, and effective employee permissions. Off = company access-management routes and permission-aware roster reads remain unavailable.',
  },
  setup_walkthroughs: {
    description:
      'Account setup readiness and versioned user and administrator walkthroughs. Off = setup routes 404 and setup navigation remains hidden.',
  },
  workbench_top_nav: {
    description:
      'Workbench 56px light top-nav shell replacing the desktop sidebar. Off = sidebar shell unchanged.',
  },
  book_view: {
    description:
      "The Book home preview (#191, Storm's deck slides 9-10 direction): a Console/Book switcher on the bank home rendering the deals-table + Today's Tasks layout beside the Command Center. Off = no switcher, Command Center unchanged.",
  },
  skill_authoring: {
    description:
      'Private durable skill authoring and candidate preview. Off = Add step is hidden and no new authoring message is admitted.',
  },
  project_rail_model: {
    description:
      'The project-owned rail: server-driven step structure, removal and restoration. Off = the rail renders from the static catalogue and the progress cursor.',
  },
  rail_templates: {
    description:
      'Save and replace named company rails and select them during Gate 0.',
  },
  template_change_review: {
    description:
      'Template change review on the deal rail: GET, POST and DELETE /api/v1/deals/{dealId}/rail/template-changes, the rail banner and review dialog for deals built from a published company template, and the rail_template_updated notice sent when a template is published. Off = the routes 404, no notice is sent, and the rail shows no banner or dialog.',
  },
  deal_discovery: {
    description:
      'Deal discovery: the /discovery list of candidates proposed from bankers\' own mail, /api/v1/discovery/*, and the Discovery nav entry. Off = the page and every discovery route 404 and the nav entry is hidden.',
  },
  deal_data_room_nav: {
    description:
      'Show the external Data Room in the per-deal nav (off for MVP 2: internal Deal Folder only). Off = internal users see Deal Folder and no Data Room row; external seats keep it and /data-room still renders when typed.',
  },
  discovery_worker_enabled: {
    description:
      'The deal-discovery ingestion worker (Graph mail and SharePoint sync). Off = the worker queues no sync and a running sync stops after its current page, without a deploy; what was read stays, and the checkpoint resumes when it is back on.',
  },
  discovery_model_proposals_demo: {
    description:
      'Demo only: classify-once --propose asks a ZDR model about mail the codename rules did not route, and stores a proposed deal and phase per message (no mail text). Off = the propose run refuses before reading anything. Removed when #459 lands.',
  },
  work_identity_onboarding: {
    description:
      'Banker work-identity onboarding: work-account invitations (one email), Google Workspace or Microsoft Entra sign-in, identity connect, and the /join pages. Off = work-account routes 404, new invitations stay email-code, and stored work-account invitations refuse delivery.',
  },
  skill_output_revisions: {
    description:
      "Review and revise a skill run's output: comments and hand edits on passages, applied as immutable revisions that are all kept. Off = the revision routes 404 and a run's output is read-only.",
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAG_REGISTRY;
