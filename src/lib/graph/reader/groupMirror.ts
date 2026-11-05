// The Exchange side of the provider allowlist mirror (#275, design R1-R4, R12).
// The mail-enabled security group that scopes the reader's Application
// Mail.Read (RBAC for Applications) is the second gate after #262's
// allowed_mailboxes: a mailbox is read only when an allowlisted address binds to
// exactly one of the group's direct members (mirror.ts). The group is named by
// graph_reader_registrations.scope_group_id and read with the reader app's own
// credential and token cache (R2), so it inherits the Graph client's retries and
// deadlines.
//
// Every user object is kept: Graph lists user, shared, room and equipment
// mailboxes alike as #microsoft.graph.user, and a shared mailbox (a team inbox)
// is a member like any other (R12). Nested groups, contacts and devices are
// skipped: RBAC for Applications honours direct user members only.
//
// Any failure throws, and #262 turns that into mirror_unavailable and reads
// nothing (fail closed). Fields the granted role does not return must look like
// "Group unreadable", never like drift: a user with no UPN, or a group in which
// no user has mail, throws (review r2 #6). No address or id is in any message.

import type { SupabaseClient } from '@supabase/supabase-js';

import { MAILBOX_PROVIDER, REGISTRATION_STATUS, type MailboxProvider } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';
import { graphPages, type GraphHttpOptions } from '@/lib/graph/http';
import type { MirrorMember, ProviderAllowlistMirror } from '@/lib/mailboxAccess/mirror';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

import type { ReaderRegistration } from './token';

const GRAPH_USER = '#microsoft.graph.user';
// Graph's page ceiling for a members listing; nextLink is followed for the rest.
const MEMBERS_PAGE_SIZE = 999;

type RegistrationRow = {
  tenant_id: string;
  ms_tenant_id: string;
  client_id: string;
  cert_thumbprint: string | null;
  cert_secret_ref: string | null;
  scope_group_id: string | null;
};

type GraphMember = { '@odata.type'?: unknown; id?: unknown; mail?: unknown; userPrincipalName?: unknown };

/** The group's direct members, with the fields binding needs. */
function groupMembersPath(groupId: string): string {
  return `/groups/${encodeURIComponent(groupId)}/members?$select=id,mail,userPrincipalName&$top=${MEMBERS_PAGE_SIZE}`;
}

/** The tenant's active Microsoft registration and the group it records. Throws when either is missing. */
async function scopedRegistration(db: SupabaseClient, tenantId: string): Promise<{ registration: ReaderRegistration; groupId: string }> {
  const { data, error } = await db
    .from(TABLE.GRAPH_READER_REGISTRATIONS)
    .select('tenant_id, ms_tenant_id, client_id, cert_thumbprint, cert_secret_ref, scope_group_id')
    .eq('tenant_id', tenantId)
    .eq('status', REGISTRATION_STATUS.ACTIVE)
    .maybeSingle();
  if (error) throw new Error(`microsoft registration lookup failed (${errorCodeOf(error)})`);
  if (!data) throw new Error('no active Microsoft registration for this tenant');
  const row = data as RegistrationRow;
  const groupId = typeof row.scope_group_id === 'string' ? row.scope_group_id.trim() : '';
  if (!groupId) throw new Error("no scope group recorded on this tenant's Microsoft registration");
  return {
    registration: {
      tenantId: row.tenant_id,
      msTenantId: row.ms_tenant_id,
      clientId: row.client_id,
      certThumbprint: row.cert_thumbprint,
      certSecretRef: row.cert_secret_ref,
    },
    groupId,
  };
}

const lowered = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;

/** One listed member as a mirror member, or null when it is not a user. Throws when a user cannot be bound. */
function toMember(member: GraphMember): Exclude<MirrorMember, string> | null {
  if (member['@odata.type'] !== GRAPH_USER) return null;
  const id = typeof member.id === 'string' ? member.id.trim() : '';
  const upn = lowered(member.userPrincipalName);
  if (!id || upn === null) throw new Error('the Exchange group mirror: member addresses not readable');
  return { id, mail: lowered(member.mail), upn };
}

/**
 * The mirror over an authenticated Graph client. `httpFor` builds that client for the tenant's registration: in
 * production, createGraphReaderContext behind the reader capability (getGraphGroupMirror in index.ts).
 */
export function createGraphGroupMirror(deps: {
  httpFor: (registration: ReaderRegistration) => GraphHttpOptions;
  db?: () => SupabaseClient;
}): ProviderAllowlistMirror {
  return {
    async listMembers(tenantId: string, provider: MailboxProvider): Promise<MirrorMember[]> {
      if (provider !== MAILBOX_PROVIDER.MICROSOFT) throw new Error(`The Exchange group mirror serves microsoft, not ${provider}`);
      const { registration, groupId } = await scopedRegistration(deps.db ? deps.db() : createSupabaseAdminClient(), tenantId);
      const http = deps.httpFor(registration);
      const members: Array<Exclude<MirrorMember, string>> = [];
      for await (const page of graphPages<GraphMember>(groupMembersPath(groupId), http)) {
        for (const member of page.value) {
          const user = toMember(member);
          if (user) members.push(user);
        }
      }
      // The role granted may return ids and UPNs without mail (R1): that is an unreadable group, not a group whose
      // every member has left.
      if (members.length > 0 && members.every((member) => member.mail === null)) {
        throw new Error('the Exchange group mirror: member mail not readable');
      }
      return members;
    },
  };
}
