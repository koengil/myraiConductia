-- G-07 slice 2a (#173, design R9): one rule picks an item's current milestone events, for the
-- stage engine and for every reader, so they agree, and a zero-event model answer means zero.
--
-- Until now each reader kept "each item's events at its newest extractor version" itself, by the
-- events' created_at (the extract store and the API timeline). An item whose latest model call found
-- nothing has no events at that version, so both fell back to an older version's events. The rule,
-- in discovery_current_event_ids, is:
--   * an item with an `ok` model call for its current content hash takes the events of the latest
--     such call's own answer (its extractor version '<prompt_version>:<model>', and a (type,
--     span_start) its parsed answer names), even when there are none (basis 'model');
--   * otherwise, only where discovery_rule_firm_ok holds for the audience, the events of the item's
--     latest detection for its current content hash, the same way (basis 'rules');
--   * otherwise none.
-- So a model answer always beats a rule match, and rule events count only through an approved firm.
--
-- discovery_rule_firm_ok answers false in this slice: no firm can approve `milestone_rules` before
-- G-01's approval table exists, and no rule event can exist before G-07 slice 3b (model_call_id is
-- not null on every event). Slice 3b restates it over app_tenant_capability_on. The rules branch reads
-- milestone_detections (slice 3b's settle ledger) only once to_regclass finds it, like the purge
-- residue of 20261023130300, so slice 3b need not restate this rule.
--
-- discovery_audience_assessment_inputs is restated to select its events through the rule, once per audience.
-- discovery_assessment_inputs, the shared-only form kept for workers that predate 20261023130100, is not
-- touched: such a worker keeps its own newest-version rule.
-- discovery_item_current_events is the readers' side: signed-in, bound to auth.uid(), filtered by
-- app_can_see_item, and it answers ids and a basis only. app_item_has_allowed_source and
-- discovery_extract_batch are untouched (design R1).

-- ── 1. Whether an approved firm lets rule events count for an audience ──────────
-- The design's rule_firm_ok. False until G-07 slice 3b restates it over discovery_tenant_approvals:
-- for the shared audience (p_team_mailbox_id null), a personal or site source of the item whose firm
-- approved `milestone_rules`; for a team inbox T, T's firm. Service role alone.
create or replace function discovery_rule_firm_ok(p_tenant_id uuid, p_item_id uuid, p_team_mailbox_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select false;
$$;

revoke all on function discovery_rule_firm_ok(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_rule_firm_ok(uuid, uuid, uuid) to service_role;

-- ── 2. An item's current events for one audience ────────────────────────────────
-- Ids and a basis only, never text or a span. An item outside p_tenant_id has none. "Latest" orders
-- the calls (and the detections) as created_at desc, id desc. Service role alone: the inputs and the
-- read RPC below call it as its owner.
--
-- The events are the chosen answer's own set (audit S4), not every event of its version. An `ok` call
-- for edited content writes its events `on conflict do nothing` on (item, version, type, span_start), so
-- an event it finds again keeps the row an earlier call of the same version wrote, and an event it no
-- longer finds stays stored. So the event table alone cannot tell the two apart: the call's own answer
-- can. model_calls.parsed holds it (discovery_record_extraction writes p_events there: types, dates,
-- offsets and confidence, never a quote), and an event belongs to the call when its (type, span_start)
-- is in it. A same-prompt, same-model answer that finds nothing for the edited content therefore names
-- no event, and the earlier content's events stop counting. A parsed value that is not an array names
-- nothing. The rules branch reads the detection ledger the same way: slice 3b's milestone_detections
-- keeps each detection's own (type, span_start) set in `parsed`, like model_calls.
create or replace function discovery_current_event_ids(p_tenant_id uuid, p_item_id uuid, p_team_mailbox_id uuid)
returns table (event_id uuid, basis text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_hash    text;
  v_version text;
  v_parsed  jsonb;
begin
  select si.content_hash into v_hash from source_items si where si.id = p_item_id and si.tenant_id = p_tenant_id;
  if not found then return; end if;

  -- The model decides when it has answered for this content, even with no milestone.
  select mc.prompt_version || ':' || mc.model, mc.parsed into v_version, v_parsed
    from model_calls mc
   where mc.source_item_id = p_item_id and mc.tenant_id = p_tenant_id
     and mc.content_hash = v_hash and mc.outcome = 'ok'
   order by mc.created_at desc, mc.id desc
   limit 1;
  if found then
    return query
      select me.id, 'model'::text
        from milestone_events me
       where me.source_item_id = p_item_id and me.tenant_id = p_tenant_id
         and me.model_call_id is not null and me.extractor_version = v_version
         and exists (select 1
                       from jsonb_to_recordset(case when jsonb_typeof(v_parsed) = 'array' then v_parsed else '[]'::jsonb end)
                            as p(type text, span_start int)
                      where p.type = me.type and p.span_start = me.span_start);
    return;
  end if;

  -- Otherwise the rules, only through an approved firm, and only once the detection ledger exists.
  if not coalesce(discovery_rule_firm_ok(p_tenant_id, p_item_id, p_team_mailbox_id), false) then return; end if;
  if to_regclass('public.milestone_detections') is null then return; end if;
  return query execute
    'select me.id, ''rules''::text
       from (select d.rules_version, d.parsed from milestone_detections d
              where d.source_item_id = $1 and d.tenant_id = $2 and d.content_hash = $3
              order by d.created_at desc, d.id desc
              limit 1) d
       join milestone_events me on me.source_item_id = $1 and me.tenant_id = $2 and me.model_call_id is null
                               and me.extractor_version = d.rules_version
      where exists (select 1
                      from jsonb_to_recordset(case when jsonb_typeof(d.parsed) = ''array'' then d.parsed else ''[]''::jsonb end)
                           as p(type text, span_start int)
                     where p.type = me.type and p.span_start = me.span_start)'
    using p_item_id, p_tenant_id, v_hash;
end; $$;

revoke all on function discovery_current_event_ids(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_current_event_ids(uuid, uuid, uuid) to service_role;

-- ── 3. The inputs: each audience's events through the one rule ──────────────────
-- discovery_audience_assessment_inputs, restated from 20261023130100_discovery_scoped_assessments.sql (its only definition). Changes: in
-- each branch the events are the item's current events for that branch's audience
-- (discovery_current_event_ids: null for the shared branch, T for the team branch), and basis is the
-- rule's. In the team branch the event join moves after the inbox lateral, which names T. The return
-- type is unchanged, so `create or replace` keeps the owner and ACL; the grants are restated anyway.
create or replace function discovery_audience_assessment_inputs(p_tenant_id uuid, p_candidate_ids uuid[])
returns table (candidate_id uuid, source_item_id uuid, event_id uuid, type text, occurred_at date,
               confidence numeric, extractor_version text, created_at timestamptz,
               team_mailbox_id uuid, basis text)
language sql stable security definer set search_path = public, pg_temp as $$
  select el.candidate_id, me.source_item_id, me.id, me.type, me.occurred_at, me.confidence, me.extractor_version, me.created_at,
         null::uuid, ce.basis
  from deal_candidates dc
  join evidence_links el on el.candidate_id = dc.id
                        and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed')
  cross join lateral discovery_current_event_ids(p_tenant_id, el.source_item_id, null) ce
  join milestone_events me on me.id = ce.event_id and me.source_item_id = el.source_item_id and me.tenant_id = p_tenant_id
  where dc.tenant_id = p_tenant_id and dc.id = any (p_candidate_ids)
    and app_item_has_allowed_source(el.source_item_id)
  union all
  select el.candidate_id, me.source_item_id, me.id, me.type, me.occurred_at, me.confidence, me.extractor_version, me.created_at,
         t.team_mailbox_id, ce.basis
  from deal_candidates dc
  join evidence_links el on el.candidate_id = dc.id
                        and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed')
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
  cross join lateral discovery_current_event_ids(p_tenant_id, el.source_item_id, t.team_mailbox_id) ce
  join milestone_events me on me.id = ce.event_id and me.source_item_id = el.source_item_id and me.tenant_id = p_tenant_id
  where dc.tenant_id = p_tenant_id and dc.id = any (p_candidate_ids);
$$;

revoke all on function discovery_audience_assessment_inputs(uuid, uuid[]) from public, anon, authenticated;
grant execute on function discovery_audience_assessment_inputs(uuid, uuid[]) to service_role;

-- ── 4. The readers' side: which of the given items' events are current ─────────
-- The timeline and the evidence list read milestone_events under RLS and keep only the ids this
-- answers. Bound to auth.uid() (like discovery_item_metadata): only items app_can_see_item admits for
-- the caller, and nothing without a signed-in caller. An event is current when the rule names it for
-- an audience of the item the caller belongs to: the shared one, which every reader of the item is in,
-- or an allowed team inbox T of the item whose audience holds the caller (audit S5). The caller is in
-- T's audience as one of T's readers (T's team source is among app_owned_source_ids, the member test of
-- 20261021160000) or as the CCO of T's firm (app_is_firm_cco, seated in T's registration's firm). So a
-- banker who sees a mixed item through their own mailbox never reads a rule event that counts only
-- through T's firm's approval. A model answer is the same for every audience; a rule event (slice 3b)
-- shows while the firm of an audience the caller is in approves it, and stops at once when none does.
-- The caller's owned set and CCO seat are read once per call, not once per item. Ids and a basis,
-- never text or a span.
create or replace function discovery_item_current_events(p_item_ids uuid[])
returns table (item_id uuid, event_id uuid, basis text)
language sql stable security definer set search_path = public, pg_temp as $$
  with caller as materialized (
    select app_owned_source_ids() as owned,
           (select u.company_id from users u
             where u.id = auth.uid() and u.firm_role = 'cco' and u.status = 'active' and u.is_external = false) as cco_company
  )
  select distinct si.id, ce.event_id, ce.basis
  from caller
  cross join source_items si
  cross join lateral (
    select null::uuid as team_mailbox_id
    union
    select c.team_mailbox_id
    from source_item_sources s
    join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                          and c.tenant_id = si.tenant_id and c.team_mailbox_id is not null
    join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                 and a.address = lower(c.address) and a.provider = c.provider
    where s.source_item_id = si.id
      and (c.id = any (caller.owned)
           or (caller.cco_company = a.firm_company_id and app_is_firm_cco(a.tenant_id, auth.uid())))
  ) aud
  cross join lateral discovery_current_event_ids(si.tenant_id, si.id, aud.team_mailbox_id) ce
  where auth.uid() is not null
    and si.id = any (coalesce(p_item_ids, '{}'::uuid[]))
    and app_can_see_item(si.id, auth.uid());
$$;

revoke all on function discovery_item_current_events(uuid[]) from public, anon, authenticated;
grant execute on function discovery_item_current_events(uuid[]) to authenticated;
