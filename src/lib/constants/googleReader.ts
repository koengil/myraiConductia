import { TABLE } from '@/lib/constants/tables';

// The registration statuses live in constants/discovery.ts (they are the same
// three states as the Graph registration's); re-exported for the Google code.
export { GOOGLE_REGISTRATION_STATUSES } from '@/lib/constants/discovery';

/** google_reader_registrations (20261002175000_google_reader_registrations.sql): an alias of TABLE.GOOGLE_READER_REGISTRATIONS. */
export const GOOGLE_READER_TABLE = TABLE.GOOGLE_READER_REGISTRATIONS;

/** The only scopes the reader may mint (R13, R14). The reader uses READONLY
 * until the metadata level lands (plan D2); METADATA is probed, not used. */
export const GMAIL_READER_SCOPE = {
  METADATA: 'https://www.googleapis.com/auth/gmail.metadata',
  READONLY: 'https://www.googleapis.com/auth/gmail.readonly',
} as const;
export type GmailReaderScope = (typeof GMAIL_READER_SCOPE)[keyof typeof GMAIL_READER_SCOPE];

/** Scopes used only by operator tooling or by the directory identity, never by the mail reader. */
export const GOOGLE_TOOL_SCOPE = {
  IAM: 'https://www.googleapis.com/auth/iam',
  GMAIL_MODIFY_OVERGRANT_PROBE: 'https://www.googleapis.com/auth/gmail.modify',
  GMAIL_INSERT_SEEDING: 'https://www.googleapis.com/auth/gmail.insert',
  DRIVE_FILE_SEEDING: 'https://www.googleapis.com/auth/drive.file',
  DRIVE_READONLY_PROBE: 'https://www.googleapis.com/auth/drive.readonly',
  DIRECTORY_MEMBERS: 'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
  /** users.get, to check that a team inbox address is a real user mailbox (#581). Needs the directory role's Users read. */
  DIRECTORY_USERS: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
  REPORTS_AUDIT: 'https://www.googleapis.com/auth/admin.reports.audit.readonly',
} as const;

/**
 * What the directory identity's token carries, on both mint paths (the directory credential's own token and the
 * generateAccessToken fallback): the allowlist group's members (the mirror) and a user lookup (the team inbox
 * check, #581). One token serves both, so the two scopes always travel together.
 */
export const DIRECTORY_SCOPES = [GOOGLE_TOOL_SCOPE.DIRECTORY_MEMBERS, GOOGLE_TOOL_SCOPE.DIRECTORY_USERS] as const;

/** Origins a Google token may be sent to. Anything else is refused before a request. */
export const GOOGLE_ALLOWED_ORIGINS = [
  'https://gmail.googleapis.com',
  'https://admin.googleapis.com',
  'https://iamcredentials.googleapis.com',
  'https://oauth2.googleapis.com',
  'https://www.googleapis.com', // Drive v3 (probe and seeding only)
] as const;

// ── The two-step read's queries (#263) ──────────────────────────────────────
// One list, shared by the reader, the twin builder and the recorder, so the three
// can never drift (tests/google/replay-coverage.test.ts fails if a replay lacks a
// request the reader makes). Every listing and metadata call sends a `fields`
// mask: Gmail's `snippet` (about 200 characters of the body) is never asked for,
// so no body excerpt crosses before the exclusion policy has run. A mask is a
// standard Google partial-response parameter.

/**
 * The headers a metadata read asks for, before the exclusion verdict: only what the
 * verdict and the skip ledger use (#337). The address headers feed participant rules;
 * `Sensitivity` (RFC 4021) and `msip_labels` (Microsoft Purview) are the marker headers;
 * Message-ID is the skipped item's hash input (metadataHash). Nothing else is asked
 * for: a stored message takes its subject, date and threading keys from the raw
 * parse, after the verdict, so an excluded message's subject never crosses.
 * Bcc is expected on the sender's own copy only; a live format=metadata read of a Sent copy returned it on
 * 2026-10-13 (thread O1, #454), so a Bcc-only rule excludes the sender's copy before any raw fetch;
 * Reply-To and Sender are sender-controlled, so a match there only ever excludes (accepted, #337 design A1).
 * The order is part of every replay key: regenerate the replays when it changes.
 */
export const GMAIL_METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Bcc',
  'Reply-To',
  'Sender',
  'Message-ID',
  'Sensitivity',
  'msip_labels',
] as const;
export const GMAIL_METADATA_HEADERS_QUERY = GMAIL_METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join('&');

/** One message of a metadata response: ids, labels, time, headers, and the Workspace classification values. No snippet, size or payload tree. */
export const GMAIL_MESSAGE_FIELDS = 'id,threadId,labelIds,internalDate,historyId,payload/headers,classificationLabelValues';
/** messages.get?format=metadata. */
export const GMAIL_METADATA_QUERY = `format=metadata&${GMAIL_METADATA_HEADERS_QUERY}&fields=${GMAIL_MESSAGE_FIELDS}`;
/** threads.get?format=metadata. */
export const GMAIL_THREAD_METADATA_QUERY = `format=metadata&${GMAIL_METADATA_HEADERS_QUERY}&fields=id,historyId,messages(${GMAIL_MESSAGE_FIELDS})`;
/** threads.list: the listing carries each thread's snippet unless masked. */
export const GMAIL_THREAD_LIST_FIELDS = 'threads(id,historyId),nextPageToken';
/** history.list: ids, thread ids and labels only (a history Message may carry a snippet by schema). */
export const GMAIL_HISTORY_FIELDS =
  'history(id,messagesAdded/message(id,threadId,labelIds),labelsRemoved(message(id,threadId,labelIds),labelIds)),historyId,nextPageToken';
/** The metadata-token probes ask for content under a token that should be refused: masked, so a surprise 200 carries none. */
export const GMAIL_PROBE_RAW_FIELDS = 'id';
export const GMAIL_PROBE_SEARCH_FIELDS = 'threads(id)';

/** labels.list: only ids and names, which is all a label rule resolves (one request per pass, and only when a rule names a user label). */
export const GMAIL_LABELS_FIELDS = 'labels(id,name)';
/** Gmail's built-in label ids. A rule naming one needs no labels.list: the message carries the id itself. */
export const GMAIL_SYSTEM_LABEL_IDS: ReadonlySet<string> = new Set([
  'INBOX',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH',
  'STARRED',
  'UNREAD',
  'IMPORTANT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
]);
/** Gmail applies SENT to every message this mailbox sent; users cannot remove it. */
export const GMAIL_SENT_LABEL = 'SENT';
/**
 * Whether Gmail is known to return `classificationLabelValues` on a metadata read, under the format and scope
 * in use (#263, R4). Google omits empty repeated fields, so an absent field cannot tell "no classification
 * label" from "not returned": until a recorded replay shows the field on a live read, an absent field is
 * `unavailable`, and a classification rule fails closed (policy_unevaluable). Flip it only with that
 * evidence (threads T1); a message that does carry the field is evaluated normally either way.
 */
export const GMAIL_CLASSIFICATION_FIELD_VERIFIED = false;
