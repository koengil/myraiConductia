// Sending as the banker's own Gmail (#490). The scopes the sending client asks
// for and accepts, the reasons a connect is refused, and the fixed copy the
// send path shows. Not a SQL mirror: nothing here is a CHECK enum.
//
// The sending client is separate from the DWD reader (src/lib/google/reader,
// ADR-0022 decision 3) and from Google sign-in. tests/email/gmail-scopes.test.ts
// pins these scopes; adding one is a design change, not a code change.

import { OperatorCopyError } from '@/lib/errors/upstream';

/** Send mail as the user. Google classes it Sensitive; it grants no read. */
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** How Google may report the `email` scope in a token response's granted list. */
export const GOOGLE_USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

/** What the sending client requests: sign-in scopes to learn the account, plus gmail.send (design Q2). */
export const GMAIL_SEND_REQUESTED_SCOPES = ['openid', 'email', GMAIL_SEND_SCOPE] as const;

/** Every scope a grant may hold. Anything else refuses the connect as scope_unexpected (R19). */
export const GMAIL_SEND_ALLOWED_GRANTED_SCOPES: ReadonlySet<string> = new Set([
  'openid',
  'email',
  GOOGLE_USERINFO_EMAIL_SCOPE,
  GMAIL_SEND_SCOPE,
]);

/** Why a Google connect for sending was refused; the card maps each to copy (`?mailbox=error&reason=`). */
export const GMAIL_CONNECT_REFUSAL = {
  /** The Google account is not the banker's own Conductia address, or its email is unverified, or its sub differs from the bound identity. */
  WRONG_ACCOUNT: 'wrong_account',
  /** A consumer account (no hd claim), or a Workspace domain that is not the firm's. */
  NOT_WORKSPACE: 'not_workspace',
  /** Google did not grant gmail.send. */
  SCOPE_MISSING: 'scope_missing',
  /** Google granted a scope Conductia did not ask for. */
  SCOPE_UNEXPECTED: 'scope_unexpected',
  /** The firm has no Google Workspace domain on record, so there is nothing to check hd against. */
  NO_FIRM_DOMAIN: 'no_firm_domain',
  /**
   * The caller is an external user (a counterparty or adviser invited into a
   * deal). Sending from Gmail is for the bank's own people only (owner
   * decision 2026-10-19): externals work through the deal's threads.
   */
  NOT_ELIGIBLE: 'not_eligible',
  /** The banker cancelled on Google's screen. */
  CANCELLED: 'cancelled',
  /** Anything else: a failed exchange, an unreadable id_token, a missing refresh token, a state mismatch. */
  FAILED: 'failed',
  /**
   * The connect was refused and the refusal could not be audited (#490 audit
   * follow-up): nothing was stored, and the banker is told the attempt was not
   * recorded rather than shown the refusal's own reason.
   */
  NOT_RECORDED: 'not_recorded',
} as const;

export type GmailConnectRefusal = (typeof GMAIL_CONNECT_REFUSAL)[keyof typeof GMAIL_CONNECT_REFUSAL];
export const GMAIL_CONNECT_REFUSALS = Object.values(GMAIL_CONNECT_REFUSAL) as GmailConnectRefusal[];

/**
 * The cookies that carry one Connect for sending round trip: the connect route
 * sets them (httpOnly, SameSite=Lax, 600 s) and the callback reads and clears
 * them. Named apart from the Microsoft flow's mailbox_oauth_state (R3).
 */
export const GMAIL_SEND_COOKIE = {
  STATE: 'gmail_send_state',
  VERIFIER: 'gmail_send_verifier',
  NEXT: 'gmail_send_next',
} as const;

/** How long a Connect for sending round trip may take, in seconds. */
export const GMAIL_SEND_COOKIE_MAX_AGE_S = 600;

// Fixed copy for the send path. The outbox shows OperatorCopyError messages as
// `Email provider send failed: <copy>` (providerFailureCopy.ts), so these read
// as the second half of that sentence. No input is ever interpolated.

/** Google ended the approval (any invalid_grant), or the row already reads revoked (design Q1). */
export const GMAIL_RECONNECT_COPY = 'Gmail approval ended; connect for sending again in Settings › Mail';

/** A Google connection exists but this environment has no sending client: fail closed, never the platform address (R11). */
export const GMAIL_UNCONFIGURED_COPY =
  'Gmail sending is switched off on this environment; disconnect in Settings › Mail to send from the platform address';

/** Google refused Conductia's own client (invalid_client, unauthorized_client): an operator problem, no banker is disconnected (R6). */
export const GMAIL_MISCONFIGURED_COPY = 'Gmail sending is misconfigured on this environment; tell the Conductia team';

/** The connection changed between the identity read and the send (R17): the send never re-routes. */
export const MAILBOX_CHANGED_COPY = 'Your sending mailbox changed. Send again.';

/** The mailbox connection could not be read: fail the send rather than read it as "no connection" (R21). */
export const MAILBOX_UNAVAILABLE_COPY = 'Mailbox connection unavailable';

/** Disconnect failed and changed nothing: the delete and its audit row are one transaction (#490 audit 2). */
export const MAILBOX_DISCONNECT_FAILED_COPY = 'Disconnect failed; the mailbox is still connected';

// The send path's refusals, built here beside their copy so each message is
// provably one of the fixed strings above: the content-egress guard (T1)
// accepts `new OperatorCopyError(X)` only when X is a literal or a const bound
// to one in the same file. A new error each call, so each carries its own stack.
export const gmailReconnectError = (): OperatorCopyError => new OperatorCopyError(GMAIL_RECONNECT_COPY);
export const gmailUnconfiguredError = (): OperatorCopyError => new OperatorCopyError(GMAIL_UNCONFIGURED_COPY);
export const gmailMisconfiguredError = (): OperatorCopyError => new OperatorCopyError(GMAIL_MISCONFIGURED_COPY);
export const mailboxChangedError = (): OperatorCopyError => new OperatorCopyError(MAILBOX_CHANGED_COPY);
