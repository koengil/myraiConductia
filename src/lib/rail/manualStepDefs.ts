// Manual MVP actions per rail step (Phases 1–5, full execution rail). Teaser (p2-s36)
// keeps the live runner. Each step exposes simple fields before marking complete.

export type ManualFieldType = 'text' | 'textarea' | 'checkbox' | 'select';

export type ManualFieldSuggest = 'person' | 'email';

/**
 * A select option. A bare string is both the stored value and the visible
 * label. The object form exists for options whose stored value predates the
 * copy rules (e.g. an em-dash): the value stays byte-identical so saved work
 * keeps loading, while the label is what the banker reads.
 */
export type ManualFieldOption = string | { readonly value: string; readonly label: string };

export function optionValue(option: ManualFieldOption): string {
  return typeof option === 'string' ? option : option.value;
}

export function optionLabel(option: ManualFieldOption): string {
  return typeof option === 'string' ? option : option.label;
}

export type ManualFieldDef = {
  id: string;
  type: ManualFieldType;
  label: string;
  placeholder?: string;
  options?: readonly ManualFieldOption[];
  required?: boolean;
  /** Enable people autocomplete on free-text fields. */
  suggest?: ManualFieldSuggest;
};

export type ManualStepDef = {
  stepId: string;
  summary: string;
  fields: readonly ManualFieldDef[];
  /** Draw an upload control on the step. Says nothing about whether a file must exist. */
  requiresUpload?: boolean;
  /**
   * The file IS the step's output, so completion is refused until the step's
   * dataroom holds one. Distinct from `requiresUpload`, which only draws the
   * control: most of those slots read '(optional)' in their own label.
   */
  uploadRequired?: boolean;
  uploadLabel?: string;
};

export const MANUAL_STEP_DEFS: Record<string, ManualStepDef> = {
  'p1-s9': {
    stepId: 'p1-s9',
    summary:
      'Prepare the MD brief and presearch profile before the first call. Objectives and qualification inputs stay visible, not a black box.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload presearch / briefing document',
    fields: [
      { id: 'call_objectives', type: 'textarea', label: 'Call objectives', required: true },
      { id: 'questions_to_ask', type: 'textarea', label: 'Questions to ask' },
      { id: 'relationship_context', type: 'text', label: 'Relationship context (one line)', suggest: 'person' },
      {
        id: 'qualification_notes',
        type: 'textarea',
        label: 'Qualification score inputs (ability to win, likelihood, fee, relevance)',
        placeholder: 'Advisory inputs the SP can override: not a black-box score.',
      },
      { id: 'brief_reviewed', type: 'checkbox', label: 'Senior partner reviewed the brief', required: true },
    ],
  },
  'p1-s10': {
    stepId: 'p1-s10',
    summary:
      'Record AI note-taking consent at meeting start, then capture structured meeting output.',
    fields: [
      {
        id: 'ai_consent',
        type: 'select',
        label: 'AI note-taking consent',
        options: ['Not yet asked', 'Consent granted', 'Consent declined'],
        required: true,
      },
      { id: 'meeting_notes', type: 'textarea', label: 'Meeting notes or transcript summary' },
      { id: 'sensitivities', type: 'textarea', label: 'Sensitivities flagged' },
      { id: 'next_actions', type: 'textarea', label: 'Next actions' },
      { id: 'summary_reviewed', type: 'checkbox', label: 'Structured summary reviewed', required: true },
    ],
  },
  'p1-s11': {
    stepId: 'p1-s11',
    summary:
      'Senior banker pursue/pass decision. Agent scoring is advisory; the confidential rationale stays protected.',
    fields: [
      {
        id: 'recommendation',
        type: 'select',
        label: 'Recommendation',
        options: ['Pursue', 'Pass', 'Hold'],
        required: true,
      },
      { id: 'pursue_pass_rationale', type: 'textarea', label: 'Pursue / pass rationale (confidential)', required: true },
      { id: 'fee_potential', type: 'checkbox', label: 'Fee potential assessed' },
      { id: 'transaction_likelihood', type: 'checkbox', label: 'Transaction likelihood assessed' },
      { id: 'banker_credibility', type: 'checkbox', label: 'Banker credibility in space assessed' },
      { id: 'ability_to_win', type: 'checkbox', label: 'Ability to win assessed' },
      { id: 'senior_approval', type: 'checkbox', label: 'Senior banker approval on record', required: true },
    ],
  },
  'p1-s12': {
    stepId: 'p1-s12',
    summary:
      'Prepare and track the client NDA before any private document request goes out.',
    fields: [
      { id: 'nda_drafted', type: 'checkbox', label: 'NDA drafted from firm precedent', required: true },
      { id: 'precedent_compared', type: 'checkbox', label: 'Compared against firm precedent' },
      { id: 'legal_review_required', type: 'checkbox', label: 'Legal review required (non-standard terms)' },
      { id: 'nda_executed', type: 'checkbox', label: 'NDA executed', required: true },
      { id: 'banker_approved_send', type: 'checkbox', label: 'Banker approved before client send' },
    ],
  },
  'p1-s13': {
    stepId: 'p1-s13',
    summary:
      'Draft the initial diligence request list after NDA execution. Sensitive vs general items categorized up front.',
    fields: [
      { id: 'list_drafted', type: 'checkbox', label: 'Initial diligence list drafted', required: true },
      { id: 'sensitive_categorized', type: 'checkbox', label: 'Sensitive vs general items categorized' },
      { id: 'banker_reviewed', type: 'checkbox', label: 'Banker reviewed before send', required: true },
      { id: 'nda_confirmed', type: 'checkbox', label: 'NDA execution confirmed on record' },
    ],
  },
  'p1-s14': {
    stepId: 'p1-s14',
    summary:
      'Plan per-person outreach angles using relationship paths. Pre-send review required.',
    fields: [
      { id: 'ceo_angle', type: 'textarea', label: 'CEO narrative / angle' },
      { id: 'cfo_angle', type: 'textarea', label: 'CFO economics case' },
      { id: 'board_angle', type: 'textarea', label: 'Board / investor angle' },
      { id: 'likely_objections', type: 'textarea', label: 'Likely objections and responses' },
      { id: 'pre_send_reviewed', type: 'checkbox', label: 'Pre-send review complete', required: true },
    ],
  },
  'p1-s15': {
    stepId: 'p1-s15',
    summary:
      'Strategy memo backbone: SWOT, why sell now, buyer theses, and process recommendation.',
    fields: [
      { id: 'swot_summary', type: 'textarea', label: 'SWOT summary', required: true },
      { id: 'why_sell_now', type: 'textarea', label: 'Why sell (or buy) now' },
      { id: 'buyer_theses', type: 'textarea', label: 'Likely buyer theses' },
      { id: 'process_strategy', type: 'textarea', label: 'Recommended process strategy' },
      { id: 'md_approved', type: 'checkbox', label: 'MD approved narrative', required: true },
    ],
  },
  'p1-s16': {
    stepId: 'p1-s16',
    summary:
      'Map stakeholder psychology and board/investor alignment for the pitch room.',
    fields: [
      { id: 'alignment_map', type: 'textarea', label: 'Board / investor alignment map', required: true },
      { id: 'objection_handling', type: 'textarea', label: 'Objection handling notes' },
      { id: 'talking_points', type: 'textarea', label: 'Who says what in the pitch' },
      { id: 'reviewed', type: 'checkbox', label: 'Senior banker reviewed psychology map', required: true },
    ],
  },
  'p1-s17': {
    stepId: 'p1-s17',
    summary:
      'Build the ranked buyer universe with rationale, access paths, and conflicts screening.',
    fields: [
      { id: 'buyer_universe_notes', type: 'textarea', label: 'Ranked buyer universe notes', required: true },
      { id: 'conflicts_screened', type: 'checkbox', label: 'Conflict / restricted-party screening run' },
      { id: 'access_paths', type: 'textarea', label: 'Access paths and relationship notes' },
      { id: 'list_reviewed', type: 'checkbox', label: 'Buyer list reviewed before pitch', required: true },
    ],
  },
  'p1-s18': {
    stepId: 'p1-s18',
    summary:
      'Select the 3–5 highest-tier case studies for this pitch. Client consent and confidentiality scrub before external use.',
    requiresUpload: true,
    uploadLabel: 'Upload case study materials (optional)',
    fields: [
      {
        id: 'selected_case_studies',
        type: 'textarea',
        label: 'Selected case studies (3–5, tier and one-line rationale each)',
        required: true,
      },
      { id: 'client_consent_verified', type: 'checkbox', label: 'Client consent verified for external use', required: true },
      { id: 'confidentiality_scrub', type: 'checkbox', label: 'Confidentiality scrub on external precedents' },
      { id: 'banker_reviewed', type: 'checkbox', label: 'Senior banker reviewed case study selection', required: true },
    ],
  },
  'p1-s19': {
    stepId: 'p1-s19',
    summary:
      'Capture proposed fee economics and negotiation positions before the pitch deck is built.',
    fields: [
      { id: 'retainer', type: 'text', label: 'Retainer (monthly fee)' },
      { id: 'success_fee', type: 'text', label: 'Success fee' },
      { id: 'minimum_fee', type: 'text', label: 'Minimum fee' },
      { id: 'tail', type: 'text', label: 'Tail (post-termination period)' },
      {
        id: 'fee_rationale',
        type: 'textarea',
        label: 'Proposed economics rationale and precedent references',
        required: true,
      },
      { id: 'fallback_positions', type: 'textarea', label: 'Accepted / fallback negotiation positions' },
      { id: 'legal_review', type: 'checkbox', label: 'Legal / commercial review complete', required: true },
    ],
  },
  'p1-s20': {
    stepId: 'p1-s20',
    summary:
      'Draft EL structure and key provisions as internal strategy before client send at Engagement Negotiation.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload EL draft (Word / PDF)',
    fields: [
      { id: 'el_drafted', type: 'checkbox', label: 'Engagement letter drafted from house template', required: true },
      { id: 'key_provisions', type: 'textarea', label: 'Key provisions and risk positions', required: true },
      { id: 'fee_scope_filled', type: 'textarea', label: 'Fee and scope terms captured' },
      { id: 'legal_review', type: 'checkbox', label: 'Counsel review complete' },
      { id: 'md_approved', type: 'checkbox', label: 'MD approved internal EL framework', required: true },
    ],
  },
  'p1-s21': {
    stepId: 'p1-s21',
    summary:
      'Pitch deck in the firm template. Upload the client-ready deck; senior banker approval before delivery.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload pitch deck',
    fields: [
      { id: 'deck_drafted', type: 'checkbox', label: 'Pitch deck drafted from firm template', required: true },
      { id: 'source_appendix', type: 'checkbox', label: 'Source appendix included' },
      { id: 'case_studies_included', type: 'checkbox', label: 'Top case studies included (from Case Study Library)' },
      { id: 'md_approved', type: 'checkbox', label: 'Senior banker approved before client delivery', required: true },
    ],
  },
  'p1-s22': {
    stepId: 'p1-s22',
    summary:
      'Page-by-page QC on the pitch deck. All eight checks must pass before the deck leaves the building.',
    fields: [
      { id: 'qc_point', type: 'checkbox', label: 'Point: one clear point per page' },
      { id: 'qc_simplicity', type: 'checkbox', label: 'Simplicity' },
      { id: 'qc_story', type: 'checkbox', label: 'Story impact' },
      { id: 'qc_uniqueness', type: 'checkbox', label: 'Uniqueness versus other banks' },
      { id: 'qc_sources', type: 'checkbox', label: 'Source accuracy' },
      { id: 'qc_formatting', type: 'checkbox', label: 'Formatting' },
      { id: 'qc_numbers', type: 'checkbox', label: 'Number consistency' },
      { id: 'qc_relevance', type: 'checkbox', label: 'Client relevance' },
      {
        id: 'qc_result',
        type: 'select',
        label: 'QC result',
        options: [
          'In review',
          'Pass',
          // Stored value predates the no-em-dash rule; saved work still holds it.
          { value: 'Fail — fixes required', label: 'Fail: fixes required' },
        ],
        required: true,
      },
      { id: 'qc_notes', type: 'textarea', label: 'Page-by-page fixes (if any)' },
    ],
  },
  'p1-s23': {
    stepId: 'p1-s23',
    summary:
      'Rehearsal pack: speaking roles, objections, Q&A, and logistics before the live pitch.',
    requiresUpload: true,
    uploadLabel: 'Upload rehearsal pack (optional)',
    fields: [
      { id: 'speaking_roles', type: 'textarea', label: 'Speaking roles and page owners', required: true },
      { id: 'objections_qa', type: 'textarea', label: 'Likely objections, war stories, and Q&A' },
      { id: 'logistics', type: 'textarea', label: 'Meeting logistics and follow-up owners' },
      { id: 'rehearsal_complete', type: 'checkbox', label: 'Dry run complete', required: true },
    ],
  },
  'p1-s24': {
    stepId: 'p1-s24',
    summary:
      'Post-pitch debrief and stakeholder follow-ups. Every commitment made in the room is tracked.',
    fields: [
      { id: 'debrief_notes', type: 'textarea', label: 'Internal pitch debrief', required: true },
      { id: 'promised_deliverables', type: 'textarea', label: 'Promised deliverables tracker' },
      { id: 'open_questions', type: 'textarea', label: 'Open client questions' },
      { id: 'nda_confirmed', type: 'checkbox', label: 'No private-document request before NDA on record' },
      { id: 'banker_approved', type: 'checkbox', label: 'Banker approved follow-ups before send', required: true },
    ],
  },
  'p1-s25': {
    stepId: 'p1-s25',
    summary:
      'Negotiate the mandate to signature. Track redlines, open issues, and the executed EL.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload EL redline or executed agreement',
    fields: [
      { id: 'negotiation_notes', type: 'textarea', label: 'Negotiation position and open issues', required: true },
      { id: 'client_feedback', type: 'textarea', label: 'Client feedback on terms' },
      { id: 'terms_agreed', type: 'checkbox', label: 'Terms agreed with client', required: true },
      { id: 'counsel_approval', type: 'checkbox', label: 'Counsel / senior banker approval on final terms', required: true },
      { id: 'el_executed', type: 'checkbox', label: 'Engagement letter fully executed', required: true },
    ],
  },
  'p2-s26': {
    stepId: 'p2-s26',
    summary:
      'Convert the won pitch into an active mandate. Every checklist item must clear before kickoff, data room, or materials work begins.',
    fields: [
      { id: 'final_conflicts', type: 'checkbox', label: 'Final conflicts check cleared', required: true },
      { id: 'signed_el', type: 'checkbox', label: 'Signed Engagement Letter on file', required: true },
      { id: 'w9_received', type: 'checkbox', label: 'IRS Form W-9 received' },
      { id: 'codename_set', type: 'checkbox', label: 'Code name confirmed on record' },
      { id: 'team_assigned', type: 'checkbox', label: 'Deal team assigned with system permissions', required: true },
      { id: 'compliance_registered', type: 'checkbox', label: 'Compliance registration complete', required: true },
      { id: 'folder_setup', type: 'checkbox', label: 'Deal workspace and folder setup complete' },
      { id: 'scope_captured', type: 'textarea', label: 'Engagement scope and fee economics captured', required: true },
      { id: 'timeline_kickoff', type: 'textarea', label: 'Timeline and kickoff plan' },
      { id: 'activation_complete', type: 'checkbox', label: 'All activation items reviewed by MD', required: true },
    ],
  },
  'p2-s27': {
    stepId: 'p2-s27',
    summary:
      'Mandatory win/loss debrief on every pitch outcome. Builds the firm pitch-performance database.',
    fields: [
      {
        id: 'outcome',
        type: 'select',
        label: 'Pitch outcome',
        options: ['Won', 'Lost'],
        required: true,
      },
      { id: 'debrief_notes', type: 'textarea', label: 'Structured debrief (what resonated or why lost)', required: true },
      { id: 'slides_pitchers', type: 'textarea', label: 'Slides / pitchers that moved the needle (win) or gaps (loss)' },
      { id: 'banker_validated', type: 'checkbox', label: 'Banker validated debrief substance', required: true },
    ],
  },
  'p2-s28': {
    stepId: 'p2-s28',
    summary:
      'Kickoff meeting output: initial WGL seed, milestone targets, roles, deliverables, and weekly cadence.',
    fields: [
      { id: 'wgl_seed', type: 'textarea', label: 'Initial Working Group List notes', required: true },
      { id: 'milestone_targets', type: 'textarea', label: 'Milestone targets for Timeline', required: true },
      { id: 'responsibility_matrix', type: 'textarea', label: 'Client vs banker ownership by workstream' },
      { id: 'cadence_plan', type: 'textarea', label: 'Weekly meeting cadence' },
      { id: 'client_approved', type: 'checkbox', label: 'Client approved process plan', required: true },
    ],
  },
  'p2-s29': {
    stepId: 'p2-s29',
    summary:
      'Living transaction timeline from sector/size template with baseline variance tracking.',
    fields: [
      { id: 'template_matched', type: 'checkbox', label: 'Timeline template matched to sector / size / type', required: true },
      { id: 'baseline_milestones', type: 'textarea', label: 'Baseline milestones and target dates', required: true },
      { id: 'variance_notes', type: 'textarea', label: 'Known slippage or variance from baseline' },
      { id: 'client_baseline_retained', type: 'checkbox', label: 'Client-approved baseline retained as evidence' },
    ],
  },
  'p2-s30': {
    stepId: 'p2-s30',
    summary:
      'Working Group List: always-current roster with buyer segregation enforced.',
    fields: [
      { id: 'wgl_current', type: 'checkbox', label: 'Working Group List reflects all current parties and contacts', required: true },
      { id: 'buyer_segregation', type: 'checkbox', label: 'Buyer segregation verified: no cross-buyer visibility', required: true },
      { id: 'access_audit', type: 'checkbox', label: 'Working Group List view/edit audit trail confirmed' },
      { id: 'banker_reviewed', type: 'checkbox', label: 'Banker reviewed the Working Group List before external share', required: true },
    ],
  },
  'p2-s31': {
    stepId: 'p2-s31',
    summary:
      'Internal VDR architecture: folder taxonomy, permissions, indexing, and clean-team carve-outs.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload VDR architecture / permission plan',
    fields: [
      { id: 'folder_taxonomy', type: 'checkbox', label: 'Folder structure and naming conventions approved', required: true },
      { id: 'permissions_plan', type: 'checkbox', label: 'Permission scheme approved by banker', required: true },
      { id: 'clean_team', type: 'checkbox', label: 'Clean-team / highly confidential carve-out documented' },
      { id: 'nda_client_approval', type: 'checkbox', label: 'NDA and client approval confirmed before buyer access' },
    ],
  },
  'p2-s32': {
    stepId: 'p2-s32',
    summary:
      'Curate inbound client documents with metadata, draft/final tagging, and document health.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload intake batch or index',
    fields: [
      { id: 'metadata_complete', type: 'checkbox', label: 'Metadata and source ownership applied', required: true },
      { id: 'draft_final_tagged', type: 'checkbox', label: 'Draft / final tagging complete' },
      { id: 'health_report', type: 'textarea', label: 'Document health summary (completeness, currency, versions)' },
      { id: 'sensitive_classified', type: 'checkbox', label: 'Sensitive classification applied at intake', required: true },
    ],
  },
  'p2-s33': {
    stepId: 'p2-s33',
    summary:
      'Data room diligence review: strengths, gaps, MNPI risk, and remediation before buyer release.',
    fields: [
      { id: 'risk_register', type: 'textarea', label: 'Risk register and missing-info log', required: true },
      { id: 'strengths_weaknesses', type: 'textarea', label: 'Strengths / weaknesses memo' },
      { id: 'clean_team_taxonomy', type: 'checkbox', label: 'Clean-team materials tagged and restricted' },
      { id: 'banker_remediation', type: 'checkbox', label: 'Banker reviewed remediation decisions', required: true },
    ],
  },
  'p2-s34': {
    stepId: 'p2-s34',
    summary:
      'Normalize historical financials and KPI inputs. Human owns every number used externally.',
    fields: [
      { id: 'financials_normalized', type: 'checkbox', label: 'Historical financials normalized', required: true },
      { id: 'assumptions_log', type: 'textarea', label: 'Assumptions log with source mapping', required: true },
      { id: 'model_inputs_ready', type: 'checkbox', label: 'Model-ready inputs verified (spreadsheet-deterministic)' },
      { id: 'human_approval', type: 'checkbox', label: 'Human approval on all external-facing numbers', required: true },
    ],
  },
  'p2-s35': {
    stepId: 'p2-s35',
    summary:
      'Daily or weekly deal pulse: overdue items, priorities, blockers, and optional risk-to-signing indicator.',
    fields: [
      { id: 'pulse_drafted', type: 'checkbox', label: 'Deal pulse drafted for this period', required: true },
      { id: 'overdue_blockers', type: 'textarea', label: 'Overdue items, blockers, and document gaps' },
      { id: 'risk_to_signing', type: 'textarea', label: 'Risk-to-signing indicator (banker-reviewed before distribution)' },
      { id: 'distribution_confirmed', type: 'checkbox', label: 'Distribution limited to authorized deal-team recipients', required: true },
    ],
  },
  'p2-s37': {
    stepId: 'p2-s37',
    summary:
      'CIM and Management Presentation from approved data with source/citation map and sensitive-info review.',
    requiresUpload: true,
    uploadRequired: true,
    uploadLabel: 'Upload CIM / Management Presentation draft',
    fields: [
      { id: 'cim_drafted', type: 'checkbox', label: 'CIM / MP drafted from firm template', required: true },
      { id: 'citation_map', type: 'checkbox', label: 'Source / citation map complete', required: true },
      { id: 'sensitive_review', type: 'checkbox', label: 'Sensitive-information review complete' },
      { id: 'senior_client_approval', type: 'checkbox', label: 'Senior and client approval before buyer release', required: true },
    ],
  },
  'p2-s38': {
    stepId: 'p2-s38',
    summary:
      'Anticipated and live buyer FAQ&A with source citations and assigned answer owners.',
    fields: [
      { id: 'anticipated_qa', type: 'textarea', label: 'Anticipated buyer questions and sourced answers', required: true },
      { id: 'live_updates', type: 'textarea', label: 'Live questions from MP, calls, and diligence' },
      { id: 'answer_owners', type: 'textarea', label: 'Answer owners assigned' },
      { id: 'banker_approved', type: 'checkbox', label: 'Banker approved before buyer distribution', required: true },
    ],
  },
  'p3-s39': {
    stepId: 'p3-s39',
    summary:
      'Sequenced outreach plan under the code name. The agent plans waves; bankers execute: no autonomous buyer contact.',
    fields: [
      { id: 'wave_plan', type: 'textarea', label: 'Outreach waves, banker owners, and tailored rationale per buyer', required: true },
      { id: 'call_scripts', type: 'textarea', label: 'Call scripts and follow-up cadence' },
      { id: 'warm_paths', type: 'textarea', label: 'Warm relationship paths prioritized over cold contact' },
      { id: 'conflicts_cleared', type: 'checkbox', label: 'Conflicts / restricted-list screening cleared', required: true },
      { id: 'client_approved_list', type: 'checkbox', label: 'Client approved contact list', required: true },
      { id: 'banker_approved_outreach', type: 'checkbox', label: 'Banker approved outreach plan before execution', required: true },
    ],
  },
  'p3-s40': {
    stepId: 'p3-s40',
    summary:
      'Per-buyer synergies, accretion/dilution, and valuation. Banker owns judgment; all arithmetic is spreadsheet-verifiable.',
    fields: [
      { id: 'buyer_models', type: 'textarea', label: 'Per-buyer synergies summary and valuation notes', required: true },
      { id: 'ability_willingness', type: 'textarea', label: 'Ability to pay / willingness to pay rationale by buyer' },
      { id: 'sources_cited', type: 'checkbox', label: 'Every figure source-cited; estimates clearly labeled', required: true },
      { id: 'human_approved', type: 'checkbox', label: 'All numbers human-approved for deal-team use', required: true },
      { id: 'md_approved_external', type: 'checkbox', label: 'MD approval before any external use', required: true },
    ],
  },
  'p3-s41': {
    stepId: 'p3-s41',
    summary:
      'Buyer log and feedback tracker. Every touch logged; banker releases all outreach: no autonomous send.',
    fields: [
      { id: 'buyer_log', type: 'textarea', label: 'Buyer log (firm, contact, date, response, pass reason)', required: true },
      { id: 'pass_feedback', type: 'textarea', label: 'Pass feedback and follow-on relationship notes' },
      { id: 'coverage_lists', type: 'textarea', label: 'Targeted coverage lists for future companies' },
      { id: 'banker_releases', type: 'checkbox', label: 'Banker releases all buyer outreach: no autonomous send', required: true },
      { id: 'communications_logged', type: 'checkbox', label: 'All communications recorded under code name', required: true },
    ],
  },
  'p3-s42': {
    stepId: 'p3-s42',
    summary:
      'Track buyer NDAs, redlines, and VDR-access readiness. Legal review for non-standard deviations.',
    requiresUpload: true,
    uploadLabel: 'Upload buyer NDA or redline (optional)',
    fields: [
      { id: 'nda_tracker_current', type: 'checkbox', label: 'NDA status tracker current for all active buyers', required: true },
      { id: 'precedent_compared', type: 'checkbox', label: 'Redlines compared against firm precedent' },
      { id: 'legal_review_deviations', type: 'checkbox', label: 'Legal review on non-standard deviations' },
      { id: 'vdr_readiness', type: 'checkbox', label: 'VDR-access readiness flagged on execution', required: true },
      { id: 'no_access_pre_nda', type: 'checkbox', label: 'No confidential access before NDA execution', required: true },
    ],
  },
  'p3-s43': {
    stepId: 'p3-s43',
    summary:
      'Staged VDR access per buyer group after executed NDA and client approval. Watermarking, logs, clean-team enforced.',
    fields: [
      { id: 'access_provisioned', type: 'checkbox', label: 'Staged VDR access provisioned by buyer group', required: true },
      { id: 'watermark_logs', type: 'checkbox', label: 'Watermarking and access/download logs enabled', required: true },
      { id: 'clean_team_enforced', type: 'checkbox', label: 'Clean-team restrictions enforced on restricted materials', required: true },
      { id: 'client_approval', type: 'checkbox', label: 'Client approval on record before access grant', required: true },
      { id: 'revoke_on_pass', type: 'checkbox', label: 'Access revoke procedure confirmed for pass / termination' },
    ],
  },
  'p3-s44': {
    stepId: 'p3-s44',
    summary:
      'Management meeting prep and capture. Buyer-specific deck and coaching before; structured summary after.',
    requiresUpload: true,
    uploadLabel: 'Upload buyer-specific meeting deck (optional)',
    fields: [
      { id: 'buyer_deck_ready', type: 'checkbox', label: 'Buyer-specific meeting deck prepared from approved materials', required: true },
      { id: 'coaching_notes', type: 'textarea', label: 'Management coaching notes and anticipated questions', required: true },
      { id: 'post_meeting_summary', type: 'textarea', label: 'Post-meeting summary and follow-up owners' },
      { id: 'capture_consent', type: 'checkbox', label: 'Meeting capture consent-based and MNPI-safe' },
      { id: 'banker_approved_materials', type: 'checkbox', label: 'Only approved materials used with buyer', required: true },
    ],
  },
  'p3-s45': {
    stepId: 'p3-s45',
    summary:
      'Buyer question queue with owner-assigned, source-linked answers. FAQ&A updated; banker approval before release.',
    requiresUpload: true,
    uploadLabel: 'Upload Q&A batch or FAQ&A update (optional)',
    fields: [
      { id: 'question_queue', type: 'textarea', label: 'Open buyer questions with assigned owners', required: true },
      { id: 'draft_answers', type: 'textarea', label: 'Draft answers from approved sources only' },
      { id: 'faqa_updated', type: 'checkbox', label: 'Shared FAQ&A updated: no duplicate rework', required: true },
      { id: 'source_linked', type: 'checkbox', label: 'Every answer has a source link', required: true },
      { id: 'banker_approved_release', type: 'checkbox', label: 'Banker approved before buyer release', required: true },
    ],
  },
  'p4-s46': {
    stepId: 'p4-s46',
    summary:
      'Process letters and LOI forms to advancing bidders. Track versions, deadlines, and consistent terms: no autonomous send.',
    requiresUpload: true,
    uploadLabel: 'Upload process letter / LOI form (optional)',
    fields: [
      { id: 'bidder_list', type: 'textarea', label: 'Advancing bidders and distribution log', required: true },
      { id: 'bid_instructions', type: 'textarea', label: 'Bid instructions, deadlines, and required terms', required: true },
      { id: 'terms_consistent', type: 'checkbox', label: 'Consistent terms and instructions to all buyers', required: true },
      { id: 'version_tracker', type: 'checkbox', label: 'Per-bidder version and redline history tracked' },
      { id: 'legal_client_approval', type: 'checkbox', label: 'Legal / client and senior approval before distribution', required: true },
    ],
  },
  'p4-s47': {
    stepId: 'p4-s47',
    summary:
      'Term-by-term IOI / bid comparison from actual bid documents. Decision support only: banker interprets.',
    fields: [
      {
        id: 'comparison_matrix',
        type: 'textarea',
        label: 'Side-by-side comparison (price, structure, mix, earnout, escrow, timing, certainty, diligence)',
        required: true,
      },
      { id: 'sourced_from_docs', type: 'checkbox', label: 'Every term sourced from actual bid documents', required: true },
      { id: 'advance_strategy', type: 'textarea', label: 'Next-round strategy and bidder advance recommendation' },
      { id: 'md_legal_review', type: 'checkbox', label: 'MD / legal reviewed comparison', required: true },
    ],
  },
  'p4-s48': {
    stepId: 'p4-s48',
    summary:
      'LOI and exclusivity analysis for the selected buyer. Human negotiates; agent tracks positions and client decision memo.',
    requiresUpload: true,
    uploadLabel: 'Upload LOI draft or redline (optional)',
    fields: [
      { id: 'negotiation_points', type: 'textarea', label: 'Negotiation points and fallback positions', required: true },
      { id: 'exclusivity_risk', type: 'textarea', label: 'Exclusivity risk map and what seller gives up', required: true },
      { id: 'client_decision_memo', type: 'textarea', label: 'Client decision memo summary' },
      { id: 'legal_md_approval', type: 'checkbox', label: 'Legal / MD approval before exclusivity accepted', required: true },
      { id: 'client_signoff', type: 'checkbox', label: 'Client sign-off on exclusivity terms', required: true },
    ],
  },
  'p4-s49': {
    stepId: 'p4-s49',
    summary:
      'Distribute form merger / purchase agreement and track buyer markups, issues, and version history.',
    requiresUpload: true,
    uploadLabel: 'Upload form agreement or buyer markup (optional)',
    fields: [
      { id: 'distribution_log', type: 'textarea', label: 'Distribution list and send log', required: true },
      { id: 'process_type', type: 'select', label: 'Process type', options: ['Auction (pre-exclusivity)', 'Single bidder (post-LOI)'], required: true },
      { id: 'issue_tracker', type: 'textarea', label: 'Open comments, issues, and buyer positions' },
      { id: 'version_history', type: 'checkbox', label: 'Complete version history maintained', required: true },
      { id: 'counsel_controlled', type: 'checkbox', label: 'Counsel-owned: application tracks only', required: true },
    ],
  },
  'p4-s50': {
    stepId: 'p4-s50',
    summary:
      'Live tracker for confirmatory diligence, disclosure schedules, closing conditions, and open reps/covenants issues.',
    requiresUpload: true,
    uploadLabel: 'Upload disclosure schedule or issue list (optional)',
    fields: [
      { id: 'open_issues', type: 'textarea', label: 'Open purchase agreement issues with owners', required: true },
      { id: 'confirmatory_diligence', type: 'textarea', label: 'Confirmatory diligence status' },
      { id: 'disclosure_schedules', type: 'checkbox', label: 'Disclosure schedules verified against the record' },
      { id: 'closing_conditions', type: 'textarea', label: 'Closing conditions checklist' },
      { id: 'board_approval', type: 'checkbox', label: 'Board approval of transaction on record (pre-signing)', required: true },
      { id: 'legal_approval', type: 'checkbox', label: 'Legal approval on open-point resolution', required: true },
    ],
  },
  'p5-s51': {
    stepId: 'p5-s51',
    summary:
      'Pre-stage signing checklist, announcement drafts, tombstone, and stakeholder comms plan before go-live.',
    requiresUpload: true,
    uploadLabel: 'Upload announcement / press draft (optional)',
    fields: [
      { id: 'signing_checklist', type: 'textarea', label: 'Signing checklist and closing timeline', required: true },
      { id: 'comms_plan', type: 'textarea', label: 'Stakeholder communications plan (client, buyer, employees, press)' },
      { id: 'terms_verified', type: 'checkbox', label: 'Final terms verified against signed definitive agreement', required: true },
      { id: 'comms_review', type: 'checkbox', label: 'Communications review on all drafted materials', required: true },
      { id: 'client_legal_approval', type: 'checkbox', label: 'Client and legal approval before release package locked', required: true },
    ],
  },
  'p5-s52': {
    stepId: 'p5-s52',
    summary:
      'Public announcement release. Human owns go/no-go and timing; materials staged from signing prep.',
    fields: [
      { id: 'release_timing', type: 'text', label: 'Coordinated release timing across channels' },
      { id: 'confidentiality_limits', type: 'textarea', label: 'Client confidentiality constraints on disclosure', required: true },
      { id: 'transaction_description', type: 'textarea', label: 'Final transaction description and approved quotes', required: true },
      { id: 'tombstone_approved', type: 'checkbox', label: 'Tombstone approved' },
      { id: 'client_md_comms_approval', type: 'checkbox', label: 'Client + MD + Comms approval before public release', required: true },
    ],
  },
  'p5-s53': {
    stepId: 'p5-s53',
    summary:
      'LinkedIn deal post queued for announcement timestamp. No autonomous posting.',
    fields: [
      { id: 'post_draft', type: 'textarea', label: 'LinkedIn post draft (descriptor, quote, hashtags, team tags)', required: true },
      { id: 'tags_verified', type: 'checkbox', label: 'Deal-team tags and name spelling verified' },
      { id: 'no_mnpi', type: 'checkbox', label: 'No MNPI: authorized disclosure only', required: true },
      { id: 'queued_timestamp', type: 'checkbox', label: 'Queued for announcement timestamp', required: true },
      { id: 'client_md_comms_approval', type: 'checkbox', label: 'Client + MD + Comms approval before queue', required: true },
    ],
  },
  'p5-s54': {
    stepId: 'p5-s54',
    summary:
      'Pre-staged email blast to firm lists and relationship contacts. No autonomous send.',
    fields: [
      { id: 'recipient_segments', type: 'textarea', label: 'Recipient segments and personalization notes', required: true },
      { id: 'blast_draft', type: 'textarea', label: 'Email blast draft with one-line transaction descriptor' },
      { id: 'restricted_scrub', type: 'checkbox', label: 'Restricted-list scrub and suppression lists applied', required: true },
      { id: 'reg_fd_can_spam', type: 'checkbox', label: 'Reg FD and CAN-SPAM compliance confirmed' },
      { id: 'comms_approval', type: 'checkbox', label: 'Comms approval before release', required: true },
    ],
  },
  'p5-s55': {
    stepId: 'p5-s55',
    summary:
      'League-table submissions at announcement. Credit attribution mapped per platform taxonomy.',
    fields: [
      { id: 'platforms_submitted', type: 'textarea', label: 'Platforms submitted and confirmation receipts', required: true },
      { id: 'attribution_mapped', type: 'textarea', label: 'Deal-team attribution per platform taxonomy' },
      { id: 'terms_accuracy', type: 'checkbox', label: 'Final-terms accuracy verified against signed agreement', required: true },
      { id: 'missed_platforms', type: 'textarea', label: 'Missed platforms or corrections filed post-publication' },
      { id: 'client_md_comms_approval', type: 'checkbox', label: 'Client + MD + Comms approval before submission', required: true },
    ],
  },
  'p5-s56': {
    stepId: 'p5-s56',
    summary:
      'Regulatory and third-party approval tracker between signing and closing. Tracking only: counsel owns filings.',
    fields: [
      { id: 'approval_checklist', type: 'textarea', label: 'HSR, FDI, lender, shareholder, and other consents with deadlines', required: true },
      { id: 'responsible_parties', type: 'textarea', label: 'Responsible party and evidence per item' },
      { id: 'escalation_alerts', type: 'checkbox', label: 'Escalation alerts configured for approaching deadlines' },
      { id: 'legal_controlled', type: 'checkbox', label: 'Legal/compliance controlled: application tracks only', required: true },
    ],
  },
  'p5-s57': {
    stepId: 'p5-s57',
    summary:
      'Closing deliverables tracker. Human owns wires and signatures; dual control on funds flow.',
    fields: [
      { id: 'closing_deliverables', type: 'textarea', label: 'Closing checklist (signatures, certificates, conditions, releases)', required: true },
      { id: 'funds_flow_status', type: 'textarea', label: 'Funds flow and wire status' },
      { id: 'wire_fraud_checks', type: 'checkbox', label: 'Anti-fraud checks on wire instructions complete', required: true },
      { id: 'dual_control', type: 'checkbox', label: 'Dual control confirmed on all wires', required: true },
      { id: 'human_confirmed', type: 'checkbox', label: 'Human confirmation on all payments and signatures', required: true },
    ],
  },
  'p5-s58': {
    stepId: 'p5-s58',
    summary:
      'Success fee calculation and invoice package. MD approves and sends: collection via Finalis.',
    requiresUpload: true,
    uploadLabel: 'Upload invoice package (optional)',
    fields: [
      { id: 'fee_calculation', type: 'textarea', label: 'Fee calculation (retainer credit, expenses, splits)', required: true },
      { id: 'el_reconciled', type: 'checkbox', label: 'Every fee component reconciled to engagement letter', required: true },
      { id: 'invoice_prepared', type: 'checkbox', label: 'Invoice, executed EL, and cover email prepared', required: true },
      { id: 'md_finance_approval', type: 'checkbox', label: 'MD / finance approval before send', required: true },
      { id: 'finalis_collection', type: 'checkbox', label: 'Collection routed through Finalis', required: true },
    ],
  },
  'p5-s59': {
    stepId: 'p5-s59',
    summary:
      'Post-close compliance binder: executed docs, approvals, diligence, fees, and retention checklist.',
    requiresUpload: true,
    uploadLabel: 'Upload closing binder index (optional)',
    fields: [
      { id: 'binder_index', type: 'textarea', label: 'Closing binder archive index', required: true },
      { id: 'retention_checklist', type: 'checkbox', label: 'Retention checklist complete (17a-4 manual supervisory pass)', required: true },
      { id: 'evidence_complete', type: 'checkbox', label: 'Executed documents, approvals, comms, and fee evidence compiled', required: true },
      { id: 'final_transaction_record', type: 'checkbox', label: 'Final transaction record filed', required: true },
    ],
  },
  'p5-s60': {
    stepId: 'p5-s60',
    summary:
      'Track earnouts, escrow, milestones, and trailing fees. Alerts and draft invoices: human releases.',
    fields: [
      { id: 'deferred_rights', type: 'textarea', label: 'Deferred economic rights (earnout, escrow, milestones, tail invoices)', required: true },
      { id: 'trigger_alerts', type: 'textarea', label: 'Upcoming trigger events and collection tasks' },
      { id: 'el_pa_aligned', type: 'checkbox', label: 'Tracking aligned to engagement letter and purchase agreement', required: true },
      { id: 'human_approval_invoices', type: 'checkbox', label: 'Human approval before any trailing invoice or escalation', required: true },
    ],
  },
  'p5-s61': {
    stepId: 'p5-s61',
    summary:
      'Relationship follow-up: closing dinner, thank-yous, gifts, testimonials, and referral asks. Owner-led.',
    fields: [
      { id: 'celebration_plan', type: 'textarea', label: 'Closing dinner / celebration plan and attendee list', required: true },
      { id: 'thank_you_drafts', type: 'textarea', label: 'Thank-you note drafts' },
      { id: 'referral_tasks', type: 'textarea', label: 'Testimonial, reference, and referral task list' },
      { id: 'gift_policy', type: 'checkbox', label: 'FINRA gift and entertainment policy limits observed' },
      { id: 'owner_releases', type: 'checkbox', label: 'Relationship owner releases all outbound asks', required: true },
    ],
  },
  'p5-s62': {
    stepId: 'p5-s62',
    summary:
      'Harvest tombstone, website, and reusable assets into the firm library. Client consent and confidentiality scrub.',
    requiresUpload: true,
    uploadLabel: 'Upload tombstone or asset extract (optional)',
    fields: [
      { id: 'marketing_deliverables', type: 'textarea', label: 'Tombstone, website, and marketing deliverables status', required: true },
      { id: 'assets_tagged', type: 'textarea', label: 'Reusable assets tagged for slide library / case studies' },
      { id: 'client_consent', type: 'checkbox', label: 'Client consent for harvested assets', required: true },
      { id: 'confidentiality_scrub', type: 'checkbox', label: 'Confidentiality scrub on every asset', required: true },
      { id: 'comms_approval', type: 'checkbox', label: 'Comms approval before publication', required: true },
    ],
  },
  'p5-s63': {
    stepId: 'p5-s63',
    summary:
      'Earned media pitches and paid/bylined content within 48 hours of announcement. No MNPI.',
    fields: [
      { id: 'earned_pitches', type: 'textarea', label: 'Earned-media pitches to trade press', required: true },
      { id: 'bylined_drafts', type: 'textarea', label: 'Bylined article / op-ed drafts (MD byline)' },
      { id: 'paid_disclosure', type: 'checkbox', label: 'Paid placement disclosed where required' },
      { id: 'no_mnpi', type: 'checkbox', label: 'No MNPI in any pitch or draft', required: true },
      { id: 'client_md_comms_approval', type: 'checkbox', label: 'Client + MD + Comms approval before pitching', required: true },
    ],
  },
  'p5-s64': {
    stepId: 'p5-s64',
    summary:
      'Structured post-mortem: process, fees, buyer feedback, and approved playbook updates. Confidential learning separated.',
    fields: [
      { id: 'post_mortem', type: 'textarea', label: 'What worked, what failed, timing, fees, diligence issues', required: true },
      { id: 'buyer_feedback', type: 'textarea', label: 'Winning / lost buyer rationale and feedback' },
      { id: 'playbook_updates', type: 'textarea', label: 'Approved reusable playbook and template improvements' },
      { id: 'confidential_separated', type: 'checkbox', label: 'Client-confidential data separated from generalized learning', required: true },
      { id: 'approval_before_share', type: 'checkbox', label: 'Reusable patterns approved before shared playbooks', required: true },
    ],
  },
  'p5-s65': {
    stepId: 'p5-s65',
    summary:
      'Tail period monitor for no-close or terminated mandates. Fee-trigger alerts before tail lapses.',
    fields: [
      {
        id: 'trigger_type',
        type: 'select',
        label: 'Activation trigger',
        options: [
          'No close',
          // Stored values predate the no-em-dash rule; saved work still holds them.
          { value: 'Terminated — expiration', label: 'Terminated: expiration' },
          { value: 'Terminated — voluntary', label: 'Terminated: voluntary' },
          'Not applicable (closed deal)',
        ],
        required: true,
      },
      { id: 'tail_calendar', type: 'textarea', label: 'Tail period dates and EL terms', required: true },
      { id: 'monitored_buyers', type: 'textarea', label: 'Buyers and events monitored during tail' },
      { id: 'fee_claims', type: 'textarea', label: 'Potential fee claims and evidence folder status' },
      { id: 'legal_review_claim', type: 'checkbox', label: 'Legal/commercial review before any fee claim asserted' },
      { id: 'crm_status', type: 'checkbox', label: 'Pipeline CRM updated (Terminated / Died) when applicable' },
    ],
  },
};

export const MANUAL_STEP_IDS = new Set(Object.keys(MANUAL_STEP_DEFS));

export function manualStepDef(stepId: string): ManualStepDef | undefined {
  return MANUAL_STEP_DEFS[stepId];
}

export function validateManualWork(
  def: ManualStepDef,
  work: Record<string, unknown>,
): string | null {
  for (const field of def.fields) {
    if (!field.required) continue;
    const value = work[field.id];
    if (field.type === 'checkbox') {
      if (value !== true) return `${field.label} is required before completing this step.`;
    } else if (typeof value !== 'string' || !value.trim()) {
      return `${field.label} is required before completing this step.`;
    }
  }
  return null;
}
