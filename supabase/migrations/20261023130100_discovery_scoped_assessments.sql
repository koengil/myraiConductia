-- G-07 slice 1a (#173, design R2, R4, R12): stage assessments and corrections gain an
-- audience. A null team_mailbox_id is the shared audience, today's rows, unchanged. A
-- team inbox T scopes a row to T's audience, which a later slice opens through G-01's
-- inbox-keyed reader. Until then the policies below return no scoped row to anyone
-- (fail closed), and no code writes one, so nothing visible changes.
--
-- The tenant binding holds in two places here: the composite reference
-- (team_mailbox_id, tenant_id) -> team_mailboxes (id, tenant_id), so a scoped row cannot
-- point at another tenant's inbox, and the writer's 22023 check that T is an allowed team
-- inbox of the row's tenant. Both references are on delete restrict, like every other
-- reference to a team inbox (20261019100000, 20261019150000): an inbox with history is
-- closed, never deleted.
--
-- app_item_has_allowed_source is not redefined (design R1): the inputs' null-audience
-- rows still pass through it, so they cover exactly today's items, and team rows are added
-- beside them, never mixed in. discovery_extract_batch is untouched, so team-only mail
-- still never reaches a model (ADR-0026 residual 3).
--
-- stage_assessments is a big table (supabase/lint/big-tables.txt): the widened trigger
-- CHECK and the new reference are added NOT VALID (every existing row holds one of the old
-- trigger values and a null team_mailbox_id, so neither can fail; both bind every new
-- row). The latest-row index is swapped with no window without one: the per-audience index
-- is built concurrently under a new name (20261023130101), checked valid (20261023130102),
-- and only then is the old (candidate_id, as_of desc) index dropped concurrently
-- (20261023130103). This file drops no index.
--
-- Deploy skew: discovery_assessment_inputs keeps its shape and its body (20261002200000),
-- so a worker image from before this slice still reads shared events only. The audiences
-- are read through a new function, discovery_audience_assessment_inputs, which only the new
-- store calls (and which it falls back from, to the old function, while this migration has
-- not landed).

-- ── 1. The audience column and its composite reference ──────────────────────────
-- lint-allow: hosted-counts id is the primary key, so (id, tenant_id) is unique on every row a hosted database holds
alter table team_mailboxes add constraint team_mailboxes_id_tenant_key unique (id, tenant_id);

-- null: the shared audience (today's rows); T: read only by T's audience, in the row's tenant.
alter table stage_assessments add column if not exists team_mailbox_id uuid;
alter table stage_assessments add constraint stage_assessments_team_mailbox_fkey
  foreign key (team_mailbox_id, tenant_id) references team_mailboxes (id, tenant_id) on delete restrict not valid;

-- Set only on a dismissal of a team-scoped row (slice 1b); read under the same two-step policy.
alter table corrections add column if not exists team_mailbox_id uuid;
alter table corrections add constraint corrections_team_mailbox_fkey
  foreign key (team_mailbox_id, tenant_id) references team_mailboxes (id, tenant_id) on delete restrict not valid;

-- A purge that deletes a stream's latest row writes a tombstone under this trigger (slice 1c).
alter table stage_assessments drop constraint if exists stage_assessments_trigger_check;
alter table stage_assessments add constraint stage_assessments_trigger_check
  check (trigger in ('extraction','correction','rerun','purge')) not valid;

-- ── 2. The read policies: today's predicates, for shared rows only ──────────────
-- Restated from 20261002220000:33-43; the only change is the leading guard. A scoped row
-- (and a scoped dismissal) is readable by nobody until G-07 slice 4 adds the inbox's audience.
drop policy if exists corrections_select on corrections;
create policy corrections_select on corrections for select to authenticated using (
  team_mailbox_id is null and (
  app_can_see_candidate(candidate_id, auth.uid())
  or (deal_id is not null and action in ('promote', 'dismiss_suggestion')
      and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid())))));

drop policy if exists stage_assessments_select on stage_assessments;
create policy stage_assessments_select on stage_assessments for select to authenticated using (
  team_mailbox_id is null and (
  app_can_see_candidate(candidate_id, auth.uid())
  or (deal_id is not null and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid())))));

-- ── 3. The inputs: each event tagged with its audience and its basis ────────────
-- A new function beside discovery_assessment_inputs (20261002200000:138-149), which is left
-- as it is, so a worker that predates this slice still gets shared rows only and never feeds
-- a team row into a shared assessment. The first branch is that function's body, with two new
-- columns: its rows are the shared audience (team_mailbox_id null), exactly the items that
-- still have an allowed personal or site source. The second branch adds one row per allowed
-- team inbox T of the item in this tenant (the team test of app_item_cco_allowed_source,
-- 20261019160000), with team_mailbox_id = T. A mixed item therefore gives one shared row and
-- one T row per event; a team-only item gives T rows only. basis is 'model' when the event
-- came from a model call. Ids, type, date, confidence, audience and basis: never text and
-- never a span.
create or replace function discovery_audience_assessment_inputs(p_tenant_id uuid, p_candidate_ids uuid[])
returns table (candidate_id uuid, source_item_id uuid, event_id uuid, type text, occurred_at date,
               confidence numeric, extractor_version text, created_at timestamptz,
               team_mailbox_id uuid, basis text)
language sql stable security definer set search_path = public, pg_temp as $$
  select el.candidate_id, me.source_item_id, me.id, me.type, me.occurred_at, me.confidence, me.extractor_version, me.created_at,
         null::uuid, case when me.model_call_id is not null then 'model' else 'rules' end
  from deal_candidates dc
  join evidence_links el on el.candidate_id = dc.id
                        and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed')
  join milestone_events me on me.source_item_id = el.source_item_id and me.tenant_id = p_tenant_id
  where dc.tenant_id = p_tenant_id and dc.id = any (p_candidate_ids)
    and app_item_has_allowed_source(el.source_item_id)
  union all
  select el.candidate_id, me.source_item_id, me.id, me.type, me.occurred_at, me.confidence, me.extractor_version, me.created_at,
         t.team_mailbox_id, case when me.model_call_id is not null then 'model' else 'rules' end
  from deal_candidates dc
  join evidence_links el on el.candidate_id = dc.id
                        and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed')
  join milestone_events me on me.source_item_id = el.source_item_id and me.tenant_id = p_tenant_id
  join lateral (
    select distinct c.team_mailbox_id
    from source_item_sources s
    join source_items si on si.id = s.source_item_id
    join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                          and c.tenant_id = si.tenant_id and c.team_mailbox_id is not null
    join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                 and a.address = lower(c.address) and a.provider = c.provider
    where s.source_item_id = el.source_item_id and c.tenant_id = p_tenant_id
  ) t on true
  where dc.tenant_id = p_tenant_id and dc.id = any (p_candidate_ids);
$$;

-- ── 4. The writer: tenant lock, an allowed inbox, insert on change per audience ──
-- Restated from 20261002200000:184-210. Changes: the per-tenant discovery lock first (the
-- lock discovery_dismiss_suggestion takes, 20261002220000), so a concurrent extract run and
-- detect run cannot both insert against one "latest" row; a scoped row's inbox must be an
-- allowed team inbox of p_tenant_id (22023); "latest" is the latest row of the same audience;
-- the row carries its audience; and the audit detail adds teamMailboxId (scoped rows only)
-- and basis (model, rules or mixed, when given): ids and codes only. A new parameter changes
-- the function's identity, so it is dropped, recreated and re-granted. Callers that pass four
-- arguments get the shared audience, as before.
drop function if exists discovery_record_assessment(uuid, uuid, jsonb, text);
-- Insert on change only (step, lifecycle, evidence set, flags); audited as the deterministic service.
create function discovery_record_assessment(p_tenant_id uuid, p_candidate_id uuid, p_assessment jsonb, p_trigger text,
                                            p_team_mailbox_id uuid default null)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_last stage_assessments; v_id uuid; v_basis text := p_assessment->>'basis';
begin
  perform discovery_lock_tenant(p_tenant_id);
  perform 1 from deal_candidates where id = p_candidate_id and tenant_id = p_tenant_id;
  if not found then raise exception 'discovery_record_assessment: candidate not in tenant' using errcode = '22023'; end if;
  if p_team_mailbox_id is not null and not exists (select 1 from allowed_team_mailboxes a
       where a.team_mailbox_id = p_team_mailbox_id and a.tenant_id = p_tenant_id) then
    raise exception 'discovery_record_assessment: team inbox not allowed in tenant' using errcode = '22023';
  end if;
  if v_basis is not null and v_basis not in ('model', 'rules', 'mixed') then
    raise exception 'discovery_record_assessment: unknown basis' using errcode = '22023';
  end if;
  select * into v_last from stage_assessments
   where candidate_id = p_candidate_id and team_mailbox_id is not distinct from p_team_mailbox_id
   order by as_of desc, id desc limit 1;
  if v_last.id is not null
     and v_last.step_id is not distinct from p_assessment->>'stepId'
     and v_last.lifecycle_suggestion is not distinct from p_assessment->>'lifecycle'
     and v_last.flags = array(select jsonb_array_elements_text(p_assessment->'flags'))
     and (select array_agg(x order by x) from unnest(v_last.evidence_event_ids) x)
         is not distinct from (select array_agg(x::uuid order by x::uuid) from jsonb_array_elements_text(p_assessment->'evidenceEventIds') x)
  then return false; end if;
  insert into stage_assessments (tenant_id, candidate_id, step_id, station, lifecycle_suggestion, reason_text,
                                 evidence_event_ids, confidence, flags, engine_version, trigger, team_mailbox_id)
  values (p_tenant_id, p_candidate_id, p_assessment->>'stepId', (p_assessment->>'station')::int, p_assessment->>'lifecycle',
          p_assessment->>'reason', array(select jsonb_array_elements_text(p_assessment->'evidenceEventIds'))::uuid[],
          (p_assessment->>'confidence')::numeric, array(select jsonb_array_elements_text(p_assessment->'flags')),
          p_assessment->>'engineVersion', p_trigger, p_team_mailbox_id)
  returning id into v_id;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant_id, 'service', 'discovery-worker', 'discovery.stage_assessed',
          jsonb_build_object('candidateId', p_candidate_id, 'assessmentId', v_id, 'trigger', p_trigger)
          || jsonb_strip_nulls(jsonb_build_object('teamMailboxId', p_team_mailbox_id, 'basis', v_basis)));
  return true;
end; $$;

revoke all on function discovery_record_assessment(uuid, uuid, jsonb, text, uuid), discovery_audience_assessment_inputs(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function discovery_record_assessment(uuid, uuid, jsonb, text, uuid), discovery_audience_assessment_inputs(uuid, uuid[])
  to service_role;
