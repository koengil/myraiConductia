-- Send census (#425): count actual Resend relay sends in the week they left.
-- Attribute to the sender's mailbox active at send time, Google first. Archiving
-- a mailbox cannot reassign its past sends; senders without one are counted only
-- in the job's unattributed total. No address or content enters the census.
create or replace function send_census_refresh(p_tenant uuid, p_weeks integer default 8)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_to date := date_trunc('week', now() at time zone 'utc')::date;
  v_from date;
  v_lo timestamptz;
  v_hi timestamptz;
  v_rows integer;
  v_unattributed integer;
begin
  if p_tenant is null or p_weeks is null or p_weeks < 1 or p_weeks > 1040 then
    raise exception 'send_census_refresh: a tenant and 1..1040 weeks' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('send_census:' || p_tenant::text, 0));
  v_from := v_to - p_weeks * 7;
  v_lo := v_from::timestamp at time zone 'utc';
  v_hi := v_to::timestamp at time zone 'utc';
  delete from send_census_weekly where tenant_id = p_tenant and week >= v_from and week < v_to;
  with weeks as (
    select d::date as week from generate_series(v_from::timestamp, (v_to - 7)::timestamp, interval '7 days') d
  ), sources as (
    -- A source re-created for a mailbox whose ownerless source was archived starts at the first Monday on or after
    -- its creation; the archived source keeps the weeks before its archived_at, so no week is counted twice.
    select s.id, s.provider, s.last_synced_at, s.archived_at, s.backfill_completed_at, s.send_census_from as census_from,
           case when exists (select 1 from content_sources p
                              where p.tenant_id = s.tenant_id and p.kind = 'mailbox' and p.id <> s.id
                                and p.archived_at is not null and lower(p.archived_from_address) = lower(s.address))
                then (s.created_at at time zone 'utc')::date
                     + (8 - extract(isodow from (s.created_at at time zone 'utc')::date)::integer) % 7
           end as successor_from
      from content_sources s where s.tenant_id = p_tenant and s.kind = 'mailbox'
  ), grid as (
    select w.week, s.id as source_id from weeks w join sources s
      on s.provider = 'google' and s.backfill_completed_at is not null
     and w.week >= coalesce(s.census_from, '-infinity'::date)
     and w.week >= coalesce(s.successor_from, '-infinity'::date)
     and s.last_synced_at >= ((w.week + 7)::timestamp at time zone 'utc')
     and (s.archived_at is null or s.archived_at >= ((w.week + 7)::timestamp at time zone 'utc'))
  ), sent as (
    select l.source_id, date_trunc('week', l.sent_at at time zone 'utc')::date as week, count(*)::integer as n
      from routing_ledger l join sources s on s.id = l.source_id
     where l.sent_at >= v_lo and l.sent_at < v_hi group by 1, 2
  ), relay as (
    select om.sender_id, coalesce(om.reviewed_at, om.created_at) as left_at
      from outbound_messages om
     where om.tenant_id = p_tenant and om.status = 'sent' and om.provider = 'resend'
       and coalesce(om.reviewed_at, om.created_at) >= v_lo
       and coalesce(om.reviewed_at, om.created_at) < v_hi
  ), attributed as (
    select r.sender_id, r.week, coalesce(h.source_id, g.source_id) as source_id
      from (select sender_id, left_at, date_trunc('week', left_at at time zone 'utc')::date as week from relay) r
      left join lateral (
        select s.id as source_id from content_sources s
         where s.tenant_id = p_tenant and s.kind = 'mailbox' and s.owner_user_id = r.sender_id
           and s.created_at <= r.left_at and (s.archived_at is null or s.archived_at > r.left_at)
         order by (s.provider = 'google') desc, s.created_at, s.id
         limit 1
      ) h on true
      -- No mailbox was active when it left (it was sent before the mailbox was connected): the sender's earliest
      -- Google mailbox whose census covers that week takes it, so the week's native and platform sit on one row.
      left join lateral (
        select gr.source_id from grid gr join content_sources s on s.id = gr.source_id
         where h.source_id is null and gr.week = r.week and s.owner_user_id = r.sender_id
         order by s.created_at, s.id
         limit 1
      ) g on true
  ), platform as (
    select source_id, week, count(*)::integer as n from attributed where source_id is not null group by 1, 2
  ), native as (
    select g.week, g.source_id, coalesce(x.n, 0) as n
      from grid g left join sent x on x.source_id = g.source_id and x.week = g.week
  ), inserted as (
    insert into send_census_weekly (tenant_id, week, source_id, native, platform)
    select p_tenant, coalesce(n.week, p.week), coalesce(n.source_id, p.source_id), n.n, coalesce(p.n, 0)
      from native n full join platform p on p.source_id = n.source_id and p.week = n.week
    returning 1
  )
  select (select count(*) from inserted), (select count(distinct sender_id) from attributed where source_id is null)
    into v_rows, v_unattributed;
  return jsonb_build_object('rows', v_rows, 'unattributed', v_unattributed);
end;
$$;
revoke all on function send_census_refresh(uuid, integer) from public, anon, authenticated;
grant execute on function send_census_refresh(uuid, integer) to service_role;
