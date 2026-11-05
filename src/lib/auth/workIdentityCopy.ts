import { WORK_IDENTITY_ERROR, type WorkIdentityErrorCode } from '@/lib/constants/workIdentity';

// Client-safe: no node:crypto, so the profile page can show a connect result.
export type WorkIdentityRecovery =
  | 'switch_account'
  | 'retry'
  | 'ask_resend'
  | 'sign_in_then_connect'
  | 'connect'
  | 'resume_mfa'
  | 'open_invitation'
  | 'contact_admin';

const ERROR_COPY: Record<WorkIdentityErrorCode, { message: string; recovery: WorkIdentityRecovery }> = {
  [WORK_IDENTITY_ERROR.WRONG_ACCOUNT]: {
    message: 'This invitation was sent to a different address. Switch to the invited work account and try again.',
    recovery: 'switch_account',
  },
  [WORK_IDENTITY_ERROR.ALIAS_MISMATCH]: {
    message: 'Your work account uses a different address than the invitation. Sign in with the invited address, or ask the sender to invite your primary address.',
    recovery: 'switch_account',
  },
  [WORK_IDENTITY_ERROR.EMAIL_UNVERIFIED]: {
    message: 'Your provider did not confirm this email address. Use your firm work account.',
    recovery: 'switch_account',
  },
  [WORK_IDENTITY_ERROR.ORGANIZATION_MISMATCH]: {
    message: 'This account does not belong to your firm’s approved work organization. Switch to your firm work account.',
    recovery: 'switch_account',
  },
  [WORK_IDENTITY_ERROR.CONSENT_CANCELED]: {
    message: 'Sign-in was canceled. Continue with your work account to accept the invitation.',
    recovery: 'retry',
  },
  [WORK_IDENTITY_ERROR.IDENTITY_AMBIGUOUS]: {
    message: 'Your provider did not return a single new work account to connect. Connect again and choose the work account for this email.',
    recovery: 'connect',
  },
  [WORK_IDENTITY_ERROR.PROVIDER_FAILED]: {
    message: 'Your work account provider did not complete sign-in. Try again.',
    recovery: 'retry',
  },
  [WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED]: {
    message: 'This sign-in attempt expired. Open the invitation email again to restart.',
    recovery: 'open_invitation',
  },
  [WORK_IDENTITY_ERROR.ATTEMPT_CONSUMED]: {
    message: 'This sign-in attempt was already used. Open the invitation email again to restart.',
    recovery: 'open_invitation',
  },
  [WORK_IDENTITY_ERROR.INVITE_EXPIRED]: {
    message: 'This invitation expired. Ask the sender to resend it.',
    recovery: 'ask_resend',
  },
  [WORK_IDENTITY_ERROR.INVITE_REVOKED]: {
    message: 'This invitation was revoked. Ask the sender if that was a mistake.',
    recovery: 'ask_resend',
  },
  [WORK_IDENTITY_ERROR.INVITE_SUPERSEDED]: {
    message: 'A newer invitation replaced this one. Use the most recent invitation email.',
    recovery: 'open_invitation',
  },
  [WORK_IDENTITY_ERROR.INVITER_AUTHORITY_LOST]: {
    message: 'The sender can no longer grant this access. Ask your firm administrator for a new invitation.',
    recovery: 'contact_admin',
  },
  [WORK_IDENTITY_ERROR.INVITE_OTHER_FIRM]: {
    message: 'This invitation is from another firm, and your Conductia account belongs to your firm. Ask the sender to invite you through your firm, or contact your firm administrator.',
    recovery: 'contact_admin',
  },
  [WORK_IDENTITY_ERROR.EXISTING_ACCOUNT]: {
    message: 'You already have a Conductia account. Sign in to it, then connect your work account.',
    recovery: 'sign_in_then_connect',
  },
  [WORK_IDENTITY_ERROR.NOT_CONNECTED]: {
    message: 'This work account is not connected yet. Sign in with your email and password, then connect it from the profile menu, or ask your firm administrator. If you were invited by email, use the invitation email.',
    recovery: 'ask_resend',
  },
  [WORK_IDENTITY_ERROR.ALREADY_CONNECTED]: {
    message: 'Your Conductia account already has this work account connected. Nothing changed.',
    recovery: 'open_invitation',
  },
  [WORK_IDENTITY_ERROR.LINK_STALE]: {
    message: 'That work account is already connected but still shows your firm’s previous organization. Sign in with it once to update it, or connect your firm’s new work account.',
    recovery: 'retry',
  },
  [WORK_IDENTITY_ERROR.NO_INVITATION]: {
    message: 'There is no open invitation for this account. Open your invitation email to continue.',
    recovery: 'open_invitation',
  },
  [WORK_IDENTITY_ERROR.MFA_REQUIRED]: {
    message: 'Finish two-factor verification to continue.',
    recovery: 'resume_mfa',
  },
  [WORK_IDENTITY_ERROR.ACCOUNT_SUSPENDED]: {
    message: 'This account is suspended. Contact your firm administrator.',
    recovery: 'contact_admin',
  },
  [WORK_IDENTITY_ERROR.PROVIDER_NOT_CONFIGURED]: {
    message: 'Your firm has no approved work account provider. Ask the sender to resend the invitation.',
    recovery: 'ask_resend',
  },
  [WORK_IDENTITY_ERROR.WORK_IDENTITY_DISABLED]: {
    message: 'Work account sign-in is not available right now. Ask the sender to resend the invitation.',
    recovery: 'ask_resend',
  },
  [WORK_IDENTITY_ERROR.INVITE_CONTEXT_MISSING]: {
    message: 'This invitation needs to be resent. Ask the sender to resend it.',
    recovery: 'ask_resend',
  },
};

const FALLBACK = ERROR_COPY[WORK_IDENTITY_ERROR.PROVIDER_FAILED];

/** Plain-sentence message and recovery action for an error code. Unknown codes read as a provider failure. */
export function workIdentityErrorCopy(code: string | null | undefined): {
  message: string;
  recovery: WorkIdentityRecovery;
} {
  // Own keys only: a query-string code like `__proto__` must not reach Object.prototype.
  return code && Object.hasOwn(ERROR_COPY, code) ? ERROR_COPY[code as WorkIdentityErrorCode] : FALLBACK;
}

// The connect flow runs signed in, from the profile menu: no invitation wording.
const CONNECT_COPY: Partial<Record<WorkIdentityErrorCode, string>> = {
  [WORK_IDENTITY_ERROR.CONSENT_CANCELED]: 'Connection was canceled. Choose connect in the profile menu to try again.',
  [WORK_IDENTITY_ERROR.PROVIDER_FAILED]: 'Your work account provider did not complete the connection. Try again from the profile menu.',
  [WORK_IDENTITY_ERROR.IDENTITY_AMBIGUOUS]: ERROR_COPY[WORK_IDENTITY_ERROR.IDENTITY_AMBIGUOUS].message,
  [WORK_IDENTITY_ERROR.ATTEMPT_EXPIRED]: 'This connection attempt expired. Start again from the profile menu.',
  [WORK_IDENTITY_ERROR.WRONG_ACCOUNT]: 'That work account uses a different address or is connected to another Conductia account. Choose the work account for this email.',
  [WORK_IDENTITY_ERROR.ORGANIZATION_MISMATCH]: 'That work account does not match this email or your firm’s approved organization. Use your firm work account for this email.',
  [WORK_IDENTITY_ERROR.EMAIL_UNVERIFIED]: 'Your provider did not confirm this email address. Use your firm work account.',
  [WORK_IDENTITY_ERROR.PROVIDER_NOT_CONFIGURED]: 'Your firm has no approved work account provider. Contact your firm administrator.',
  [WORK_IDENTITY_ERROR.EXISTING_ACCOUNT]: 'This account cannot connect a work account. Contact your firm administrator.',
  [WORK_IDENTITY_ERROR.MFA_REQUIRED]: 'Finish two-factor verification, then connect again.',
  [WORK_IDENTITY_ERROR.ALREADY_CONNECTED]: 'Your work account is already connected. Nothing changed.',
  [WORK_IDENTITY_ERROR.LINK_STALE]: ERROR_COPY[WORK_IDENTITY_ERROR.LINK_STALE].message,
};

/** Message for a /auth/work/connect outcome. Unknown or foreign codes read as a provider failure. */
export function workIdentityConnectCopy(code: string): string {
  const own = Object.hasOwn(CONNECT_COPY, code) ? CONNECT_COPY[code as WorkIdentityErrorCode] : undefined;
  return own ?? CONNECT_COPY[WORK_IDENTITY_ERROR.PROVIDER_FAILED]!;
}
