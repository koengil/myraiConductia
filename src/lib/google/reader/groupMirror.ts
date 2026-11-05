// The Google side of the provider allowlist mirror (#259, coordination C7).
// The bank's ingest group is the second gate after #262's allowed_mailboxes:
// a mailbox is read only when both hold it. The list is read through the
// directory service account, an identity with no domain-wide delegation and no
// mail scope (R14), so the account that reads mail never produces the evidence
// that audits it. Any failure throws: #262 turns that into mirror_unavailable
// and reads nothing (fail closed).

import { DIRECTORY_SCOPES } from '@/lib/constants/googleReader';
import { MAILBOX_PROVIDER, type MailboxProvider } from '@/lib/constants/discovery';
import type { ProviderAllowlistMirror } from '@/lib/mailboxAccess/mirror';

import type { CallerTokenSource } from './credentials';
import { googleJson } from './http';
import type { GoogleRegistrationLookup } from './registration';
import { serviceAccountAccessToken } from './token';

const DIRECTORY_API = 'https://admin.googleapis.com/admin/directory/v1';
const MEMBERS_PAGE_SIZE = 200;

type MembersPage = {
  members?: Array<{ email?: string; type?: string }>;
  nextPageToken?: string;
};

export function createGoogleGroupMirror(deps: {
  callerToken: CallerTokenSource;
  /** The directory identity's own token (#344, design R5): GOOGLE_DIRECTORY_CREDENTIALS,
   * which impersonates the directory SA. Absent: generateAccessToken on it with the caller token. */
  directoryToken?: CallerTokenSource;
  registry: GoogleRegistrationLookup;
  fetchImpl?: typeof fetch;
}): ProviderAllowlistMirror {
  return {
    async listMembers(tenantId: string, provider: MailboxProvider): Promise<string[]> {
      if (provider !== MAILBOX_PROVIDER.GOOGLE) throw new Error(`The Google group mirror serves google, not ${provider}`);
      const registration = await deps.registry.registrationFor(tenantId);
      // Both directory scopes on either path (members for this list, users for the team inbox check, #581): one
      // identity, one token shape. Neither is a mail scope.
      const token = deps.directoryToken
        ? await deps.directoryToken()
        : await serviceAccountAccessToken(
            deps.callerToken,
            registration.directoryServiceAccountEmail,
            [...DIRECTORY_SCOPES],
            deps.fetchImpl,
          );
      const http = { getToken: async () => token, fetchImpl: deps.fetchImpl };
      const members = new Set<string>();
      let pageToken: string | null = null;
      do {
        const url: string =
          `${DIRECTORY_API}/groups/${encodeURIComponent(registration.allowlistGroup)}/members` +
          `?maxResults=${MEMBERS_PAGE_SIZE}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const page: MembersPage = await googleJson<MembersPage>(url, http);
        for (const member of page.members ?? []) {
          if (member.type === 'USER' && member.email) members.add(member.email.trim().toLowerCase());
        }
        pageToken = page.nextPageToken ?? null;
      } while (pageToken);
      return [...members];
    },
  };
}
