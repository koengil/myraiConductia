// Deal-discovery constants. Each mirrors a CHECK enum in
// supabase/migrations/20260925120000_discovery_core.sql (or, where a later
// migration widened or added it, 20260925150000_discovery_health.sql,
// 20261001130000_mailbox_allowlist.sql, 20261001160000_mailbox_allowlist_drift.sql,
// 20261001180000_site_allowlist.sql, 20261002200000_discovery_milestones.sql and
// 20261002210000_discovery_corrections.sql),
// which is the source of truth;
// tests/constants-schema-sync.test.ts fails when they drift, and
// scripts/preflight-db.ts checks the ones the worker writes against a live
// database.

/** deal_candidates.discovery_state. A dimension apart from deals.status (ADR-006). */
export const DISCOVERY_STATE = {
  PROPOSED: 'proposed',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  MERGED_INTO: 'merged_into',
} as const;
export type DiscoveryState = (typeof DISCOVERY_STATE)[keyof typeof DISCOVERY_STATE];
export const DISCOVERY_STATES = Object.values(DISCOVERY_STATE) as DiscoveryState[];

/** evidence_links.route_tier. Set by the routing method, never by a score (Q7). */
export const ROUTE_TIER = {
  FIRM: 'firm',
  TENTATIVE: 'tentative',
} as const;
export type RouteTier = (typeof ROUTE_TIER)[keyof typeof ROUTE_TIER];
export const ROUTE_TIERS = Object.values(ROUTE_TIER) as RouteTier[];

/** evidence_links.state. */
export const LINK_STATE = {
  PROPOSED: 'proposed',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
} as const;
export type LinkState = (typeof LINK_STATE)[keyof typeof LINK_STATE];
export const LINK_STATES = Object.values(LINK_STATE) as LinkState[];

/**
 * evidence_links.method and routing_ledger.method. The firm rules of phase 3:
 * a codename or an alias of one in the subject or body, and continuation of
 * a routed thread (which stops at a subject change). MODEL_PROPOSAL (G-02b #173,
 * 20261023140200_model_proposal_accept_checks.sql) is not a rule: it routes a message
 * a person accepted as part of a model-only proposal, tier `firm`, and teaches no
 * codename, thread or alias.
 */
export const ROUTE_METHOD = {
  CODENAME: 'codename',
  ALIAS: 'alias',
  THREAD_CONTINUATION: 'thread_continuation',
  MODEL_PROPOSAL: 'model_proposal',
} as const;
export type RouteMethod = (typeof ROUTE_METHOD)[keyof typeof ROUTE_METHOD];
export const ROUTE_METHODS = Object.values(ROUTE_METHOD) as RouteMethod[];

/** content_sources.kind. */
export const SOURCE_KIND = {
  MAILBOX: 'mailbox',
  SHAREPOINT_SITE: 'sharepoint_site',
} as const;
export type SourceKind = (typeof SOURCE_KIND)[keyof typeof SOURCE_KIND];
export const SOURCE_KINDS = Object.values(SOURCE_KIND) as SourceKind[];

/** content_sources.status. */
export const SOURCE_STATUS = {
  ACTIVE: 'active',
  PAUSED: 'paused',
} as const;
export type SourceStatus = (typeof SOURCE_STATUS)[keyof typeof SOURCE_STATUS];
export const SOURCE_STATUSES = Object.values(SOURCE_STATUS) as SourceStatus[];

/**
 * An expired incremental cursor resets a source to a fresh backfill (R9). It
 * halts the source instead when the backfill that preceded it took longer than
 * this many days (the provider keeps less history than one backfill spans), or
 * when the cursor expired right after two backfills in a row (#259, R21).
 */
export const HISTORY_WINDOW_HALT_DAYS = 5;
/** content_sources.last_error of a source halted by that rule: a fixed code, never content. */
export const HISTORY_WINDOW_EXCEEDED = 'history_window_exceeded';
/**
 * A halted source restarted this recently is refused another restart (discovery_restart_mailbox_source,
 * 20261008210000_discovery_restart_source.sql): a restart re-reads the whole mailbox, and one that halts again
 * this soon would only repeat it.
 */
export const SOURCE_RESTART_COOLDOWN_SECONDS = 86_400;
/**
 * content_sources.backfill_since of a newly registered mailbox: its first read takes mail from this many days
 * before registration (UTC) (#353). The column DEFAULT and the backfill of never-read Google mailboxes in
 * 20261016120000_discovery_backfill_window.sql.
 */
export const BACKFILL_WINDOW_DEFAULT_DAYS = 90;
/**
 * Owner decision 2026-10-16: a firm admin may set a mailbox's window up to this many days back (UTC), before its
 * first read (#353). Mirrors the one bound literal in 20261018110000_discovery_set_source_window.sql.
 */
export const BACKFILL_WINDOW_MAX_DAYS = 730;

/**
 * Admin-managed team inboxes (#581; 20261019100000_team_mailboxes.sql, which is the source of truth;
 * tests/constants-schema-sync.test.ts pins these to it).
 */
/** team_mailboxes.check_status: the Google Directory check of the address. */
export const TEAM_MAILBOX_CHECK_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  REFUSED: 'refused',
} as const;
export type TeamMailboxCheckStatus = (typeof TEAM_MAILBOX_CHECK_STATUS)[keyof typeof TEAM_MAILBOX_CHECK_STATUS];
export const TEAM_MAILBOX_CHECK_STATUSES = Object.values(TEAM_MAILBOX_CHECK_STATUS) as TeamMailboxCheckStatus[];

/** team_mailboxes.check_reason: why a definitive check refused the address. A refusal always carries one. */
export const TEAM_MAILBOX_CHECK_REASON = {
  GROUP: 'group',
  ALIAS: 'alias',
  SUSPENDED: 'suspended',
  NO_MAILBOX: 'no_mailbox',
  NOT_FOUND: 'not_found',
  IDENTITY_CHANGED: 'identity_changed',
  DIRECTORY_DENIED: 'directory_denied',
} as const;
export type TeamMailboxCheckReason = (typeof TEAM_MAILBOX_CHECK_REASON)[keyof typeof TEAM_MAILBOX_CHECK_REASON];
export const TEAM_MAILBOX_CHECK_REASONS = Object.values(TEAM_MAILBOX_CHECK_REASON) as TeamMailboxCheckReason[];

/** team_mailboxes.last_check_error: a transient failure of the check. It never changes the status. */
export const TEAM_MAILBOX_CHECK_ERROR = {
  DIRECTORY_ERROR: 'directory_error',
} as const;
export type TeamMailboxCheckError = (typeof TEAM_MAILBOX_CHECK_ERROR)[keyof typeof TEAM_MAILBOX_CHECK_ERROR];
export const TEAM_MAILBOX_CHECK_ERRORS = Object.values(TEAM_MAILBOX_CHECK_ERROR) as TeamMailboxCheckError[];

/** team_mailboxes.disconnected_reason. Widened by the disconnect-with-purge slice. */
export const TEAM_MAILBOX_DISCONNECT_REASON = {
  NEVER_VERIFIED: 'never_verified',
  /** Removed after a verification, with nothing ever attached to its source (a typo, an identity that changed). */
  NO_MAIL: 'no_mail',
} as const;
export type TeamMailboxDisconnectReason =
  (typeof TEAM_MAILBOX_DISCONNECT_REASON)[keyof typeof TEAM_MAILBOX_DISCONNECT_REASON];
export const TEAM_MAILBOX_DISCONNECT_REASONS = Object.values(
  TEAM_MAILBOX_DISCONNECT_REASON,
) as TeamMailboxDisconnectReason[];

/**
 * team_mailbox_members.removed_reason (20261019150000_team_mailbox_members.sql): why a person stopped being a member.
 * An admin removed them, they lost their seat in the firm (a trigger), or the inbox itself was removed.
 */
export const TEAM_MAILBOX_MEMBER_REMOVED_REASON = {
  REMOVED: 'removed',
  SEAT_LOST: 'seat_lost',
  DISCONNECTED: 'disconnected',
} as const;
export type TeamMailboxMemberRemovedReason =
  (typeof TEAM_MAILBOX_MEMBER_REMOVED_REASON)[keyof typeof TEAM_MAILBOX_MEMBER_REMOVED_REASON];
export const TEAM_MAILBOX_MEMBER_REMOVED_REASONS = Object.values(
  TEAM_MAILBOX_MEMBER_REMOVED_REASON,
) as TeamMailboxMemberRemovedReason[];

/**
 * The version of the firm-mailbox attestation text an admin ticks at connect ("this is a firm mailbox, not a
 * person's"). Stored in team_mailboxes.attestation_version and audited. The RPC accepts any version >= 1; the
 * route compares against this one.
 */
export const TEAM_MAILBOX_ATTESTATION_VERSION = 1;

/**
 * A team inbox is read only while the Directory last confirmed its address less than this many minutes ago
 * (mailbox_guard_verdict, 20261019140000_team_mailbox_guard.sql, the one place the window is judged). The check is
 * renewed before a pass once it is TEAM_MAILBOX_RENEW_MINUTES old (discovery_team_mailbox_check_due), so a pass starts
 * with at least the difference left to read in, and once more mid-pass if the guard says it went stale.
 */
export const TEAM_MAILBOX_READ_WINDOW_MINUTES = 65;
export const TEAM_MAILBOX_RENEW_MINUTES = 15;

/** discovery_connect_team_mailbox accepts a first-read window from this many days before today (UTC) up to today. */
export const TEAM_MAILBOX_WINDOW_MAX_DAYS = 730;

/**
 * The views of a firm's team inbox audit trail (#173 G-03): discovery_team_mailbox_audit's p_view
 * (20261023100300_team_mailbox_audit_read.sql, which raises 22023 bad_view for anything else). `access` is the
 * inbox's access and check rows, `reads` every reader pass of its sources, `reads_notable` the passes that stored or
 * excluded mail, did not complete, or have no finish recorded after an hour.
 */
export const TEAM_MAILBOX_AUDIT_VIEW = {
  ACCESS: 'access',
  READS: 'reads',
  READS_NOTABLE: 'reads_notable',
} as const;
export const TEAM_MAILBOX_AUDIT_VIEWS = Object.values(TEAM_MAILBOX_AUDIT_VIEW) as Array<
  (typeof TEAM_MAILBOX_AUDIT_VIEW)[keyof typeof TEAM_MAILBOX_AUDIT_VIEW]
>;

/** The page size of that read: its default, and the bound it clamps p_limit to (1..200), in the route as in SQL. */
export const TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT = 50;
export const TEAM_MAILBOX_AUDIT_MAX_LIMIT = 200;

/** graph_reader_registrations.status. */
export const REGISTRATION_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUS)[keyof typeof REGISTRATION_STATUS];
export const REGISTRATION_STATUSES = Object.values(REGISTRATION_STATUS) as RegistrationStatus[];
/** google_reader_registrations.status (20261002175000): the same three states as the Graph registration's. */
export const GOOGLE_REGISTRATION_STATUSES = REGISTRATION_STATUSES;

/**
 * google_reader_registrations.delegation_status (20261002183000): the last
 * domain-wide-delegation outcome the reader saw when it minted a token. Null
 * until a token has been minted. `missing` is Google's unauthorized_client.
 */
export const DELEGATION_STATUS = {
  OK: 'ok',
  MISSING: 'missing',
  ERROR: 'error',
} as const;
export type DelegationStatus = (typeof DELEGATION_STATUS)[keyof typeof DELEGATION_STATUS];
export const DELEGATION_STATUSES = Object.values(DELEGATION_STATUS) as DelegationStatus[];

/**
 * routing_ledger.decision. Every item read gets one; only routed items are
 * stored. `skipped` (phase 4) is a document the worker did not read into
 * text, with its reason in routing_ledger.skip_reason.
 */
export const ROUTING_DECISION = {
  ROUTED: 'routed',
  UNROUTED: 'unrouted',
  SKIPPED: 'skipped',
} as const;
export type RoutingDecision = (typeof ROUTING_DECISION)[keyof typeof ROUTING_DECISION];
export const ROUTING_DECISIONS = Object.values(ROUTING_DECISION) as RoutingDecision[];

/**
 * routing_ledger.skip_reason: why an item was ledgered without its text.
 * Image-only files (and PDFs without a text layer) are out of scope for the
 * demo: there is no OCR. id_collision is a message whose Internet message id
 * the tenant already holds for different content; the first one keeps the id.
 * The four policy_* reasons (20261003110000_discovery_exclusion_policy.sql) are
 * the exclusion policy's: the first three were never fetched, the last was.
 */
export const SKIP_REASON = {
  IMAGE_ONLY: 'image_only',
  UNSUPPORTED_TYPE: 'unsupported_type',
  TOO_LARGE: 'too_large',
  EXTRACTION_FAILED: 'extraction_failed',
  EXTRACTION_TIMEOUT: 'extraction_timeout',
  ID_COLLISION: 'id_collision',
  // The exclusion policy ran on the message's metadata and excluded it before any fetch (#263, Phase 1).
  POLICY_EXCLUDED: 'policy_excluded',
  // An unlabelled later message of a conversation a thread-scoped rule excluded (Phase 3).
  POLICY_THREAD_EXCLUDED: 'policy_thread_excluded',
  // A rule could not be evaluated on the metadata, so the message fails closed.
  POLICY_UNEVALUABLE: 'policy_unevaluable',
  // The raw fetch showed a label a rule excludes, after the metadata read did not: fetched, discarded unparsed (Phase 2).
  POLICY_EXCLUDED_AFTER_FETCH: 'policy_excluded_after_fetch',
} as const;
export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];
export const SKIP_REASONS = Object.values(SKIP_REASON) as SkipReason[];

/** The reasons an exclusion policy writes: a policy skip carries its version, rule and provider thread id. */
export const POLICY_SKIP_REASONS = [
  SKIP_REASON.POLICY_EXCLUDED,
  SKIP_REASON.POLICY_THREAD_EXCLUDED,
  SKIP_REASON.POLICY_UNEVALUABLE,
  SKIP_REASON.POLICY_EXCLUDED_AFTER_FETCH,
] as const;
export type PolicySkipReason = (typeof POLICY_SKIP_REASONS)[number];
/**
 * The policy reasons of a message whose body was never requested. Only these may be refreshed by a later pass:
 * a row that records a fetch is immutable (discovery_ledger_record_policy_skips).
 */
export const NEVER_FETCHED_POLICY_SKIP_REASONS = [
  SKIP_REASON.POLICY_EXCLUDED,
  SKIP_REASON.POLICY_THREAD_EXCLUDED,
  SKIP_REASON.POLICY_UNEVALUABLE,
] as const;

/**
 * A content source's sync position, as discovery_ingestion_health() reports
 * it: never read, part-way through its first read, or reading changes only.
 */
export const CHECKPOINT_STATE = {
  NOT_STARTED: 'not_started',
  BACKFILLING: 'backfilling',
  INCREMENTAL: 'incremental',
} as const;
export type CheckpointState = (typeof CHECKPOINT_STATE)[keyof typeof CHECKPOINT_STATE];
export const CHECKPOINT_STATES = Object.values(CHECKPOINT_STATE) as CheckpointState[];

/** source_items.kind. */
export const SOURCE_ITEM_KIND = {
  MESSAGE: 'message',
  DOCUMENT: 'document',
} as const;
export type SourceItemKind = (typeof SOURCE_ITEM_KIND)[keyof typeof SOURCE_ITEM_KIND];
export const SOURCE_ITEM_KINDS = Object.values(SOURCE_ITEM_KIND) as SourceItemKind[];

/**
 * source_items.sensitivity. Policy exclusions are recorded in routing_ledger (skip_reason, exclusion_rule,
 * policy_version), never here: an excluded message has no source_items row. `restricted` is reserved for a future
 * linked-but-unread tier (#263 T10); nothing writes it today.
 */
export const ITEM_SENSITIVITY = {
  STANDARD: 'standard',
  RESTRICTED: 'restricted',
} as const;
export type ItemSensitivity = (typeof ITEM_SENSITIVITY)[keyof typeof ITEM_SENSITIVITY];
export const ITEM_SENSITIVITIES = Object.values(ITEM_SENSITIVITY) as ItemSensitivity[];

/** deal_candidates.deal_side. Buy-side is labeled, never mapped (ADR-007). */
export const DEAL_SIDE = {
  SELL: 'sell',
  BUY: 'buy',
  UNKNOWN: 'unknown',
} as const;
export type DealSide = (typeof DEAL_SIDE)[keyof typeof DEAL_SIDE];
export const DEAL_SIDES = Object.values(DEAL_SIDE) as DealSide[];

/** audit_log.service_identity of the classification worker's rows. */
export const DISCOVERY_WORKER_SERVICE_IDENTITY = 'discovery-worker';

/** The caller the guard records for the owner's guarded Microsoft recording (#318): its refusals are audited under this name. */
export const M365_RECORDER_SERVICE_IDENTITY = 'm365-recorder';

/**
 * Which reader the worker uses (DISCOVERY_READER_MODE, #259 C12). `live` reads
 * every provider through its real reader; `graph` is the old name of the same
 * mode (GRAPH_READER_PROVIDER), kept as an alias for one release. Moved here
 * from the reader so scripts need not import it.
 */
export const READER_MODE = {
  FIXTURE: 'fixture',
  GRAPH: 'graph',
  LIVE: 'live',
} as const;
export type ReaderMode = (typeof READER_MODE)[keyof typeof READER_MODE];

/**
 * Two reader limits the operator scripts also need: the fake Graph tenant pages
 * like the fixture reader, and the recorder bounds a download as the reader
 * does. Here, not in the reader, so a script need not import a reader for a
 * number (#262). src/lib/graph/reader/{fixture,extractText}.ts import them.
 */
export const FIXTURE_PAGE_SIZE = 4;
/** Larger files are ledgered as too_large and never downloaded. */
export const EXTRACT_MAX_BYTES = 25 * 1024 * 1024;

/** mailbox_guard_state.last_reason, and what mailbox_guard_check returns. */
export const MAILBOX_REFUSAL_REASON = {
  NO_INVITE: 'no_invite',
  SEAT_INACTIVE: 'seat_inactive',
  EXTERNAL: 'external',
  NO_CONSENT: 'no_consent',
  DOMAIN: 'domain',
  OWNER_MISMATCH: 'owner_mismatch',
  NOT_IN_PROVIDER_GROUP: 'not_in_provider_group',
  MIRROR_UNAVAILABLE: 'mirror_unavailable',
  /** The source's provider has no active registration for the tenant (C5). Site refusals use it too. */
  REGISTRATION_INACTIVE: 'registration_inactive',
  /** The caller reads through another provider than the source's content_sources.provider (audit round 2, item 6). */
  PROVIDER_MISMATCH: 'provider_mismatch',
  /** The address has no content_sources mailbox row, so no provider to judge it by (audit round 3, item 6). Every purpose. */
  NO_SOURCE: 'no_source',
  /**
   * The source is not active. The guard now says what the worker used to skip on its own, for every purpose, so the
   * member's `readingReason` and the guard cannot disagree (audit round 3, M6). A narrowing: it admits less, never more.
   */
  SOURCE_PAUSED: 'source_paused',
  /**
   * A team inbox (#581) the Google Directory has not confirmed: never, since refused, or not within
   * TEAM_MAILBOX_READ_WINDOW_MINUTES. Only the guard's read verdict says it; visibility never depends on it.
   */
  TEAM_MAILBOX_UNVERIFIED: 'team_mailbox_unverified',
  /** A team inbox whose registration was closed (#581). */
  TEAM_MAILBOX_DISCONNECTED: 'team_mailbox_disconnected',
  /** A team inbox whose address is now a user's or an invite's: a person's mailbox, which a team registration may not be (#581). */
  TEAM_MAILBOX_PERSON: 'team_mailbox_person',
} as const;
export type MailboxRefusalReason = (typeof MAILBOX_REFUSAL_REASON)[keyof typeof MAILBOX_REFUSAL_REASON];
export const MAILBOX_REFUSAL_REASONS = Object.values(MAILBOX_REFUSAL_REASON) as MailboxRefusalReason[];

/**
 * mailbox_consent_status().readingReason, and the same key in mailbox_consent_grant()'s result: why a member's
 * mailbox is not read, or null when `reading` is true. `reading` is database eligibility (audit round 3, H2; owner
 * decision D2): true exactly when mailbox_guard_check allows the member's address, because both ask one decision,
 * mailbox_guard_verdict (20261001130000_mailbox_allowlist.sql). It does not say a pass is running or will read.
 * The reasons are the guard's own, in the guard's order and vocabulary (a subset of MAILBOX_REFUSAL_REASON: the
 * caller's provider reasons are not a member's), plus three about the member: DOMAIN and NOT_ON_A_DEAL come before
 * the verdict, and NO_INVITE is what mailbox_consent_status reports for a caller with no seat, whatever the guard's
 * cause. Each is spelled once, from the guard's constants where it is the guard's.
 */
export const MAILBOX_READING_REASON = {
  /** No seat: no accepted own-firm invitation, or the registration is paused. Also the guard's own no_invite. */
  NO_INVITE: MAILBOX_REFUSAL_REASON.NO_INVITE,
  /** Seated, but no provider's registration lists the address's domain for the firm. Also the guard's own domain. */
  DOMAIN: MAILBOX_REFUSAL_REASON.DOMAIN,
  /** No open consent, and the member is not MD or deal team on any deal of their tenant, so a grant is refused. */
  NOT_ON_A_DEAL: 'not_on_a_deal',
  /** No content_sources mailbox row for the address (the guard's first test, before consent). */
  NO_SOURCE: MAILBOX_REFUSAL_REASON.NO_SOURCE,
  /** No open consent on the seated invite. */
  NO_CONSENT: MAILBOX_REFUSAL_REASON.NO_CONSENT,
  /** The row has no owner, or belongs to someone else. */
  OWNER_MISMATCH: MAILBOX_REFUSAL_REASON.OWNER_MISMATCH,
  /** The row is not active. */
  SOURCE_PAUSED: MAILBOX_REFUSAL_REASON.SOURCE_PAUSED,
  /** The row is on a provider whose registration is not active. */
  REGISTRATION_INACTIVE: MAILBOX_REFUSAL_REASON.REGISTRATION_INACTIVE,
  /** The row is on a provider whose registration does not name the member's company as the firm. */
  EXTERNAL: MAILBOX_REFUSAL_REASON.EXTERNAL,
  /** The member's invite is accepted but the seat is not live. */
  SEAT_INACTIVE: MAILBOX_REFUSAL_REASON.SEAT_INACTIVE,
} as const;
export type MailboxReadingReason = (typeof MAILBOX_READING_REASON)[keyof typeof MAILBOX_READING_REASON];
export const MAILBOX_READING_REASONS = Object.values(MAILBOX_READING_REASON) as MailboxReadingReason[];

/** What site_guard_check returns (R23, 20261001180000_site_allowlist.sql). */
export const SITE_REFUSAL_REASON = {
  SITE_NOT_REGISTERED: 'site_not_registered',
  SITE_WRONG_FIRM: 'site_wrong_firm',
  /** An open registration whose registrant no longer stands (suspended, removed, external, not an admin) (audit round 3, L8). */
  SITE_REGISTRANT_LOST: 'site_registrant_lost',
  REGISTRATION_INACTIVE: 'registration_inactive',
} as const;
export type SiteRefusalReason = (typeof SITE_REFUSAL_REASON)[keyof typeof SITE_REFUSAL_REASON];
export const SITE_REFUSAL_REASONS = Object.values(SITE_REFUSAL_REASON) as SiteRefusalReason[];

/** Every refusal reason: mailbox_guard_state.last_reason's CHECK, and MailboxAccessRefusedError.reason. */
export type SourceRefusalReason = MailboxRefusalReason | SiteRefusalReason;
// registration_inactive is in both lists (either guard returns it), so it appears once.
export const SOURCE_REFUSAL_REASONS: SourceRefusalReason[] = [
  ...new Set<SourceRefusalReason>([...MAILBOX_REFUSAL_REASONS, ...SITE_REFUSAL_REASONS]),
];

/**
 * The reader pass record (#370): one per discovery reader attempt. `status` is the worker's own (SyncResult's, the
 * handler's, or 'failed' for a throw); `reason` is a fixed code beside it. The admin and CCO see READER_PASS_GROUP.
 * Mirrors discovery_reader_pass_valid() (20261006120000_discovery_reader_pass.sql).
 */
export const READER_PASS_STATUS = {
  COMPLETE: 'complete',
  PAGE_LIMIT: 'page_limit',
  RESET: 'reset',
  PAUSED: 'paused',
  HALTED: 'halted',
  DISABLED: 'disabled',
  SKIPPED: 'skipped',
  REFUSED: 'refused',
  FAILED: 'failed',
} as const;
export type ReaderPassStatus = (typeof READER_PASS_STATUS)[keyof typeof READER_PASS_STATUS];

export const READER_PASS_REASON = {
  PAGE_LIMIT: 'page_limit',
  HISTORY_EXPIRED: 'history_expired',
  FLAG_OFF: 'flag_off',
  HISTORY_WINDOW_EXCEEDED: 'history_window_exceeded',
  // runOnce: another source's failure stopped the run before this source was read (R2-m10).
  RUN_ABORTED: 'run_aborted',
  NO_EXCLUSION_POLICY: 'no_exclusion_policy',
  EXCLUSION_POLICY_INVALID: 'exclusion_policy_invalid',
  EXCLUSION_NOT_ENFORCED: 'exclusion_not_enforced',
  DELEGATION_REFUSED: 'delegation_refused',
  // A provider or credential call outlived its deadline (TimeoutError); the job retries.
  REQUEST_TIMEOUT: 'request_timeout',
} as const;

export const READER_PASS_GROUP = {
  COMPLETED: 'completed',
  CONTINUED: 'continued',
  STOPPED: 'stopped',
  REFUSED: 'refused',
  FAILED: 'failed',
} as const;
export type ReaderPassGroup = (typeof READER_PASS_GROUP)[keyof typeof READER_PASS_GROUP];

/** A pass with no end reads "In progress" this long, then "No end recorded": the discovery.sync expiry (worker/boss.ts). */
export const READER_PASS_IN_PROGRESS_SECONDS = 3600;

/**
 * One state per source in ingestion health, decided by discovery_source_health_state()
 * (20261008220000_discovery_reader_liveness_health.sql): first match, in this (the SQL CASE) order.
 */
export const SOURCE_HEALTH_STATE = {
  PAUSED: 'paused',
  HALTED: 'halted',
  SWITCHED_OFF: 'switched_off',
  DELEGATION_BROKEN: 'delegation_broken',
  WAITING: 'waiting',
  FAILING: 'failing',
  NOT_STARTED: 'not_started',
  READING: 'reading',
  UP_TO_DATE: 'up_to_date',
  STALE: 'stale',
} as const;
export type SourceHealthState = (typeof SOURCE_HEALTH_STATE)[keyof typeof SOURCE_HEALTH_STATE];
export const SOURCE_HEALTH_STATES = Object.values(SOURCE_HEALTH_STATE) as SourceHealthState[];

/** The reader line, in the SQL CASE order (r7). */
export const READER_HEALTH_STATE = {
  SWITCHED_OFF: 'switched_off',
  IDLE: 'idle',
  NOT_READING: 'not_reading',
  READING: 'reading',
  ACTIVE: 'active',
} as const;
export type ReaderHealthState = (typeof READER_HEALTH_STATE)[keyof typeof READER_HEALTH_STATE];
export const READER_HEALTH_STATES = Object.values(READER_HEALTH_STATE) as ReaderHealthState[];

/**
 * The one liveness window (discovery_reader_live), for both the source row and the reader line: a source reads
 * Reading while its unfinished pass's last progress (content_sources.reader_progress_at, or the pass start before
 * the first) is this recent, and the line reads Not reading when no readable source has recorded anything this
 * recently. Three ticks, #387's no-tick alarm window.
 *
 * Sized against the longest stretch with no progress mark under #412's bounded reads. Progress is marked after every
 * successful provider response and every token (READER_PROGRESS_MARK_SECONDS apart at most), not per page: a Gmail
 * page is up to 25 requests (MAX_GMAIL_REQUESTS_PER_PAGE), and each request may take 6 attempts of up to 60 s with
 * waits of up to 64 s between them (680 s), so a page could run for hours under retries. The longest unmarked
 * stretch is a delegated-token mint: signJwt's 6 attempts, each fetching the caller token (15 s) and waiting for its
 * response (60 s), 5 waits of up to 64 s, then the 15 s exchange, 6 x 75 + 5 x 64 + 15 = 785 s; with the 60 s
 * throttle, 845 s, inside 900 s. Until #412 merges, Google requests, the caller token and the token exchange have no
 * deadline, and Graph requests have none at all (follow-up F4): a hung request then reads Stale after 900 s, which is
 * what it is.
 */
export const READER_LIVENESS_SECONDS = 900;

/** The worker writes a source's progress mark at most this often while a pass reads (worker/progress.ts). */
export const READER_PROGRESS_MARK_SECONDS = 60;

/** mailbox_guard_check's p_purpose. provider_read audits on change; the rest audit every refusal. */
export const MAILBOX_GUARD_PURPOSE = {
  PROVIDER_READ: 'provider_read',
  AGENT_TOOL: 'agent_tool',
  SEARCH: 'search',
  RETRIEVAL: 'retrieval',
  EXPORT: 'export',
} as const;
export type MailboxGuardPurpose = (typeof MAILBOX_GUARD_PURPOSE)[keyof typeof MAILBOX_GUARD_PURPOSE];
export const MAILBOX_GUARD_PURPOSES = Object.values(MAILBOX_GUARD_PURPOSE) as MailboxGuardPurpose[];

/**
 * Who reads a mailbox: content_sources.provider and allowed_mailboxes.provider
 * (each mailbox is checked against its own provider's registration, C5) and
 * mailbox_allowlist_drift.provider (whose group mirrors the allowlist).
 */
export const MAILBOX_PROVIDER = { MICROSOFT: 'microsoft', GOOGLE: 'google' } as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDER)[keyof typeof MAILBOX_PROVIDER];
export const MAILBOX_PROVIDERS = Object.values(MAILBOX_PROVIDER) as MailboxProvider[];

/** mailbox_allowlist_drift.status. */
export const DRIFT_STATUS = { IN_SYNC: 'in_sync', DRIFT: 'drift', UNAVAILABLE: 'unavailable' } as const;
export type DriftStatus = (typeof DRIFT_STATUS)[keyof typeof DRIFT_STATUS];
export const DRIFT_STATUSES = Object.values(DRIFT_STATUS) as DriftStatus[];

/**
 * stage_assessments.trigger: what caused an assessment (20261002200000_discovery_milestones.sql; 'purge', the
 * tombstone a purge writes when it deleted a stream's latest row, from 20261023130100_discovery_scoped_assessments.sql).
 */
export const STAGE_TRIGGER = { EXTRACTION: 'extraction', CORRECTION: 'correction', RERUN: 'rerun', PURGE: 'purge' } as const;
export type StageTrigger = (typeof STAGE_TRIGGER)[keyof typeof STAGE_TRIGGER];
export const STAGE_TRIGGERS = Object.values(STAGE_TRIGGER) as StageTrigger[];

/** stage_assessments.flags elements. */
export const ASSESSMENT_FLAG = {
  CONFLICT: 'conflict',
  STATION_REMOVED: 'station_removed',
  OVERRIDDEN: 'overridden',
} as const;
export type AssessmentFlagValue = (typeof ASSESSMENT_FLAG)[keyof typeof ASSESSMENT_FLAG];
export const ASSESSMENT_FLAGS = Object.values(ASSESSMENT_FLAG) as AssessmentFlagValue[];

/** model_calls.outcome: ok (zero events included) and invalid settle an item; failed retries. */
export const MODEL_CALL_OUTCOME = { OK: 'ok', INVALID: 'invalid', FAILED: 'failed' } as const;
export type ModelCallOutcome = (typeof MODEL_CALL_OUTCOME)[keyof typeof MODEL_CALL_OUTCOME];
export const MODEL_CALL_OUTCOMES = Object.values(MODEL_CALL_OUTCOME) as ModelCallOutcome[];

/** model_calls.transport. */
export const MODEL_CALL_TRANSPORT = { GATEWAY: 'gateway', RECORDED: 'recorded' } as const;
export type ModelCallTransport = (typeof MODEL_CALL_TRANSPORT)[keyof typeof MODEL_CALL_TRANSPORT];
export const MODEL_CALL_TRANSPORTS = Object.values(MODEL_CALL_TRANSPORT) as ModelCallTransport[];

/**
 * discovery_model_proposals.outcome (20261014120000_discovery_model_proposals.sql), the demo-only
 * deal proposal step (#460; delete with it when #459 lands). Every value settles a message; a
 * transport failure is never written.
 */
export const PROPOSAL_OUTCOME = { DEAL: 'deal', NOT_DEAL: 'not_deal', INVALID: 'invalid' } as const;
export type ProposalOutcome = (typeof PROPOSAL_OUTCOME)[keyof typeof PROPOSAL_OUTCOME];
export const PROPOSAL_OUTCOMES = Object.values(PROPOSAL_OUTCOME) as ProposalOutcome[];

/**
 * discovery_tenant_approvals.capability (20261023110100_discovery_tenant_approvals.sql, G-01 #173): what an owner
 * approved for one firm company in one tenant. The table is written by reviewed migrations only. team_proposals also
 * needs a reviewed TS entry (TEAM_PROPOSAL_FIRMS); the other two need only their row.
 */
export const TENANT_CAPABILITY = {
  TEAM_PROPOSALS: 'team_proposals',
  MILESTONE_RULES: 'milestone_rules',
  FIRM_NAME_ALIAS: 'firm_name_alias',
} as const;
export type TenantCapability = (typeof TENANT_CAPABILITY)[keyof typeof TENANT_CAPABILITY];
export const TENANT_CAPABILITIES = Object.values(TENANT_CAPABILITY) as TenantCapability[];

/**
 * discovery_team_proposal_passes.outcome (20261023110200_discovery_team_proposal_pass.sql, G-01 #173): how an AI pass
 * over a team inbox ended. The worker passes any value but `unclosed`; a later begin writes `unclosed` for a pass
 * whose lease lapsed without an end.
 */
export const TEAM_PROPOSAL_PASS_OUTCOME = {
  COMPLETE: 'complete',
  PAGE_LIMIT: 'page_limit',
  PAUSED: 'paused',
  REFUSED: 'refused',
  REVOKED: 'revoked',
  ARCHIVED: 'archived',
  ERROR: 'error',
  ZDR_UNAVAILABLE: 'zdr_unavailable',
  LEDGER: 'ledger',
  FAILURE_STREAK: 'failure_streak',
  UNCLOSED: 'unclosed',
} as const;
export type TeamProposalPassOutcome = (typeof TEAM_PROPOSAL_PASS_OUTCOME)[keyof typeof TEAM_PROPOSAL_PASS_OUTCOME];
export const TEAM_PROPOSAL_PASS_OUTCOMES = Object.values(TEAM_PROPOSAL_PASS_OUTCOME) as TeamProposalPassOutcome[];

/** stage_assessments.lifecycle_suggestion. */
export const LIFECYCLE_SUGGESTION = {
  LIVE: 'live',
  CLOSED: 'closed',
  TERMINATED: 'terminated',
  MANDATE_HOLD: 'mandate_hold',
} as const;
export type LifecycleSuggestion = (typeof LIFECYCLE_SUGGESTION)[keyof typeof LIFECYCLE_SUGGESTION];
export const LIFECYCLE_SUGGESTIONS = Object.values(LIFECYCLE_SUGGESTION) as LifecycleSuggestion[];

/**
 * corrections.action (20261002210000_discovery_corrections.sql): what a person did to a proposed deal.
 * ACCEPT_PROPOSAL (G-02b #173, 20261023140200_model_proposal_accept_checks.sql) is written by the worker's finish
 * definer for the person who accepted a model-only proposal.
 */
export const CORRECTION_ACTION = {
  RENAME: 'rename',
  REJECT: 'reject',
  SET_STATION: 'set_station',
  MERGE: 'merge',
  SPLIT: 'split',
  REASSIGN: 'reassign',
  CONFIRM_LINK: 'confirm_link',
  REJECT_LINK: 'reject_link',
  PROMOTE: 'promote',
  DISMISS_SUGGESTION: 'dismiss_suggestion',
  ACCEPT_PROPOSAL: 'accept_proposal',
} as const;
export type CorrectionAction = (typeof CORRECTION_ACTION)[keyof typeof CORRECTION_ACTION];
export const CORRECTION_ACTIONS = Object.values(CORRECTION_ACTION) as CorrectionAction[];

/**
 * Tables and views whose rows come from, or name, a mailbox or a registered
 * SharePoint site (#262, R14, R23).
 * Agents, tools, search and retrieval reach them only through
 * @/lib/mailboxAccess/accessors. tests/mailbox-table-classification.test.ts
 * fails when any table or view is in neither list.
 */
export const MAILBOX_DERIVED_TABLES = [
  'content_sources', 'routing_ledger', 'source_items', 'source_item_sources', 'source_item_texts',
  // Weekly per-mailbox counts; shared control plane until #264, then moves with E1 (ADR-0017).
  'send_census_weekly',
  'deal_candidates', 'evidence_links', 'candidate_visibility',
  'mailbox_consents', 'mailbox_guard_state', 'mailbox_allowlist_drift',
  'mailbox_seated_invites', 'allowed_mailboxes',
  // The firm-owned registry of admin-managed team inboxes (#581): addresses and check results, no mail.
  'team_mailboxes',
  // The team half of the allowlist (#581): a view over that registry.
  'allowed_team_mailboxes',
  // The people the firm's admin lets read a team inbox, and the view of those who still may (#581): ids, no mail.
  'team_mailbox_members', 'team_mailbox_readers',
  'registered_sites', 'allowed_sites',
  // Model outputs about mail (20261002200000_discovery_milestones.sql, ADR-0017 decision 1).
  'milestone_events', 'stage_assessments', 'model_calls', 'discovery_recompute_requests',
  // The rule detector's settle ledger (#173 G-07 slice 3b): ids, a hash, a version and the detection's own answer
  // (types, dates and offsets, never a quote).
  'milestone_detections',
  // The bound a live extraction run is held to (20261021190000, #261): ids and numbers describing the routed set:
  // counts, byte sizes, tokens, dollars; no text.
  'discovery_extract_budgets', 'discovery_extract_budget_items',
  // The MD's decisions, whose before and after name candidates (20261002210000_discovery_corrections.sql).
  'corrections',
  // The thread ids a thread-scoped exclusion rule excluded, per mailbox source (#263): named only in persist.ts.
  'discovery_thread_taints',
  // When a successful group check first saw a consented address in its group, and first and last saw it missing (#461).
  'mailbox_group_absence',
  // One row per message per mailbox processed: identifiers, digest, tags and versions, no content (#461).
  'discovery_message_index',
  // The demo-only deal proposal step's answers about unrouted mail (#460): hashes, domains and a deal name, no text.
  'discovery_model_proposals',
  // The audited pass over a team inbox (G-01 #173): ids, the path, an outcome and integer counts, no text.
  'discovery_team_proposal_passes',
  // The owner's dismissals of those proposals (G-02a #173): ids, the deal key and times, no text.
  'discovery_model_proposal_dismissals',
  // The owner's requests to accept a model-only proposal (G-02b #173): ids, hashes, the deal key and counts, no text.
  'discovery_model_proposal_accepts',
] as const;

/**
 * What the tenant purge (#461) does with each mailbox-derived table. A table
 * in TENANT_PURGE_TABLES must hold no row of the tenant matching its predicate
 * once the purge has run (legal-hold residue aside). The predicate is SQL over
 * the table aliased `t`, with `:'tenant'` the psql variable naming the tenant.
 * Every other mailbox-derived table is in TENANT_PURGE_KEPT, with the reason.
 * tests/mailbox-table-classification.test.ts fails when a mailbox-derived
 * table is in neither, so a new one must be given a purge fate on purpose.
 * SharePoint site content is out of G0's scope: only mail rows are named.
 */
export const TENANT_PURGE_TABLES = {
  content_sources: "t.tenant_id = :'tenant' and t.kind = 'mailbox'",
  routing_ledger:
    "t.source_id in (select s.id from content_sources s where s.tenant_id = :'tenant' and s.kind = 'mailbox')",
  source_items: "t.tenant_id = :'tenant' and t.kind = 'message'",
  source_item_sources:
    "t.content_source_id in (select s.id from content_sources s where s.tenant_id = :'tenant' and s.kind = 'mailbox')",
  source_item_texts:
    "t.source_item_id in (select i.id from source_items i where i.tenant_id = :'tenant' and i.kind = 'message')",
  discovery_thread_taints:
    "t.source_id in (select s.id from content_sources s where s.tenant_id = :'tenant' and s.kind = 'mailbox')",
  evidence_links:
    "t.source_item_id in (select i.id from source_items i where i.tenant_id = :'tenant' and i.kind = 'message')",
  milestone_events: "t.tenant_id = :'tenant' and t.source_item_id in (select i.id from source_items i where i.kind = 'message')",
  model_calls: "t.tenant_id = :'tenant' and t.source_item_id in (select i.id from source_items i where i.kind = 'message')",
  // The rule detector's ledger (#173 G-07 slice 3b): it goes with its message (on delete cascade).
  milestone_detections:
    "t.tenant_id = :'tenant' and t.source_item_id in (select i.id from source_items i where i.kind = 'message')",
  deal_candidates:
    "t.tenant_id = :'tenant' and not exists (select 1 from evidence_links l where l.candidate_id = t.id)",
  candidate_visibility:
    "t.candidate_id in (select c.id from deal_candidates c where c.tenant_id = :'tenant' and not exists (select 1 from evidence_links l where l.candidate_id = c.id))",
  discovery_recompute_requests:
    "t.tenant_id = :'tenant' and not exists (select 1 from evidence_links l where l.candidate_id = t.candidate_id)",
  stage_assessments:
    "t.tenant_id = :'tenant' and exists (select 1 from unnest(t.evidence_event_ids) e where not exists (select 1 from milestone_events m where m.id = e))",
  corrections:
    "t.tenant_id = :'tenant' and not exists (select 1 from evidence_links l where l.candidate_id = t.candidate_id)",
  mailbox_guard_state: "t.tenant_id = :'tenant' and position('@' in t.address) > 0",
  mailbox_allowlist_drift: "t.tenant_id = :'tenant'",
  mailbox_group_absence: "t.tenant_id = :'tenant'",
  // Every row indexes a message: exported into the report, then deleted.
  discovery_message_index: "t.tenant_id = :'tenant'",
  // Develop's demo-only proposal answers (#460): they go with their mailbox source (on delete cascade).
  discovery_model_proposals: "t.tenant_id = :'tenant'",
  // The team inbox passes (G-01 #173): ids and counts; they go with their mailbox source (on delete cascade).
  discovery_team_proposal_passes: "t.tenant_id = :'tenant'",
  // Their dismissals (G-02a #173): they go with their mailbox source (on delete cascade).
  discovery_model_proposal_dismissals: "t.tenant_id = :'tenant'",
  // Their accept requests (G-02b #173): they go with their mailbox source (on delete cascade).
  discovery_model_proposal_accepts: "t.tenant_id = :'tenant'",
  // The extraction budgets (#261): ids and numbers, deleted by the purge; their cohort rows go with them (cascade).
  discovery_extract_budgets: "t.tenant_id = :'tenant'",
  discovery_extract_budget_items:
    "t.budget_id in (select b.id from discovery_extract_budgets b where b.tenant_id = :'tenant')",
  // The send census's weekly counts (#425): no address or content; they go with their mailbox source (on delete cascade).
  send_census_weekly: "t.tenant_id = :'tenant'",
} as const satisfies Partial<Record<(typeof MAILBOX_DERIVED_TABLES)[number], string>>;

export const TENANT_PURGE_KEPT = {
  mailbox_consents: 'The record of who opted in and when: addresses and ids, no mail content.',
  mailbox_seated_invites: 'A view over invites and users; it stores nothing.',
  allowed_mailboxes: 'A view over consents and seats; it stores nothing.',
  team_mailboxes: 'The registry of admin-managed team inboxes (#581): addresses, check results and ids, no mail content.',
  allowed_team_mailboxes: 'A view over the team inbox registry; it stores nothing.',
  team_mailbox_members: 'Who the firm admin let read a team inbox and when (#581): user ids and times, no mail content.',
  team_mailbox_readers: 'A view over members, registrations and seats; it stores nothing.',
  registered_sites: 'SharePoint site registrations: out of G0 scope, not mail.',
  allowed_sites: 'A view over site registrations; it stores nothing.',
} as const satisfies Partial<Record<(typeof MAILBOX_DERIVED_TABLES)[number], string>>;

/**
 * Every other public table and view, listed so a new one must be classified.
 * graph_reader_registrations and google_reader_registrations hold tenant
 * identifiers, service-account names, domains and a group name, not mail;
 * discovery_exclusion_policies is the bank's configuration (rule ids, labels,
 * domains it never wants read), not mail;
 * mailbox_connections is the send-as feature's OAuth state, not a read source;
 * mail_warning_outcomes is an anonymous daily count from the composer, no mail;
 * firm_compliance_settings is the CCO's band thresholds and send friction, no mail;
 * discovery_tenant_approvals is the owner's per-tenant capability switches, no mail.
 */
export const NOT_MAILBOX_DERIVED_TABLES = [
  'access_requests',
  'ai_budget_alerts',
  'ai_budgets',
  'ai_usage',
  'audit_log',
  'companies',
  'company_member_access',
  'company_member_permissions',
  'company_member_roles',
  'company_permissions',
  'company_role_permissions',
  'company_roles',
  'company_verified_domains',
  'crm_people',
  'datarooms',
  'deal_memberships',
  'deal_parties',
  'deal_recipient_affiliations',
  'deal_skill_imports',
  'deal_step_skill_bindings',
  'deal_step_skill_runs',
  'deal_steps',
  'deal_template_change_decisions',
  'deals',
  'discovery_exclusion_policies',
  // The owner's per-tenant switches (G-01 #173): ids, a capability code and a decision reference; no mail.
  'discovery_tenant_approvals',
  'documents',
  'feature_flags',
  'firm_compliance_settings',
  'firm_identity_providers',
  'google_reader_registrations',
  'graph_reader_registrations',
  'inbound_messages',
  'invite_domain_confirmations',
  'invites',
  'lead_documents',
  'lead_intel',
  'lead_personas',
  'lead_relationship_paths',
  'lead_relationships',
  'lead_research',
  'lead_stakeholders',
  'legal_holds',
  'mail_warning_outcomes',
  'mailbox_connections',
  'notifications',
  'outbound_messages',
  'rail_catalog_changes',
  'rail_catalog_skill_drafts',
  'rail_catalog_steps',
  'rail_catalog_templates',
  'rail_template_creations',
  'rail_template_revisions',
  'rail_templates',
  'roles',
  'setup_walkthrough_progress',
  'skill_authoring_attempts',
  'skill_authoring_candidates',
  'skill_authoring_drafts',
  'skill_authoring_messages',
  'skill_comment_teachings',
  'skill_publication_operations',
  // A tenant's retention choices (#461): lifecycle and what a purge deletes, no mail.
  'tenant_retention_policies',
  'users',
  'work_identity_attempts',
  'work_identity_bindings',
  'work_identity_broker_aliases',
  'work_identity_connect_intents',
] as const;

/**
 * The group-removal breaker (#461, D93; owner, 2026-10-17): the arguments the tick passes to
 * discovery_withdraw_group_removed. A tenant is held when at least `minDue` consents are due at once and they are
 * more than `maxShare` of its open consents; an operator who has checked the group releases it
 * (`p_max_share => 1`, runbook). The pilot holds every group-triggered withdrawal. The general rule holds more than
 * 30% of a tenant's open consents, and at least 3. The function's own defaults are the pilot values.
 */
export const GROUP_REMOVAL_BREAKER = {
  pilot: { maxShare: 0, minDue: 1 },
  general: { maxShare: 0.3, minDue: 3 },
} as const;
/** The rule the tick applies today: the pilot's. */
export const GROUP_REMOVAL_BREAKER_ACTIVE = GROUP_REMOVAL_BREAKER.pilot;
