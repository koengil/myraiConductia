-- G-07 slice 3b (#173, design R7, R9, R10): the rule detector reaches the database, behind the per-firm
-- milestone_rules approval of G-01's discovery_tenant_approvals (20261023110100). No approval row ships, so on every
-- database this changes nothing a person sees: the worker's --rules mode finds no firm, reads no mail and only drains
-- the recompute outbox. Rule events place a station and never a lifecycle (stage engine v2, slice 2b), a model answer
-- for the same content always beats them (discovery_current_event_ids, 20261023130400), and a promoted deal is closed
-- only by a model-basis closed event (20261023130200).
--
-- The approval is checked at four points (R10): the batch selects only items with an approved audience, the writer
-- checks again on every item (a revoke between the batch and the write stops it, 42501 capability_not_approved), the
-- current-events rule counts a rule event only through an approved firm (discovery_rule_firm_ok, restated here), and
-- the worker loads the approvals before it reads any mail (src/lib/discovery/tenantApprovals.ts).
--
--   milestone_detections   the detector's settle ledger, beside model_calls: one row per (item, content hash, rules
--                          version), with the detection's own answer in `parsed` (types, dates and offsets, never a
--                          quote), which the current-events rule matches a rule event against (audit S4, slice 2a).
--   milestone_events       model_call_id becomes nullable; a rule event names its detection_id instead, and exactly
--                          one of the two is set (milestone_events_one_origin_check).
--   discovery_rule_firm_ok                 restated over app_tenant_capability_on (it answered false since 130400)
--   discovery_detect_batch                 the one service-role read of stored text for the detector
--   discovery_record_detection             the ledger row, its events and one audit row, in one call
--   discovery_record_team_detection_pass   one audit row per team inbox per run (the trail lists it, slice 5)
--
-- milestone_events is a big table (supabase/lint/big-tables.txt): the new reference and check are added NOT VALID here
-- and validated in 20261023130602; the index the reference's cascade needs is built concurrently in 20261023130601.
-- Every existing row has a model_call_id and no detection_id, so neither can fail.
--
-- audit_log_action_check is restated in full from 20261023120000_model_proposal_dismissal_audit.sql (G-02a #732), the
-- newest restatement on develop, which holds discovery.model_proposal_dismissed and
-- discovery.model_proposal_dismissal_restored, plus the two detection actions. Nothing is dropped.
--
-- Reverse: restate discovery_rule_firm_ok as `select false`, drop the three new functions, the check, the reference,
-- detection_id and milestone_detections, and restore model_call_id not null once no rule event is left. The audit
-- CHECK keeps the new actions.

-- ── 1. Two new audit actions ───────────────────────────────────────────────────
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied',
  'skill_publication.admitted', 'skill_publication.admission_denied', 'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition',
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied',
  'discovery.candidate_proposed', 'discovery.candidate_promoted', 'discovery.correction',
  'discovery.milestone_extracted', 'discovery.stage_assessed', 'discovery.mailbox_consented',
  'discovery.mailbox_consent_withdrawn', 'discovery.mailbox_refused', 'discovery.allowlist_drift',
  'discovery.site_registered', 'discovery.site_unregistered', 'discovery.site_refused',
  'discovery.mailbox_source_archived', 'discovery.mailbox_sources_unified', 'profile_provisioned',
  'identity_provider_configured', 'identity_provider_removed', 'work_identity_released', 'work_identity_connected',
  'discovery.mailbox_access_changed', 'discovery.exclusion_policy_changed', 'rail.template_published',
  'discovery.reader_pass_started', 'discovery.reader_pass_finished', 'discovery.mailbox_purged',
  'discovery.content_collected', 'discovery.group_removal_held', 'discovery.tenant_purged', 'discovery.retention_policy_set',
  'discovery.mailbox_retained',
  'mailbox.connected', 'mailbox.connect_refused', 'mailbox.disconnected', 'mailbox.approval_ended',
  'discovery.team_mailbox_connected', 'discovery.team_mailbox_checked', 'discovery.team_mailbox_member_added',
  'discovery.team_mailbox_member_removed', 'discovery.team_mailbox_disconnected',
  'discovery.tenant_approval_changed',
  'discovery.team_mailbox_proposal_started', 'discovery.team_mailbox_proposal_finished',
  'discovery.model_proposal_dismissed', 'discovery.model_proposal_dismissal_restored',
  'discovery.milestone_detected', 'discovery.team_mailbox_milestones_detected'
])) not valid;


-- ── 2. The settle ledger ─────────────────────────────────────────────────────────
create table if not exists milestone_detections (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  source_item_id uuid not null references source_items (id) on delete cascade,
  content_hash   text not null,
  rules_version  text not null check (rules_version ~ '^rules/v[0-9]+$'),
  events         integer not null check (events >= 0),
  -- The detection's own answer: [{type, occurred_at, span_start, span_end, confidence}], never a quote.
  parsed         jsonb not null check (jsonb_typeof(parsed) = 'array'),
  created_at     timestamptz not null default now(),
  unique (source_item_id, content_hash, rules_version)
);
alter table milestone_detections enable row level security;
-- No policy and no grant but a read for the worker: the writer below is the only way in, and nobody signed in reads it.
revoke all on milestone_detections from public, anon, authenticated, service_role;
grant select on milestone_detections to service_role;

-- ── 3. A rule event names its detection ───────────────────────────────────────────
alter table milestone_events alter column model_call_id drop not null;
alter table milestone_events add column if not exists detection_id uuid;
alter table milestone_events add constraint milestone_events_detection_fkey
  foreign key (detection_id) references milestone_detections (id) on delete cascade not valid;
alter table milestone_events add constraint milestone_events_one_origin_check
  check (num_nonnulls(model_call_id, detection_id) = 1) not valid;

-- ── 4. Whether an approved firm lets rule events count for an audience ─────────────
-- Restated from 20261023130400 (where it answered false). The shared audience (p_team_mailbox_id null) counts rule
-- events only when every firm that holds the item through an allowed personal mailbox (the owner's seat company) or
-- an allowed site (its firm company) has milestone_rules on, and at least one does. It fails closed (audit round on
-- #753): a message that a banker of an approved firm and a banker of an unapproved firm both hold lights nothing in
-- the shared audience, whose readers include the unapproved firm's. A team inbox T: T is an allowed team inbox of the
-- item in this tenant and T's firm company has it on; a team inbox's approval never lights the shared audience.
-- Service role alone.
create or replace function discovery_rule_firm_ok(p_tenant_id uuid, p_item_id uuid, p_team_mailbox_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  with firms as materialized (
    -- The firm of each allowed personal mailbox and each allowed site of the item: the shared audience's holders.
    select u.company_id as firm
    from source_item_sources s
    join source_items si on si.id = s.source_item_id and si.tenant_id = p_tenant_id
    join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                          and c.tenant_id = si.tenant_id and c.team_mailbox_id is null
    join allowed_mailboxes a on a.tenant_id = c.tenant_id and a.address = lower(c.address)
                            and a.user_id = c.owner_user_id and a.provider = c.provider
    join users u on u.id = a.user_id and u.tenant_id = a.tenant_id
    where p_team_mailbox_id is null and s.source_item_id = p_item_id
    union
    select a.firm_company_id
    from source_item_sources s
    join source_items si on si.id = s.source_item_id and si.tenant_id = p_tenant_id
    join content_sources c on c.id = s.content_source_id and c.kind = 'sharepoint_site' and c.tenant_id = si.tenant_id
    join allowed_sites a on a.tenant_id = c.tenant_id and a.address = lower(c.address)
    where p_team_mailbox_id is null and s.source_item_id = p_item_id
  )
  select case when p_team_mailbox_id is null then
    exists (select 1 from firms)
    and not exists (select 1 from firms f
                    where f.firm is null or not app_tenant_capability_on(p_tenant_id, f.firm, 'milestone_rules'))
  else
    exists (
      select 1 from source_item_sources s
      join source_items si on si.id = s.source_item_id and si.tenant_id = p_tenant_id
      join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                            and c.tenant_id = si.tenant_id and c.team_mailbox_id = p_team_mailbox_id
      join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                   and a.address = lower(c.address) and a.provider = c.provider
      where s.source_item_id = p_item_id
        and app_tenant_capability_on(p_tenant_id, a.firm_company_id, 'milestone_rules'))
  end;
$$;

revoke all on function discovery_rule_firm_ok(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_rule_firm_ok(uuid, uuid, uuid) to service_role;

-- The approved team inboxes of an item: the audiences a detection pass is recorded for. Ids only. Service role alone.
create or replace function discovery_item_approved_teams(p_tenant_id uuid, p_item_id uuid)
returns uuid[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct c.team_mailbox_id order by c.team_mailbox_id), '{}'::uuid[])
  from source_item_sources s
  join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox' and c.team_mailbox_id is not null
  where s.source_item_id = p_item_id and c.tenant_id = p_tenant_id
    and discovery_rule_firm_ok(p_tenant_id, p_item_id, c.team_mailbox_id);
$$;

revoke all on function discovery_item_approved_teams(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_item_approved_teams(uuid, uuid) to service_role;

-- ── 5. The batch: the one service-role read of stored text for the detector ─────────
-- In the shape of discovery_extract_batch (20261021190000): a live-linked message of the tenant (a firm or confirmed,
-- unrejected link of an unrejected candidate), with an approved audience (shared, or a team inbox), whose newest
-- detection under this rules version is not for its current content hash: never detected, edited since, or edited
-- back to content detected before (audit round on #753), so its rule events always carry the current text's dates. It does not ask app_item_has_allowed_source: a team-only
-- message is admitted through its approved inbox (discovery_rule_firm_ok checks the allowlist for each audience).
-- No model ever reads what it returns (ADR-0026 residual 3): the detector is pure and runs in the worker.
create or replace function discovery_detect_batch(p_tenant_id uuid, p_rules_version text, p_limit integer default 50)
returns table (item_id uuid, content_hash text, sent_at timestamptz, body_text text, team_mailbox_ids uuid[])
language sql stable security definer set search_path = public, pg_temp as $$
  select si.id, si.content_hash, si.sent_at, t.body_text, aud.teams
  from source_items si
  join source_item_texts t on t.source_item_id = si.id
  cross join lateral (select discovery_item_approved_teams(p_tenant_id, si.id) as teams) aud
  where si.tenant_id = p_tenant_id and si.kind = 'message'
    and exists (select 1 from evidence_links el join deal_candidates dc on dc.id = el.candidate_id
                where el.source_item_id = si.id and dc.tenant_id = p_tenant_id and dc.discovery_state <> 'rejected'
                  and el.state <> 'rejected' and (el.route_tier = 'firm' or el.state = 'confirmed'))
    and coalesce((select d.content_hash <> si.content_hash from milestone_detections d
                  where d.source_item_id = si.id and d.rules_version = p_rules_version
                  order by d.created_at desc, d.id desc limit 1), true)
    and (cardinality(aud.teams) > 0 or discovery_rule_firm_ok(p_tenant_id, si.id, null))
  order by si.sent_at nulls last, si.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function discovery_detect_batch(uuid, text, integer) from public, anon, authenticated;
grant execute on function discovery_detect_batch(uuid, text, integer) to service_role;

-- ── 6. The writer: a ledger row, its events and one audit row, in one call ────────────
-- p_detection: {source_item_id, content_hash, rules_version}. p_events: [{type, occurred_at, span_start, span_end,
-- confidence}]. The approval is checked again on the write: with no approved audience left for the item (a revoke
-- since the batch was read), it refuses with 42501 capability_not_approved and writes nothing. A detection that is
-- already the item's newest for the same (content hash, rules version) returns its id and writes nothing more. A
-- detection of content detected before but not newest (an edit undone) is renewed: it becomes the newest again with
-- this answer. Events are keyed like a model call's, (item, version, type, span_start), and a rule event found again
-- takes this detection's date, end and confidence and names this detection (audit round on #753: an edit from
-- "1 March" to "2 March" at the same offset must move the date), so the current-events rule, which matches the newest
-- detection's own answer, reads the current text's facts. A model event never shares a key with a rule event (its
-- version differs) and is never touched here. Audited as the deterministic service: ids, a count and the version.
create or replace function discovery_record_detection(p_tenant_id uuid, p_detection jsonb, p_events jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_item    uuid := (p_detection->>'source_item_id')::uuid;
  v_hash    text := p_detection->>'content_hash';
  v_version text := p_detection->>'rules_version';
  v_events  jsonb := coalesce(p_events, '[]'::jsonb);
  v_id      uuid;
  v_count   integer := 0;
begin
  perform 1 from source_items si where si.id = v_item and si.tenant_id = p_tenant_id;
  if not found then raise exception 'discovery_record_detection: item not in tenant' using errcode = '22023'; end if;
  if v_hash is null or v_version is null or v_version !~ '^rules/v[0-9]+$' or jsonb_typeof(v_events) <> 'array' then
    raise exception 'discovery_record_detection: malformed detection' using errcode = '22023';
  end if;
  if not (discovery_rule_firm_ok(p_tenant_id, v_item, null)
          or cardinality(discovery_item_approved_teams(p_tenant_id, v_item)) > 0) then
    raise exception 'capability_not_approved' using errcode = '42501';
  end if;
  -- Already the newest detection for this content: settled, nothing to write.
  select d.id into v_id from milestone_detections d
   where d.source_item_id = v_item and d.rules_version = v_version
   order by d.created_at desc, d.id desc limit 1;
  if v_id is not null and exists (select 1 from milestone_detections d where d.id = v_id and d.content_hash = v_hash) then
    return v_id;
  end if;
  -- New content, or content detected before and edited back: this answer is now the newest. clock_timestamp(), not
  -- now(): two detections of one item in one transaction must still order.
  insert into milestone_detections (tenant_id, source_item_id, content_hash, rules_version, events, parsed, created_at)
  values (p_tenant_id, v_item, v_hash, v_version, jsonb_array_length(v_events), v_events, clock_timestamp())
  on conflict (source_item_id, content_hash, rules_version)
    do update set events = excluded.events, parsed = excluded.parsed, created_at = excluded.created_at
  returning id into v_id;
  insert into milestone_events (tenant_id, source_item_id, type, occurred_at, span_start, span_end, confidence,
                                extractor_version, detection_id)
  select p_tenant_id, v_item, e.type, e.occurred_at, e.span_start, e.span_end, e.confidence, v_version, v_id
  from jsonb_to_recordset(v_events) as e(type text, occurred_at date, span_start int, span_end int, confidence numeric)
  on conflict (source_item_id, extractor_version, type, span_start)
    do update set occurred_at = excluded.occurred_at, span_end = excluded.span_end, confidence = excluded.confidence,
                  detection_id = excluded.detection_id
    where milestone_events.detection_id is not null;
  get diagnostics v_count = row_count;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant_id, 'service', 'discovery-worker', 'discovery.milestone_detected',
          jsonb_build_object('detectionId', v_id, 'sourceItemId', v_item, 'eventCount', v_count, 'rulesVersion', v_version));
  return v_id;
end; $$;

revoke all on function discovery_record_detection(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function discovery_record_detection(uuid, jsonb, jsonb) to service_role;

-- ── 7. One audit row per team inbox per run ─────────────────────────────────────
-- What a detection run did with one team inbox's mail: how many of its items it settled and how many events it
-- wrote. The inbox's firm admin and CCO read it in the team-inbox audit trail (slice 5). Ids and integers only. The
-- inbox must be an allowed team inbox of the tenant (22023).
create or replace function discovery_record_team_detection_pass(p_tenant_id uuid, p_team_mailbox_id uuid, p_run_id uuid,
                                                                p_counts jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_items  integer;
  v_events integer;
begin
  if not exists (select 1 from allowed_team_mailboxes a where a.team_mailbox_id = p_team_mailbox_id and a.tenant_id = p_tenant_id) then
    raise exception 'discovery_record_team_detection_pass: team inbox not allowed in tenant' using errcode = '22023';
  end if;
  if p_run_id is null or jsonb_typeof(p_counts->'items') <> 'number' or jsonb_typeof(p_counts->'events') <> 'number' then
    raise exception 'discovery_record_team_detection_pass: malformed counts' using errcode = '22023';
  end if;
  v_items := (p_counts->>'items')::integer;
  v_events := (p_counts->>'events')::integer;
  if v_items < 0 or v_events < 0 then
    raise exception 'discovery_record_team_detection_pass: malformed counts' using errcode = '22023';
  end if;
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant_id, 'service', 'discovery-worker', 'discovery.team_mailbox_milestones_detected',
          jsonb_build_object('teamMailboxId', p_team_mailbox_id, 'runId', p_run_id, 'items', v_items, 'events', v_events));
end; $$;

revoke all on function discovery_record_team_detection_pass(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_record_team_detection_pass(uuid, uuid, uuid, jsonb) to service_role;
