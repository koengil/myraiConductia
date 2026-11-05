-- supabase/migrations/20261023110400_team_mailbox_audit_proposals.sql
-- #173 G-01, the trail slice: the firm's admin and CCO see the AI proposal passes over their team inboxes and the
-- owner's capability switches for their firm company, in the team inbox audit trail.
--
-- discovery_team_mailbox_audit is restated from 20261023100300_team_mailbox_audit_read.sql (its only definition) with
-- the signature, the gate, the scope, the grants and every existing branch unchanged. Three additions:
--   B1  also takes discovery.team_mailbox_proposal_started and _finished (20261023110200) naming an inbox of M, the
--       same teamMailboxId match as the inbox's other access rows;
--   B7  a new access branch: discovery.tenant_approval_changed (20261023110100) whose firmCompanyId is the caller's own
--       company, for every capability (team_proposals, milestone_rules, firm_name_alias). Another firm company's
--       switch is never shown. It is a firm event: no inbox, so inboxId is null;
--   detail keys, each only when well formed: path and outcome of a pass (codes), the five integer counts of a finished
--       pass (asked, deal, notDeal, invalid, failed, from its counts object, 0 to 1,000,000,000 as the writer bounds them), and capability (a code) and on (a
--       boolean) of a switch. A switch's decisionRef is free text and is never returned; nor are a pass's runId,
--       passId or lastRenewedAt.
-- B7 reads through audit_log_tenant_action_ts (20261023100200) like the other access branches. No schema change and
-- no new action: both actions are already in audit_log_action_check (20261023110200), which this file does not touch.
--
-- Reverse: restate the function from 20261023100300.

create or replace function discovery_team_mailbox_audit(
  p_view      text default 'access',
  p_before_ts timestamptz default null,
  p_before_id uuid default null,
  p_limit     integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  c_code    constant text := '^[a-z0-9_]{1,40}$';
  c_uuid    constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_date    constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
  c_count   constant text := '^[0-9]{1,9}$';
  -- A pass's counts: 0 to 1,000,000,000 inclusive, the bound discovery_team_pass_counts writes (20261023110200).
  c_pass_count constant text := '^([0-9]{1,9}|1000000000)$';
  c_service constant text := '^[a-z0-9-]{1,64}$';
  v_uid      uuid := auth.uid();
  v_tenant   uuid;
  v_role     text;
  v_company  uuid;
  v_view     text := coalesce(p_view, 'access');
  v_limit    integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_inboxes  uuid[];
  v_ids      text[];    -- M, as the text detail->>'teamMailboxId' holds
  v_refs     text[];    -- M, as the drift lists name a team address ('team:' || id)
  v_sources  text[];    -- S, as detail->>'sourceId' holds
  v_inbox_of jsonb;     -- sourceId -> teamMailboxId, for the pass rows
  v_google   boolean;
  v_inbox_list jsonb;
  v_rows     jsonb;
  v_next     jsonb;
begin
  -- ── Gate ──────────────────────────────────────────────────────────────────
  select u.tenant_id, u.firm_role, u.company_id into v_tenant, v_role, v_company
  from users u
  where u.id = v_uid and u.status = 'active' and u.is_external = false;
  if v_uid is null or v_tenant is null or v_role is null or v_role not in ('admin', 'cco') then
    raise exception 'not_available' using errcode = '42501';
  end if;
  -- ── Scope: the company's registrations, open and closed ───────────────────
  select coalesce(array_agg(tm.id order by tm.connected_at, tm.id), '{}'::uuid[]) into v_inboxes
  from team_mailboxes tm
  where tm.tenant_id = v_tenant and tm.firm_company_id = v_company;
  if cardinality(v_inboxes) = 0 then
    raise exception 'not_available' using errcode = '42501';
  end if;

  if v_view not in ('access', 'reads', 'reads_notable') then
    raise exception 'bad_view' using errcode = '22023';
  end if;
  if (p_before_ts is null) <> (p_before_id is null) then
    raise exception 'bad_cursor' using errcode = '22023';
  end if;

  v_ids  := array(select x::text from unnest(v_inboxes) x);
  v_refs := array(select 'team:' || x::text from unnest(v_inboxes) x);
  -- S: the live sources of M, and those its connect rows recorded (a purged inbox's source is gone from
  -- content_sources; its reads stay in the trail). One registration per source, the live row first.
  select coalesce(array_agg(x.id order by x.id), '{}'::text[]),
         coalesce(jsonb_object_agg(x.id, x.inbox), '{}'::jsonb)
    into v_sources, v_inbox_of
  from (
    select distinct on (y.id) y.id, y.inbox
    from (
      select cs.id::text as id, cs.team_mailbox_id::text as inbox, 0 as pick
      from content_sources cs
      where cs.tenant_id = v_tenant and cs.team_mailbox_id = any (v_inboxes)
      union all
      select a.detail ->> 'sourceId', a.detail ->> 'teamMailboxId', 1
      from audit_log a
      where a.tenant_id = v_tenant
        and a.action = 'discovery.team_mailbox_connected'
        and a.detail ->> 'teamMailboxId' = any (v_ids)
        and (a.detail ->> 'sourceId') ~ c_uuid
    ) y
    order by y.id, y.pick
  ) x;
  v_google := exists (select 1 from google_reader_registrations g
                      where g.tenant_id = v_tenant and g.firm_company_id = v_company);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', tm.id,
           'address', case when tm.disconnected_at is null then tm.address end,
           'open', tm.disconnected_at is null)
         order by tm.connected_at, tm.id), '[]'::jsonb)
    into v_inbox_list
  from team_mailboxes tm
  where tm.id = any (v_inboxes);

  -- ── Rows ──────────────────────────────────────────────────────────────────
  with picked as (
    -- B1: the inbox's own access and check rows, and its AI proposal passes (G-01).
    (select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
     from audit_log a
     where v_view = 'access'
       and a.tenant_id = v_tenant
       and a.action = any (array['discovery.team_mailbox_connected', 'discovery.team_mailbox_checked',
                                 'discovery.team_mailbox_member_added', 'discovery.team_mailbox_member_removed',
                                 'discovery.team_mailbox_disconnected', 'discovery.mailbox_access_changed',
                                 'discovery.mailbox_refused', 'discovery.team_mailbox_proposal_started',
                                 'discovery.team_mailbox_proposal_finished'])
       and a.detail ->> 'teamMailboxId' = any (v_ids)
       and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
     order by a.ts desc, a.id desc
     limit v_limit + 1)
    union all
    -- B2: deals firm rules proposed from the inbox's mail (G-03 4/4 writes teamMailboxIds).
    (select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
     from audit_log a
     where v_view = 'access'
       and a.tenant_id = v_tenant
       and a.action = 'discovery.candidate_proposed'
       and (case when jsonb_typeof(a.detail -> 'teamMailboxIds') = 'array'
                 then (a.detail -> 'teamMailboxIds') ?| v_ids else false end)
       and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
     order by a.ts desc, a.id desc
     limit v_limit + 1)
    union all
    -- B3: the Google ingest group, a firm event for the registration's company only.
    (select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
     from audit_log a
     where v_view = 'access'
       and v_google
       and a.tenant_id = v_tenant
       and a.action = 'discovery.allowlist_drift'
       and a.detail ->> 'provider' = 'google'
       and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
     order by a.ts desc, a.id desc
     limit v_limit + 1)
    union all
    -- B7: the owner's capability switches for the caller's own firm company, any capability (G-01, G-07, G-09).
    (select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
     from audit_log a
     where v_view = 'access'
       and a.tenant_id = v_tenant
       and a.action = 'discovery.tenant_approval_changed'
       and a.detail ->> 'firmCompanyId' = v_company::text
       and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
     order by a.ts desc, a.id desc
     limit v_limit + 1)
    union all
    -- B4: every pass record of the inbox's sources, one source at a time.
    (select p.id, p.ts, p.action, p.actor_type, p.actor_id, p.service_identity, p.detail
     from unnest(v_sources) s (id)
     cross join lateral (
       select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
       from audit_log a
       where a.tenant_id = v_tenant
         and a.action in ('discovery.reader_pass_started', 'discovery.reader_pass_finished')
         and a.detail ->> 'sourceId' = s.id
         and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
       order by a.ts desc, a.id desc
       limit v_limit + 1) p
     where v_view = 'reads'
     order by p.ts desc, p.id desc
     limit v_limit + 1)
    union all
    -- B5: finished passes that stored or excluded anything, or did not complete.
    (select p.id, p.ts, p.action, p.actor_type, p.actor_id, p.service_identity, p.detail
     from unnest(v_sources) s (id)
     cross join lateral (
       select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
       from audit_log a
       where a.tenant_id = v_tenant
         and a.action = 'discovery.reader_pass_finished'
         and a.detail ->> 'sourceId' = s.id
         and (case when (a.detail ->> 'stored') ~ c_count then (a.detail ->> 'stored')::integer > 0 else false end
              or case when (a.detail ->> 'excluded') ~ c_count then (a.detail ->> 'excluded')::integer > 0 else false end
              or (a.detail ->> 'status') is distinct from 'complete')
         and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
       order by a.ts desc, a.id desc
       limit v_limit + 1) p
     where v_view = 'reads_notable'
     order by p.ts desc, p.id desc
     limit v_limit + 1)
    union all
    -- B6: passes started over an hour ago with no finish recorded for them.
    (select p.id, p.ts, p.action, p.actor_type, p.actor_id, p.service_identity, p.detail
     from unnest(v_sources) s (id)
     cross join lateral (
       select a.id, a.ts, a.action, a.actor_type, a.actor_id, a.service_identity, a.detail
       from audit_log a
       where a.tenant_id = v_tenant
         and a.action = 'discovery.reader_pass_started'
         and a.detail ->> 'sourceId' = s.id
         and a.ts <= now() - interval '3600 seconds'
         and not exists (
           select 1 from audit_log f
           where f.tenant_id = v_tenant
             and f.action = 'discovery.reader_pass_finished'
             and f.detail ->> 'passId' = a.detail ->> 'passId'
             and f.detail ->> 'sourceId' = a.detail ->> 'sourceId'
             and f.detail ->> 'runId' = a.detail ->> 'runId')
         and (p_before_ts is null or (a.ts <= p_before_ts and (a.ts, a.id) < (p_before_ts, p_before_id)))
       order by a.ts desc, a.id desc
       limit v_limit + 1) p
     where v_view = 'reads_notable'
     order by p.ts desc, p.id desc
     limit v_limit + 1)
  ),
  page as (
    select k.*, row_number() over (order by k.ts desc, k.id desc) as rn
    from (select * from picked order by ts desc, id desc limit v_limit + 1) k
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id,
      'ts', pg.ts,
      'action', pg.action,
      'actorType', pg.actor_type,
      'actorName', actor.name,
      'serviceIdentity', case when pg.actor_type <> 'user' and pg.service_identity ~ c_service
                              then pg.service_identity end,
      'subjectName', subject.name,
      'inboxId', case
                   when pg.detail ->> 'teamMailboxId' = any (v_ids) then pg.detail ->> 'teamMailboxId'
                   when pg.action in ('discovery.reader_pass_started', 'discovery.reader_pass_finished')
                     then v_inbox_of ->> (pg.detail ->> 'sourceId')
                   when pg.action = 'discovery.candidate_proposed'
                     then (select min(x) from jsonb_array_elements_text(pg.detail -> 'teamMailboxIds') x
                           where x = any (v_ids))
                 end,
      'detail', jsonb_strip_nulls(jsonb_build_object(
        'teamMailboxId', case when pg.detail ->> 'teamMailboxId' = any (v_ids) then pg.detail -> 'teamMailboxId' end,
        'sourceId', case when pg.detail ->> 'sourceId' = any (v_sources) then pg.detail -> 'sourceId' end,
        'status', case when jsonb_typeof(pg.detail -> 'status') = 'string' and (pg.detail ->> 'status') ~ c_code
                       then pg.detail -> 'status' end,
        'reason', case when jsonb_typeof(pg.detail -> 'reason') = 'string' and (pg.detail ->> 'reason') ~ c_code
                       then pg.detail -> 'reason' end,
        'purpose', case when jsonb_typeof(pg.detail -> 'purpose') = 'string' and (pg.detail ->> 'purpose') ~ c_code
                        then pg.detail -> 'purpose' end,
        'provider', case when jsonb_typeof(pg.detail -> 'provider') = 'string' and (pg.detail ->> 'provider') ~ c_code
                         then pg.detail -> 'provider' end,
        'change', case when jsonb_typeof(pg.detail -> 'change') = 'string' and (pg.detail ->> 'change') ~ c_code
                       then pg.detail -> 'change' end,
        'from', case when pg.detail ->> 'change' = 'window_set' and jsonb_typeof(pg.detail -> 'from') = 'string'
                          and (pg.detail ->> 'from') ~ c_date
                     then pg.detail -> 'from' end,
        'to', case when pg.detail ->> 'change' = 'window_set' and jsonb_typeof(pg.detail -> 'to') = 'string'
                        and (pg.detail ->> 'to') ~ c_date
                   then pg.detail -> 'to' end,
        'fetched', case when pg.action = 'discovery.reader_pass_finished' and jsonb_typeof(pg.detail -> 'fetched') = 'number'
                             and (pg.detail ->> 'fetched') ~ c_count
                        then pg.detail -> 'fetched' end,
        'stored', case when pg.action = 'discovery.reader_pass_finished' and jsonb_typeof(pg.detail -> 'stored') = 'number'
                            and (pg.detail ->> 'stored') ~ c_count
                       then pg.detail -> 'stored' end,
        'excluded', case when pg.action = 'discovery.reader_pass_finished' and jsonb_typeof(pg.detail -> 'excluded') = 'number'
                              and (pg.detail ->> 'excluded') ~ c_count
                         then pg.detail -> 'excluded' end,
        -- An AI proposal pass: its path, how it ended and its five integer counts (G-01).
        'path', case when pg.action in ('discovery.team_mailbox_proposal_started', 'discovery.team_mailbox_proposal_finished')
                          and jsonb_typeof(pg.detail -> 'path') = 'string' and (pg.detail ->> 'path') ~ c_code
                     then pg.detail -> 'path' end,
        'outcome', case when pg.action = 'discovery.team_mailbox_proposal_finished'
                             and jsonb_typeof(pg.detail -> 'outcome') = 'string' and (pg.detail ->> 'outcome') ~ c_code
                        then pg.detail -> 'outcome' end,
        'asked', case when pg.action = 'discovery.team_mailbox_proposal_finished'
                           and jsonb_typeof(pg.detail -> 'counts' -> 'asked') = 'number'
                           and (pg.detail -> 'counts' ->> 'asked') ~ c_pass_count
                      then pg.detail -> 'counts' -> 'asked' end,
        'deal', case when pg.action = 'discovery.team_mailbox_proposal_finished'
                          and jsonb_typeof(pg.detail -> 'counts' -> 'deal') = 'number'
                          and (pg.detail -> 'counts' ->> 'deal') ~ c_pass_count
                     then pg.detail -> 'counts' -> 'deal' end,
        'notDeal', case when pg.action = 'discovery.team_mailbox_proposal_finished'
                             and jsonb_typeof(pg.detail -> 'counts' -> 'notDeal') = 'number'
                             and (pg.detail -> 'counts' ->> 'notDeal') ~ c_pass_count
                        then pg.detail -> 'counts' -> 'notDeal' end,
        'invalid', case when pg.action = 'discovery.team_mailbox_proposal_finished'
                             and jsonb_typeof(pg.detail -> 'counts' -> 'invalid') = 'number'
                             and (pg.detail -> 'counts' ->> 'invalid') ~ c_pass_count
                        then pg.detail -> 'counts' -> 'invalid' end,
        'failed', case when pg.action = 'discovery.team_mailbox_proposal_finished'
                            and jsonb_typeof(pg.detail -> 'counts' -> 'failed') = 'number'
                            and (pg.detail -> 'counts' ->> 'failed') ~ c_pass_count
                       then pg.detail -> 'counts' -> 'failed' end,
        -- A capability switch: which capability, and whether it is now on. Never the decision reference (free text).
        'capability', case when pg.action = 'discovery.tenant_approval_changed'
                                and jsonb_typeof(pg.detail -> 'capability') = 'string'
                                and (pg.detail ->> 'capability') ~ c_code
                           then pg.detail -> 'capability' end,
        'on', case when pg.action = 'discovery.tenant_approval_changed' and jsonb_typeof(pg.detail -> 'on') = 'boolean'
                   then pg.detail -> 'on' end,
        'evidenceCount', case when pg.action = 'discovery.candidate_proposed'
                                   and jsonb_typeof(pg.detail -> 'evidenceCount') = 'number'
                                   and (pg.detail ->> 'evidenceCount') ~ c_count
                              then pg.detail -> 'evidenceCount' end,
        -- Against M only, so the row never says anything about another firm's inbox.
        'thisInbox', case when pg.action <> 'discovery.allowlist_drift' then null
                          when drift.missing and drift.extra then 'both'
                          when drift.missing then 'missing'
                          when drift.extra then 'extra'
                        end)))
      order by pg.ts desc, pg.id desc) filter (where pg.rn <= v_limit), '[]'::jsonb),
    (select jsonb_build_object('ts', l.ts, 'id', l.id) from page l
     where l.rn = v_limit and exists (select 1 from page x where x.rn = v_limit + 1))
    into v_rows, v_next
  from page pg
  left join lateral (
    select case when q.n ~ '@' then null else q.n end as name
    from (select coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), '')) as n
          from users u
          where u.id = pg.actor_id and u.tenant_id = v_tenant) q
  ) actor on true
  left join lateral (
    select case when q.n ~ '@' then null else q.n end as name
    from (select coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), '')) as n
          from users u
          where pg.action in ('discovery.team_mailbox_member_added', 'discovery.team_mailbox_member_removed')
            and u.id = case when (pg.detail ->> 'userId') ~ c_uuid then (pg.detail ->> 'userId')::uuid end
            and u.tenant_id = v_tenant) q
  ) subject on true
  left join lateral (
    -- Whether one of M is missing from the Google group, and whether one is in it but not on the allowlist.
    select
      case when jsonb_typeof(pg.detail -> 'missingInGroup') = 'array'
           then exists (select 1 from jsonb_array_elements_text(pg.detail -> 'missingInGroup') m where m = any (v_refs))
           else false end as missing,
      case when jsonb_typeof(pg.detail -> 'extraInGroup') = 'array'
           then exists (select 1 from jsonb_array_elements_text(pg.detail -> 'extraInGroup') e where e = any (v_refs))
           else false end as extra
    where pg.action = 'discovery.allowlist_drift'
  ) drift on true;

  return jsonb_build_object('inboxes', v_inbox_list, 'rows', v_rows, 'next', v_next);
end;
$$;

revoke all on function discovery_team_mailbox_audit(text, timestamptz, uuid, integer) from public, anon, authenticated;
grant execute on function discovery_team_mailbox_audit(text, timestamptz, uuid, integer) to authenticated;
