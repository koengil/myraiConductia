-- Deal discovery phase 9 (design R4, R9, R12): promotion of a proposed deal into a
-- mandate, and the rail's evidence marker.
--
-- ADR-0017 decision 1: the new `corrections.deal_id` and the readable assessments
-- hold ids and step ids only. They carry no candidate name; the log's `before`
-- and `after` are the same synthetic-data-only columns as before (T11 a).
--
-- Promotion is a Gate 0 act, not a correction. It is one service-role definer,
-- `discovery_promote_candidate`, which wraps `create_deal_gate0_core` unchanged
-- (R4) and is called only by POST /api/v1/deals/from-discovery after
-- validateGate0Input and the MNPI screen, with `p_actor_id` taken from the
-- verified session and nothing else. It is granted to service_role alone, like
-- create_deal_gate0, and stays off the authenticated allowlist in
-- supabase/tests/definer_grants.sql (#262 review, E3). Because the caller is
-- the service role, the function checks the actor itself (#262 review, E5 c):
-- the actor must sit in the candidate's tenant, must be able to see the
-- candidate (app_can_see_candidate evaluated for p_actor_id) and must hold
-- deal-create authority on the bank (app_can_create_deals), and each refusal
-- leaves nothing behind.
--
-- Lock order is the one of 20261002210000: the per-tenant discovery lock first,
-- then the candidate's row lock, then whatever Gate 0 and the audit chain take.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. After promotion, deal members read what the deal's evidence decided
-- ─────────────────────────────────────────────────────────────────────────────

alter table corrections add column if not exists deal_id uuid references deals (id);

-- A deal member who holds no evidence sees that the mandate was promoted and
-- that a suggestion was dismissed (and why), and none of the candidate's other
-- corrections: the deal-scoped branch names only those two actions.
drop policy if exists corrections_select on corrections;
create policy corrections_select on corrections for select to authenticated using (
  app_can_see_candidate(candidate_id, auth.uid())
  or (deal_id is not null and action in ('promote', 'dismiss_suggestion')
      and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid()))));

-- The latest assessment of a promoted deal reaches the rail for every member.
drop policy if exists stage_assessments_select on stage_assessments;
create policy stage_assessments_select on stage_assessments for select to authenticated using (
  app_can_see_candidate(candidate_id, auth.uid())
  or (deal_id is not null and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid()))));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Promotion. Service role only; the actor is the verified session user.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function discovery_promote_candidate(
  p_actor_id uuid, p_tenant_id uuid, p_bank_id uuid, p_candidate_id uuid,
  p_codename text, p_target_name text, p_entry_step_seq int, p_entry_phase int, p_entry_status text,
  p_members jsonb, p_screening jsonb, p_steps jsonb, p_census_version text, p_conflicts jsonb
) returns jsonb language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
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

  select * into a from stage_assessments sa where sa.candidate_id = p_candidate_id order by sa.as_of desc, sa.id desc limit 1;
  v_lifecycle := case when a.lifecycle_suggestion = 'closed' then 'closed' else 'live' end;
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Dismissing the marker. The MD only, with a reason, on their own session.
-- ─────────────────────────────────────────────────────────────────────────────

-- Hides the marker until a newer assessment arrives. Audit detail holds ids only.
create or replace function discovery_dismiss_suggestion(p_deal_id uuid, p_assessment_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public set lock_timeout = '5s' as $$
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
  perform discovery_lock_tenant(a.tenant_id);
  insert into corrections (tenant_id, candidate_id, deal_id, actor_id, action, before, after, reason)
  values (a.tenant_id, a.candidate_id, p_deal_id, v_actor, 'dismiss_suggestion',
          jsonb_build_object('stepId', a.step_id), jsonb_build_object('assessmentId', a.id), trim(p_reason))
  returning id into v_corr;
  insert into audit_log (tenant_id, actor_id, actor_type, deal_id, action, detail)
  values (a.tenant_id, v_actor, 'user', p_deal_id, 'discovery.correction',
          jsonb_build_object('candidateId', a.candidate_id, 'correctionId', v_corr, 'action', 'dismiss_suggestion'));
  return v_corr;
end; $$;

revoke all on function discovery_dismiss_suggestion(uuid, uuid, text) from public, anon, authenticated;
grant execute on function discovery_dismiss_suggestion(uuid, uuid, text) to authenticated;
