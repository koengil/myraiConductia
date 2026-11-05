-- G-07 slice 1b (#173, design R5, R6): every write that people outside a team inbox's
-- audience can read is built from the shared assessment only. The shared assessment of a
-- candidate is its latest stage_assessments row with team_mailbox_id null (slice 1a,
-- 20261023130100). A scoped row (team_mailbox_id = T) is read only by T's audience, so
-- nothing derived from it may reach deal state, the promotion audit (deal overseers, the
-- firm admin included, read it), or a correction a colleague or a deal member reads.
--
-- Three definers are restated with the same signatures, so `create or replace` keeps
-- their owner and ACL; the grants are restated anyway, as in their source migrations.
-- Each body is its latest source byte for byte, apart from:
--   * the header's search_path, `public, pg_temp`: the value the catalog loop of
--     20261016100000_definer_search_path_pg_temp.sql already set on all three, written in
--     the header because a `create or replace` resets it (and the migration lint wants it);
--   * the changes listed above each function.
-- No table, policy or grant changes. Nothing writes a scoped row yet, so on today's data
-- the only visible change is the model-only `closed` at promotion.

-- ── 1. Promotion: shared assessment only; `closed` needs a cited model `closed` event ──
-- Restated from 20261002220000_discovery_promotion.sql:49-108. Changes:
--   * `a` is the shared assessment (team_mailbox_id is null), so the deal's lifecycle and
--     status and the audit's suggestedStepId and lifecycleCategory come from shared
--     evidence only (R5);
--   * the deal is `closed` only when the shared row says `closed` and one of the events it
--     cites is a model-basis `closed` event (model_call_id is not null) of this tenant;
--     otherwise it is `live`. A rule match never closes a deal, whatever wrote the row.
--     (model_call_id is not null on every event today; G-07 slice 3b makes it nullable for
--     rule events, and this check is what keeps them from closing a deal.)
--     Intended (R5, audit S3): a row the engine marks `closed` whose lead is a later
--     regression (round_reopened, exclusivity_lapsed) cites the regression, not the closed
--     event, and carries the `conflict` flag, so the deal opens `live` where it used to open
--     `closed`. Contradicting evidence after a close leaves the call to the MD, who can close
--     the deal at once.
-- chosenStepSeq stays the MD's explicit choice. The deal_id back-fill still covers every
-- row of the candidate, scoped rows included: their own policy decides who reads them.
create or replace function discovery_promote_candidate(
  p_actor_id uuid, p_tenant_id uuid, p_bank_id uuid, p_candidate_id uuid,
  p_codename text, p_target_name text, p_entry_step_seq int, p_entry_phase int, p_entry_status text,
  p_members jsonb, p_screening jsonb, p_steps jsonb, p_census_version text, p_conflicts jsonb
) returns jsonb language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  c deal_candidates;
  v_tenant uuid;
  v jsonb;
  v_deal uuid;
  a stage_assessments;
  v_corr uuid;
  v_lifecycle text;
  v_status text;
begin
  if p_actor_id is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  -- The tenant is read from the immutable column before any lock, as the correction prelude does.
  select dc.tenant_id into v_tenant from deal_candidates dc where dc.id = p_candidate_id;
  if v_tenant is null
     or v_tenant is distinct from p_tenant_id
     or p_tenant_id is distinct from (select u.tenant_id from users u where u.id = p_actor_id)
     or not exists (select 1 from companies b where b.id = p_bank_id and b.tenant_id = p_tenant_id and b.type = 'bank') then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  perform discovery_lock_tenant(p_tenant_id);
  select * into c from deal_candidates dc where dc.id = p_candidate_id for update;
  -- E5 (c): the function itself refuses an actor who cannot see the candidate, and one who cannot create deals.
  if not app_can_see_candidate(p_candidate_id, p_actor_id) then
    raise exception 'not_visible' using errcode = 'P0002';
  end if;
  if not app_can_create_deals(p_actor_id, p_bank_id) then
    raise exception 'no_authority' using errcode = '42501';
  end if;
  if c.promoted_deal_id is not null then raise exception 'already_promoted' using errcode = '23505'; end if;
  if c.discovery_state <> 'proposed' then raise exception 'candidate_state' using errcode = '55000'; end if;

  -- The unchanged Gate 0 core (R4): deal, target, MD seat, memberships, notices, attestation, steps.
  v := create_deal_gate0_core(p_tenant_id, p_actor_id, p_bank_id, p_codename, p_target_name,
         null, null, p_entry_step_seq, p_entry_phase, p_members, p_screening, p_steps, p_census_version,
         p_conflicts, null, null, null, null);
  v_deal := (v->'deal'->>'id')::uuid;

  select * into a from stage_assessments sa where sa.candidate_id = p_candidate_id and sa.team_mailbox_id is null order by sa.as_of desc, sa.id desc limit 1;
  v_lifecycle := case when a.lifecycle_suggestion = 'closed'
                           and exists (select 1 from milestone_events me
                                        where me.id = any (a.evidence_event_ids) and me.tenant_id = p_tenant_id
                                          and me.type = 'closed' and me.model_call_id is not null)
                      then 'closed' else 'live' end;
  v_status := case when v_lifecycle = 'closed' then 'closed'
                   when p_entry_status = 'intake' then 'intake' else 'active' end;
  update deals set lifecycle_category = v_lifecycle, status = v_status where id = v_deal;

  update deal_candidates set discovery_state = 'confirmed', promoted_deal_id = v_deal where id = p_candidate_id;
  update stage_assessments set deal_id = v_deal where candidate_id = p_candidate_id;
  insert into corrections (tenant_id, candidate_id, deal_id, actor_id, action, before, after)
  values (p_tenant_id, p_candidate_id, v_deal, p_actor_id, 'promote', jsonb_build_object('state', 'proposed'),
          jsonb_build_object('dealId', v_deal, 'entryStepSeq', p_entry_step_seq))
  returning id into v_corr;
  insert into audit_log (tenant_id, actor_id, actor_type, deal_id, action, detail)
  values (p_tenant_id, p_actor_id, 'user', v_deal, 'discovery.candidate_promoted', jsonb_build_object(
    'candidateId', p_candidate_id, 'dealId', v_deal, 'correctionId', v_corr,
    'suggestedStepId', a.step_id, 'chosenStepSeq', p_entry_step_seq, 'lifecycleCategory', v_lifecycle, 'status', v_status));
  return jsonb_build_object('deal', v->'deal', 'memberships', v->'memberships', 'notified', v->'notified');
end; $$;

revoke all on function discovery_promote_candidate(uuid, uuid, uuid, uuid, text, text, int, int, text, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function discovery_promote_candidate(uuid, uuid, uuid, uuid, text, text, int, int, text, jsonb, jsonb, jsonb, text, jsonb)
  to service_role;

-- ── 2. Set station: the history records the shared suggestion ───────────────────
-- Restated from 20261002210000_discovery_corrections.sql:185-216. One change: the
-- correction's before.suggestedStepId is the shared assessment's step (team_mailbox_id is
-- null), because the candidate's viewers read this row, not only the inbox's audience (R6).
create or replace function discovery_set_station(p_candidate uuid, p_step_id text, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v         record;
  v_actor   uuid := auth.uid();
  v_corr    uuid;
  v_suggest text;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if p_step_id is null or p_step_id !~ '^p[1-5]-s[0-9]+$' then raise exception 'invalid_step' using errcode = '22023'; end if;
  select * into v from discovery_authorize_correction(p_candidate, v_actor);
  if v.state not in ('proposed', 'confirmed') then raise exception 'candidate_state' using errcode = '55000'; end if;

  -- What the evidence suggested when the MD chose, so the history can say what changed.
  select sa.step_id into v_suggest from stage_assessments sa
   where sa.candidate_id = p_candidate and sa.team_mailbox_id is null order by sa.as_of desc, sa.id desc limit 1;
  insert into corrections (tenant_id, candidate_id, actor_id, action, before, after, reason)
  values (v.tenant_id, p_candidate, v_actor, 'set_station',
          jsonb_build_object('stepId', v.override_step, 'suggestedStepId', v_suggest),
          jsonb_build_object('stepId', p_step_id), trim(p_reason))
  returning id into v_corr;
  update deal_candidates
     set station_override_step_id = p_step_id, station_override_correction_id = v_corr, pinned = true
   where id = p_candidate;
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v.tenant_id, v_actor, 'user', 'discovery.correction',
          jsonb_build_object('candidateId', p_candidate, 'correctionId', v_corr, 'action', 'set_station'));
  insert into discovery_recompute_requests (tenant_id, candidate_id, reason)
  values (v.tenant_id, p_candidate, 'correction');
  return v_corr;
end;
$$;

revoke all on function discovery_set_station(uuid, text, text) from public, anon, authenticated;
grant execute on function discovery_set_station(uuid, text, text) to authenticated;

-- ── 3. Dismissal: a scoped row is refused until its audience can read it ────────
-- Restated from 20261002220000_discovery_promotion.sql:120-141. Changes:
--   * a scoped assessment (team_mailbox_id is not null) is refused with 42501
--     'not_in_team_audience', before the lock and before any write. Nobody reads a scoped
--     row yet (slice 1a's fail-closed policy), so nobody dismisses one; G-07 slice 4 admits
--     the inbox's readers through G-01's inbox-keyed reader (orchestrator call 1);
--   * the correction carries the assessment's team_mailbox_id, so a scoped dismissal is
--     read under the scoped policy once slice 4 admits one. Today it is always null.
-- The audit row is unchanged: ids only.
create or replace function discovery_dismiss_suggestion(p_deal_id uuid, p_assessment_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_actor uuid := auth.uid();
  a stage_assessments;
  v_corr uuid;
begin
  if v_actor is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if not app_is_deal_md(p_deal_id, v_actor) then raise exception 'not_md' using errcode = '42501'; end if;
  select * into a from stage_assessments sa where sa.id = p_assessment_id and sa.deal_id = p_deal_id;
  if a.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if a.team_mailbox_id is not null then raise exception 'not_in_team_audience' using errcode = '42501'; end if;
  perform discovery_lock_tenant(a.tenant_id);
  insert into corrections (tenant_id, candidate_id, deal_id, actor_id, action, before, after, reason, team_mailbox_id)
  values (a.tenant_id, a.candidate_id, p_deal_id, v_actor, 'dismiss_suggestion',
          jsonb_build_object('stepId', a.step_id), jsonb_build_object('assessmentId', a.id), trim(p_reason), a.team_mailbox_id)
  returning id into v_corr;
  insert into audit_log (tenant_id, actor_id, actor_type, deal_id, action, detail)
  values (a.tenant_id, v_actor, 'user', p_deal_id, 'discovery.correction',
          jsonb_build_object('candidateId', a.candidate_id, 'correctionId', v_corr, 'action', 'dismiss_suggestion'));
  return v_corr;
end; $$;

revoke all on function discovery_dismiss_suggestion(uuid, uuid, text) from public, anon, authenticated;
grant execute on function discovery_dismiss_suggestion(uuid, uuid, text) to authenticated;
