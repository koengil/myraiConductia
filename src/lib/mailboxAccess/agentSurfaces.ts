// Every agent-reachable surface declares whether it touches mailbox data
// (#262, R13). A manifest, not a route export: Next.js rejects unknown
// exports from route.ts. tests/agent-surfaces.test.ts discovers surfaces
// from the tree and fails on any surface missing here, and on any
// declaration its import closure contradicts.
//   none     the surface reaches no mailbox-derived table, RPC, reader or SDK
//   guarded  it does, only through @/lib/mailboxAccess/accessors
//   definer_rpc  a server route outside the session-RLS zones (Gate 0's zone)
//            that reaches mailbox data only by calling the named service-role
//            definer RPCs. judgeRoute accepts it only when every name is in
//            tests/fixtures/mailboxSqlFunctions.json and is granted to
//            service_role alone (read from the migrations), and every name the
//            route's closure carries is one of them: no table, no
//            src/lib/discovery/ import, no reader, no SDK. Each RPC checks the
//            session actor's visibility itself (the route passes the verified
//            session user as its actor argument).
//
// This file sits in src/lib/mailboxAccess/, so agent code never imports it
// (fence C); only the test reads it.

export type MailboxDataDeclaration =
  | { mailboxData: 'none' | 'guarded' }
  | { mailboxData: 'definer_rpc'; rpcs: readonly string[] };

export const AGENT_SURFACES: Record<string, MailboxDataDeclaration> = {
  // src/app/v1/**/route.ts: the Ignatious callback routes
  'src/app/v1/leads/[leadId]/change-tracking/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/documents/[documentId]/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/documents/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/fields/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/notes/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/relationship-map/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/stakeholder-map/route.ts': { mailboxData: 'none' },
  'src/app/v1/leads/[leadId]/tasks/route.ts': { mailboxData: 'none' },
  'src/app/v1/library/route.ts': { mailboxData: 'none' },
  'src/app/v1/personas/[personaId]/links/route.ts': { mailboxData: 'none' },
  'src/app/v1/personas/[personaId]/route.ts': { mailboxData: 'none' },
  'src/app/v1/personas/route.ts': { mailboxData: 'none' },
  // In-process orchestration agents
  'src/lib/orchestration/agents/draft-agent.ts': { mailboxData: 'none' },
  'src/lib/orchestration/agents/research-agent.ts': { mailboxData: 'none' },
  'src/lib/orchestration/agents/target-universe-agent.ts': { mailboxData: 'none' },
  'src/lib/orchestration/agents/target-universe-review-agent.ts': { mailboxData: 'none' },
  // Dev skill service and its SKILLS keys
  'src/app/api/skill-service/route.ts': { mailboxData: 'none' },
  'skill:target-universe': { mailboxData: 'none' },
  // Ignatious callback scope vocabulary (src/lib/conductia/scopes.ts)
  'scope:lead.read': { mailboxData: 'none' },
  'scope:lead.write': { mailboxData: 'none' },
  'scope:documents.read': { mailboxData: 'none' },
  'scope:documents.write': { mailboxData: 'none' },
  'scope:maps.read': { mailboxData: 'none' },
  'scope:maps.write': { mailboxData: 'none' },
  'scope:tasks.write': { mailboxData: 'none' },
  'scope:notes.write': { mailboxData: 'none' },
  'scope:library.read': { mailboxData: 'none' },
  'scope:personas.read': { mailboxData: 'none' },
  'scope:personas.write': { mailboxData: 'none' },
  // Gate 0's zone: promotes a proposed deal through one service-role definer that checks the actor itself (E5)
  'src/app/api/v1/deals/from-discovery/route.ts': { mailboxData: 'definer_rpc', rpcs: ['discovery_promote_candidate'] },
};
