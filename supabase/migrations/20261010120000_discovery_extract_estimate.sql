-- The extractor's pre-run estimate (#261, design Q4). discovery_extract_pending is
-- the would-be-extracted set: discovery_extract_batch's predicate (20261002200000)
-- without its order, limit and 30-second back-off, returning ids and byte lengths
-- only. octet_length is taken from the TOAST header and never detoasts the value,
-- so neither function returns or decompresses a body. Service role only.
create or replace function discovery_extract_pending(p_tenant_id uuid, p_prompt_version text, p_model text)
returns table (source_item_id uuid, conversation_id text, subject_bytes integer, body_bytes integer)
language sql stable security definer set search_path = public as $$
  select si.id, si.conversation_id, coalesce(octet_length(si.subject), 0), octet_length(t.body_text)
  from source_items si
  join source_item_texts t on t.source_item_id = si.id
  left join lateral (
    select count(*) filter (where mc.outcome = 'failed') as failures,
           bool_or(mc.outcome in ('ok', 'invalid')) as settled
    from model_calls mc
    where mc.source_item_id = si.id and mc.content_hash = si.content_hash
      and mc.prompt_version = p_prompt_version and mc.model = p_model
  ) f on true
  where si.tenant_id = p_tenant_id and si.kind = 'message'
    and exists (select 1 from evidence_links el join deal_candidates dc on dc.id = el.candidate_id
                where el.source_item_id = si.id and dc.tenant_id = p_tenant_id and dc.discovery_state <> 'rejected'
                  and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed'))
    and app_item_has_allowed_source(si.id)
    and not coalesce(f.settled, false) and coalesce(f.failures, 0) < 3;
$$;

-- Percentiles are cast to numeric before round(): round(double precision) rounds halves to even,
-- round(numeric) away from zero, which is what the TS side (Math.round) does for these non-negative sizes.
create or replace function discovery_extract_stats(p_tenant_id uuid, p_prompt_version text, p_model text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'items', count(*),
    'threads', count(distinct p.conversation_id),
    'bodyBytes', jsonb_build_object(
      'total', coalesce(sum(p.body_bytes), 0),
      'mean', coalesce(round(avg(p.body_bytes)), 0),
      'median', coalesce(round((percentile_cont(0.5) within group (order by p.body_bytes))::numeric), 0),
      'p95', coalesce(round((percentile_cont(0.95) within group (order by p.body_bytes))::numeric), 0),
      'max', coalesce(max(p.body_bytes), 0)),
    'subjectBytes', jsonb_build_object(
      'total', coalesce(sum(p.subject_bytes), 0),
      'mean', coalesce(round(avg(p.subject_bytes)), 0),
      'median', coalesce(round((percentile_cont(0.5) within group (order by p.subject_bytes))::numeric), 0),
      'p95', coalesce(round((percentile_cont(0.95) within group (order by p.subject_bytes))::numeric), 0),
      'max', coalesce(max(p.subject_bytes), 0)))
  from discovery_extract_pending(p_tenant_id, p_prompt_version, p_model) p;
$$;

revoke all on function discovery_extract_pending(uuid, text, text), discovery_extract_stats(uuid, text, text)
  from public, anon, authenticated;
grant execute on function discovery_extract_pending(uuid, text, text), discovery_extract_stats(uuid, text, text) to service_role;
