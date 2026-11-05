// Demo-only (#460): the Supabase store behind the proposal pass (service role, worker only).
// Delete this folder when #459 lands.
//
// Rows are written through discovery_record_model_proposal alone, which checks
// the tenant and upserts on the message. Errors are codes, never a database
// message, and nothing here logs a deal name.
//
// A team inbox's pass is opened, renewed and closed through discovery_begin_proposal_source,
// discovery_renew_proposal_source and discovery_end_proposal_source (G-01 #173). Begin and renew never throw: every
// refusal, busy pass, transport error or malformed answer is a non-ok BeginResult, which stops the source (passes.ts).
// discovery_close_lapsed_proposal_passes closes the tenant's lapsed passes once per run (review F5).

import type { SupabaseClient } from '@supabase/supabase-js';

import { recordAiUsage } from '@/lib/ai/usage';
import { TABLE } from '@/lib/constants/tables';

import { TeamNotApprovedError, type BeginRefusal, type BeginResult } from './passes';
import type { ProposalRow, ProposalStore } from './run';

/** Keys per settled-key read, so a long page never builds an overlong query string. */
const KEY_CHUNK = 100;

const fail = (what: string, error: { code?: string } | null): never => {
  throw new Error(`${what} failed: ${error?.code ?? 'unknown'}`);
};

/** SQLSTATE 42501 with the code as the message (pass definers, writer), and 55P03 for a pass another run holds. */
const REFUSAL_MESSAGES: ReadonlySet<string> = new Set(['team_not_approved', 'team_inbox_not_allowed', 'no_reader']);

function refusalOf(error: { code?: string; message?: string }): BeginRefusal {
  if (error.code === '55P03') return 'pass_in_progress';
  // pass_closed and pass_not_open are refusals too; they have no code of their own here and read as `error`.
  if (error.code === '42501' && error.message !== undefined && REFUSAL_MESSAGES.has(error.message.trim())) {
    return error.message.trim() as BeginRefusal;
  }
  return 'error';
}

/** What begin and renew answered: {scope: 'personal'} or {scope: 'team', leaseUntil}. Anything else fails closed. */
function beginResultOf(data: unknown): BeginResult {
  const answer = data as { scope?: unknown; leaseUntil?: unknown } | null;
  if (answer?.scope === 'personal') return { ok: true, scope: 'personal' };
  if (answer?.scope === 'team' && typeof answer.leaseUntil === 'string' && Number.isFinite(Date.parse(answer.leaseUntil))) {
    return { ok: true, scope: 'team', leaseUntil: answer.leaseUntil };
  }
  return { ok: false, code: 'error' };
}

const snake = (row: ProposalRow) => ({
  content_source_id: row.contentSourceId,
  message_key: row.messageKey,
  item_hash: row.itemHash,
  sent_at: row.sentAt,
  party_domains: row.partyDomains,
  outcome: row.outcome,
  deal_key: row.dealKey,
  deal_name: row.dealName,
  candidate_id: row.candidateId,
  phase: row.phase,
  p_deal: row.pDeal,
  p_phase: row.pPhase,
  model: row.model,
  prompt_version: row.promptVersion,
  prompt_hash: row.promptHash,
  response_id: row.responseId,
  run_id: row.runId,
});

export function supabaseProposalStore(db: SupabaseClient): ProposalStore {
  return {
    async settledKeys(tenantId, sourceId, keys, promptVersion, model) {
      // An archived row (its candidate was deleted, rejected or merged, review #509-3) stays settled: the message is
      // not asked again, so restoring the row by clearing archived_at brings back the answer it had.
      const settled = new Set<string>();
      for (let i = 0; i < keys.length; i += KEY_CHUNK) {
        const { data, error } = await db
          .from(TABLE.DISCOVERY_MODEL_PROPOSALS)
          .select('message_key')
          .eq('tenant_id', tenantId)
          .eq('content_source_id', sourceId)
          .eq('prompt_version', promptVersion)
          .eq('model', model)
          .in('message_key', keys.slice(i, i + KEY_CHUNK));
        if (error) fail('read settled proposals', error);
        for (const row of (data ?? []) as Array<{ message_key: string }>) settled.add(row.message_key);
      }
      return settled;
    },

    async candidates(tenantId, sourceId) {
      // The information barrier lives in SQL, per source: only the candidates this source's own mail backs, then
      // the deals the model named in this source's own mail (discovery_proposal_known_deals).
      const { data, error } = await db.rpc('discovery_proposal_known_deals', { p_tenant_id: tenantId, p_source: sourceId });
      if (error) fail('read known deals', error);
      return ((data ?? []) as Array<{ ref: string; name: string; candidate_id: string | null }>).map((row) => ({
        ref: row.ref,
        name: row.name,
        candidateId: row.candidate_id,
      }));
    },

    async saveProposal(tenantId, row) {
      const { error } = await db.rpc('discovery_record_model_proposal', {
        p_tenant_id: tenantId,
        p_proposal: snake(row),
      });
      // The writer's refusal of a team row (the switch is off for the inbox's firm, or no pass is open): the step
      // stops the source rather than counting a failed row.
      if (error?.code === '42501' && error.message?.trim() === 'team_not_approved') throw new TeamNotApprovedError();
      if (error) fail('record model proposal', error);
    },

    async beginSource(tenantId, sourceId, runId, path, firmIds) {
      try {
        const { data, error } = await db.rpc('discovery_begin_proposal_source', {
          p_tenant: tenantId,
          p_source: sourceId,
          p_run: runId,
          p_path: path,
          p_firm_ids: [...firmIds],
        });
        return error ? { ok: false, code: refusalOf(error) } : beginResultOf(data);
      } catch {
        return { ok: false, code: 'error' };
      }
    },

    async renewSource(tenantId, sourceId, runId, firmIds, counts) {
      try {
        const { data, error } = await db.rpc('discovery_renew_proposal_source', {
          p_tenant: tenantId,
          p_source: sourceId,
          p_run: runId,
          p_firm_ids: [...firmIds],
          p_counts: counts,
        });
        return error ? { ok: false, code: refusalOf(error) } : beginResultOf(data);
      } catch {
        return { ok: false, code: 'error' };
      }
    },

    async endSource(tenantId, sourceId, runId, outcome, counts) {
      const { error } = await db.rpc('discovery_end_proposal_source', {
        p_tenant: tenantId,
        p_source: sourceId,
        p_run: runId,
        p_outcome: outcome,
        p_counts: counts,
      });
      if (error) fail('end proposal pass', error);
    },

    async closeLapsedPasses(tenantId) {
      const { data, error } = await db.rpc('discovery_close_lapsed_proposal_passes', { p_tenant: tenantId });
      if (error) fail('close lapsed proposal passes', error);
      return typeof data === 'number' ? data : 0;
    },

    async internalDomains(tenantId) {
      // The same read as worker/sync.ts internalDomains: the domains of the tenant's configured mailboxes.
      const { data, error } = await db.from(TABLE.CONTENT_SOURCES).select('address').eq('tenant_id', tenantId);
      if (error) fail('read mailbox domains', error);
      return ((data ?? []) as Array<{ address: string }>)
        .map((row) => {
          const at = row.address.lastIndexOf('@');
          return at > 0 ? row.address.slice(at + 1).toLowerCase() : null;
        })
        .filter((domain): domain is string => domain !== null);
    },

    async recordUsage(tenantId, a) {
      // The gateway names models "anthropic/claude-haiku-5.5"; the pricing table maps "claude-haiku-5.5".
      // A reply without usage is an unpriced row: the model alone, null tokens and a null cost (#645).
      // A write the ledger refuses throws a code, never the database's message: proposeDeals stops the step on it.
      const { error } = await recordAiUsage(db, {
        tenantId,
        actorId: null,
        source: 'discovery_extract',
        task: 'deal_proposal',
        externalId: a.externalId,
        model: a.model.replace(/^anthropic\//, ''),
        usage: a.usage,
      });
      if (error) fail('record ai usage', { code: 'ledger' });
    },
  };
}
