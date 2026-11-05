// The Google side of the team inbox check (#581, design R7). Before the worker reads a team inbox it asks the
// Directory whether the address is a real, active user mailbox: Gmail can be read as a Workspace user only, never as
// an alias or a Google Group (R12). Like the group mirror, it asks as the directory identity (no domain-wide
// delegation, no mail scope, no `sub`), so the account that reads mail never produces the evidence that admits it.
//
// The answer is one of three:
//   - verified:  a user whose primary address is this address, not suspended or archived, with a mailbox.
//   - refused:   a definitive answer that it is not readable (alias, group, suspended, no mailbox, not found, a
//                different account than the one pinned, or the directory role may not look). The caller records it
//                and retries on a later tick, so granting the directory read turns it Ready on its own.
//   - error:     anything else: Google down, a throttle, a timeout, a token that could not be minted. Transient: the
//                caller records it beside the status and never flips Ready to Refused on it.
//
// Nothing here logs, and no error carries a response body or an address: a body can quote a name, and an address
// is the one thing the audit trail never holds for a team source.

import { DIRECTORY_SCOPES } from '@/lib/constants/googleReader';
import {
  TEAM_MAILBOX_CHECK_ERROR,
  TEAM_MAILBOX_CHECK_REASON,
  type TeamMailboxCheckError,
  type TeamMailboxCheckReason,
} from '@/lib/constants/discovery';

import type { CallerTokenSource } from './credentials';
import { GoogleHttpError, googleJson, type GoogleHttpOptions } from './http';
import type { GoogleRegistrationLookup } from './registration';
import { serviceAccountAccessToken } from './token';

const DIRECTORY_API = 'https://admin.googleapis.com/admin/directory/v1';

/** users.get: only what the verdict needs. A name, a phone or an organisation is never asked for. */
const USER_FIELDS = 'id,primaryEmail,suspended,archived,isMailboxSetup';
/** members.list: one member at most, and only its kind. The point is whether the group exists, not who is in it. */
const GROUP_PROBE_FIELDS = 'kind';

/**
 * A check should not hold a pass for the length of a read's retry ladder: a failed check is recorded as transient
 * and asked again on the next tick (about 5 minutes), so two retries and a short deadline are enough.
 */
export const TEAM_MAILBOX_CHECK_HTTP = { maxAttempts: 3, timeoutMs: 20_000 } as const;

export type TeamMailboxCheck =
  | { status: 'verified'; directoryUserId: string }
  | { status: 'refused'; reason: TeamMailboxCheckReason } // definitive
  | { status: 'error'; reason: TeamMailboxCheckError }; // transient: status unchanged

export type TeamMailboxVerifier = {
  /** `pinnedId` is the Directory user id recorded by the first success, or null before one. */
  verify(tenantId: string, address: string, pinnedId: string | null): Promise<TeamMailboxCheck>;
};

type DirectoryUser = {
  id?: unknown;
  primaryEmail?: unknown;
  suspended?: unknown;
  archived?: unknown;
  isMailboxSetup?: unknown;
};

const TRANSIENT: TeamMailboxCheck = { status: 'error', reason: TEAM_MAILBOX_CHECK_ERROR.DIRECTORY_ERROR };
const refused = (reason: TeamMailboxCheckReason): TeamMailboxCheck => ({ status: 'refused', reason });

/** A 403 that is the directory role saying no, not Google asking us to slow down (that one is a throttle: transient). */
function isDenied(error: unknown): boolean {
  return error instanceof GoogleHttpError && error.status === 403 && !error.throttled;
}

function isNotFound(error: unknown): boolean {
  return error instanceof GoogleHttpError && error.status === 404;
}

export function createGoogleTeamMailboxVerifier(deps: {
  callerToken: CallerTokenSource;
  /** The directory identity's own token (#344, design R5), as for the group mirror. Absent: generateAccessToken on it. */
  directoryToken?: CallerTokenSource;
  registry: GoogleRegistrationLookup;
  fetchImpl?: typeof fetch;
  /** Overrides for the request loop (tests: no sleeping; or a different deadline). */
  http?: Pick<GoogleHttpOptions, 'sleep' | 'random' | 'maxAttempts' | 'baseDelayMs' | 'maxDelayMs' | 'timeoutMs'>;
}): TeamMailboxVerifier {
  async function lookup(tenantId: string, address: string, pinnedId: string | null): Promise<TeamMailboxCheck> {
    const registration = await deps.registry.registrationFor(tenantId);
    const token = deps.directoryToken
      ? await deps.directoryToken()
      : await serviceAccountAccessToken(
          deps.callerToken,
          registration.directoryServiceAccountEmail,
          [...DIRECTORY_SCOPES],
          deps.fetchImpl,
        );
    const http: GoogleHttpOptions = {
      ...TEAM_MAILBOX_CHECK_HTTP,
      ...deps.http,
      getToken: async () => token,
      fetchImpl: deps.fetchImpl,
    };

    let user: DirectoryUser;
    try {
      user = await googleJson<DirectoryUser>(
        `${DIRECTORY_API}/users/${encodeURIComponent(address)}?fields=${USER_FIELDS}`,
        http,
      );
    } catch (error) {
      if (isDenied(error)) return refused(TEAM_MAILBOX_CHECK_REASON.DIRECTORY_DENIED);
      if (!isNotFound(error)) throw error;
      // Not a user. A Google Group answers here; nothing at all answers 404 again.
      try {
        await googleJson<unknown>(
          `${DIRECTORY_API}/groups/${encodeURIComponent(address)}/members?maxResults=1&fields=${GROUP_PROBE_FIELDS}`,
          http,
        );
        return refused(TEAM_MAILBOX_CHECK_REASON.GROUP);
      } catch (groupError) {
        // The directory role may be scoped to the allowlist group alone, so it cannot read this one: denied, not
        // "no such group" (R7, T1).
        if (isDenied(groupError)) return refused(TEAM_MAILBOX_CHECK_REASON.DIRECTORY_DENIED);
        if (isNotFound(groupError)) return refused(TEAM_MAILBOX_CHECK_REASON.NOT_FOUND);
        throw groupError;
      }
    }

    // A 200 that is not the shape we asked for says nothing about the address: transient, never verified.
    if (typeof user.id !== 'string' || user.id === '' || typeof user.primaryEmail !== 'string') return TRANSIENT;
    // Asked by an alias, the Directory answers with the account and its primary address.
    if (user.primaryEmail.trim().toLowerCase() !== address) return refused(TEAM_MAILBOX_CHECK_REASON.ALIAS);
    if (user.suspended === true || user.archived === true) return refused(TEAM_MAILBOX_CHECK_REASON.SUSPENDED);
    // Fail closed: Google may omit a false boolean, and an absent flag is no mailbox.
    if (user.isMailboxSetup !== true) return refused(TEAM_MAILBOX_CHECK_REASON.NO_MAILBOX);
    // The address now belongs to another account than the one an earlier check pinned.
    if (pinnedId !== null && user.id !== pinnedId) return refused(TEAM_MAILBOX_CHECK_REASON.IDENTITY_CHANGED);
    return { status: 'verified', directoryUserId: user.id };
  }

  return {
    async verify(tenantId, address, pinnedId) {
      try {
        return await lookup(tenantId, address.trim().toLowerCase(), pinnedId);
      } catch {
        // Every failure that is not a definitive answer: a token that could not be minted, no registration, a
        // throttle, a 5xx, a timeout. The reason is dropped on purpose: it could carry an address.
        return TRANSIENT;
      }
    },
  };
}
