-- supabase/migrations/20261003110000_discovery_exclusion_policy.sql
-- Exclusion policy and the two-step read, Gmail path first (#263).
--
-- Before a message body is fetched, the tenant's exclusion policy runs on the
-- message's metadata. An excluded message is ledgered as skipped, with the
-- rule, the policy version and the provider thread id, and never gets a
-- source_items or source_item_texts row. This migration holds the storage:
--
-- 1. discovery_exclusion_policies: numbered, append-only versions per tenant.
--    Every insert writes a chained discovery.exclusion_policy_changed audit row
--    (the table is the history; the audit row carries rule ids and a hash, not
--    the domains). The only writer is discovery_exclusion_policy_set(), which
--    only service_role may call: the table itself grants service_role SELECT
--    and nothing else.
-- 2. routing_ledger: three nullable columns, four policy skip reasons, one
--    shape check, and discovery_ledger_record_policy_skips(). That function
--    never replaces a row that records a read or a fetch (routed, unrouted,
--    id_collision, policy_excluded_after_fetch) with a policy skip that never
--    fetched anything. It also takes the page's thread taints (section 4) and
--    inserts them in the same transaction, so a taint and its skip commit together.
-- 3. audit_log_action_check restated in full from
--    20261002181000_discovery_google_connect.sql (develop's latest list), plus
--    discovery.exclusion_policy_changed.
-- 4. discovery_thread_taints: which threads a thread-scoped rule has excluded,
--    kept apart from any message's ledger reason, so a later refresh of a ledger
--    row (a reordered policy, an expired cursor's re-backfill) never erases it.
--    Insert-only: the first provenance of a (source, thread, rule) wins.
--
-- tenant_id has no foreign key: there is no tenants table in this schema (every
-- tenant_id column is a bare uuid, resolved through the registration).

-- ── 1. Policy versions ──────────────────────────────────────────────────────
create table if not exists discovery_exclusion_policies (
  tenant_id     uuid not null,
  version       integer not null check (version >= 1),
  rules         jsonb not null check (jsonb_typeof(rules) = 'array'),
  rules_sha256  text not null check (rules_sha256 ~ '^[0-9a-f]{64}$'),
  -- Who at the bank asked for the change. Never a Conductia secret.
  requested_by  text not null check (btrim(requested_by) <> ''),
  created_at    timestamptz not null default now(),
  primary key (tenant_id, version)
);

-- A version is never edited or removed: the next one supersedes it.
create or replace function discovery_exclusion_policies_append_only()
returns trigger language plpgsql set search_path = public as $$
begin
  -- P0001, like audit_log_immutable and the other immutability triggers.
  raise exception 'discovery_exclusion_policies rows are append-only' using errcode = 'P0001';
end;
$$;
revoke all on function discovery_exclusion_policies_append_only() from public, anon, authenticated;
drop trigger if exists discovery_exclusion_policies_append_only on discovery_exclusion_policies;
create trigger discovery_exclusion_policies_append_only before update or delete on discovery_exclusion_policies
  for each row execute function discovery_exclusion_policies_append_only();

-- The one audit writer for policy changes. It runs for every writer, so a
-- version can never exist without its audit row. The detail names the rules by
-- id and carries a hash of them: the table is the history, the audit row says
-- who asked and what changed.
create or replace function discovery_exclusion_policies_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (tenant_id, actor_id, actor_type, service_identity, action, detail)
  values (
    new.tenant_id,
    null,
    'service',
    'exclusion-policy',
    'discovery.exclusion_policy_changed',
    jsonb_build_object(
      'version', new.version,
      'previousVersion', (select max(p.version) from discovery_exclusion_policies p
                           where p.tenant_id = new.tenant_id and p.version < new.version),
      'ruleIds', (select coalesce(jsonb_agg(r ->> 'id'), '[]'::jsonb) from jsonb_array_elements(new.rules) r),
      'rulesSha256', new.rules_sha256,
      'requestedBy', new.requested_by
    )
  );
  return null;
end;
$$;
revoke all on function discovery_exclusion_policies_audit() from public, anon, authenticated;
drop trigger if exists discovery_exclusion_policies_audit on discovery_exclusion_policies;
create trigger discovery_exclusion_policies_audit after insert on discovery_exclusion_policies
  for each row execute function discovery_exclusion_policies_audit();

alter table discovery_exclusion_policies enable row level security;
-- No browser policy. Supabase's default privileges give service_role ALL on new
-- tables and a narrower grant does not take a privilege away, so revoke
-- everything first (#262 C10-2). service_role reads the current version; it
-- writes only through discovery_exclusion_policy_set().
revoke all on discovery_exclusion_policies from public, anon, authenticated, service_role;
grant select on discovery_exclusion_policies to service_role;

-- The operator's writer. p_expected_version is the version the operator saw
-- (0 for none): a concurrent change makes it stale. A rule id names one
-- condition forever: the condition is the rule minus id, scope and category, and
-- a changed condition needs a new id, so a persisted thread taint (Phase 3) is
-- only ever inherited by the condition that produced it. Scope and category may
-- change under the same id: narrowing a rule to message scope is meant to stop
-- its old taints. Returns the new version.
create or replace function discovery_exclusion_policy_set(
  p_tenant_id uuid,
  p_rules jsonb,
  p_expected_version integer,
  p_requested_by text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current integer;
  v_next    integer;
begin
  if p_tenant_id is null then
    raise exception 'discovery_exclusion_policy_set: tenant required' using errcode = '22023';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception 'discovery_exclusion_policy_set: rules must be a json array' using errcode = '22023';
  end if;
  if p_requested_by is null or btrim(p_requested_by) = '' then
    raise exception 'discovery_exclusion_policy_set: requested_by required' using errcode = '22023';
  end if;
  -- Every rule is an object with a text id, and ids are unique in a version.
  if exists (
       select 1 from jsonb_array_elements(p_rules) r
        where jsonb_typeof(r) <> 'object' or jsonb_typeof(r -> 'id') is distinct from 'string' or btrim(r ->> 'id') = ''
     )
     or (select count(*) <> count(distinct r ->> 'id') from jsonb_array_elements(p_rules) r) then
    raise exception 'discovery_exclusion_policy_set: every rule needs a unique id' using errcode = '22023';
  end if;

  -- One writer per tenant at a time, so two operators cannot both pass the stale check.
  perform pg_advisory_xact_lock(hashtextextended('discovery_exclusion_policy:' || p_tenant_id::text, 0));

  select coalesce(max(version), 0) into v_current from discovery_exclusion_policies where tenant_id = p_tenant_id;
  if p_expected_version is distinct from v_current then raise exception 'stale_version'; end if;

  if exists (
    select 1
      from jsonb_array_elements(p_rules) n
      join discovery_exclusion_policies p on p.tenant_id = p_tenant_id
      cross join lateral jsonb_array_elements(p.rules) o
     where o ->> 'id' = n ->> 'id'
       and (n - 'id' - 'scope' - 'category') is distinct from (o - 'id' - 'scope' - 'category')
  ) then
    raise exception 'rule_condition_changed';
  end if;

  v_next := v_current + 1;
  insert into discovery_exclusion_policies (tenant_id, version, rules, rules_sha256, requested_by)
  values (p_tenant_id, v_next, p_rules, encode(sha256(convert_to(p_rules::text, 'UTF8')), 'hex'), btrim(p_requested_by));
  return v_next;
end;
$$;
revoke all on function discovery_exclusion_policy_set(uuid, jsonb, integer, text) from public, anon, authenticated;
grant execute on function discovery_exclusion_policy_set(uuid, jsonb, integer, text) to service_role;

-- ── 2. The ledger ───────────────────────────────────────────────────────────
-- provider_thread_id is the provider's thread id (Gmail's threadId, per mailbox,
-- so always read with source_id): metadata, never content. policy_version and
-- exclusion_rule are set on a policy skip only.
alter table routing_ledger
  add column if not exists provider_thread_id text,
  add column if not exists policy_version integer,
  add column if not exists exclusion_rule text;

alter table routing_ledger drop constraint if exists routing_ledger_skip_reason_check;
alter table routing_ledger add constraint routing_ledger_skip_reason_check
  check (skip_reason in ('image_only', 'unsupported_type', 'too_large', 'extraction_failed', 'extraction_timeout',
    'id_collision', 'policy_excluded', 'policy_thread_excluded', 'policy_unevaluable', 'policy_excluded_after_fetch'));

-- A policy skip always carries its version, its rule and a non-empty thread id
-- (the cross-pass taint key), and nothing else carries all three.
alter table routing_ledger drop constraint if exists routing_ledger_policy_shape_check;
alter table routing_ledger add constraint routing_ledger_policy_shape_check
  check (
    coalesce(skip_reason in ('policy_excluded', 'policy_thread_excluded', 'policy_unevaluable', 'policy_excluded_after_fetch'), false)
      = (policy_version is not null and exclusion_rule is not null and coalesce(provider_thread_id, '') <> '')
  );

create index if not exists routing_ledger_policy_thread_idx on routing_ledger (source_id, provider_thread_id)
  where skip_reason in ('policy_excluded', 'policy_thread_excluded', 'policy_unevaluable', 'policy_excluded_after_fetch');

-- Writes the policy skips of a page. Fetched provenance is immutable: a row that
-- records a read or a fetch (routed, unrouted, id_collision,
-- policy_excluded_after_fetch) is never replaced by a skip that never fetched
-- anything, which would otherwise hide that its text is held (an expired delta
-- cursor re-backfills the whole mailbox under whatever policy is current). Only
-- an earlier never-fetched policy skip is refreshed, with the current version
-- and rule. Returns the number of rows written or refreshed.
--
-- The page's thread taints (section 4) come in the same call and are inserted
-- first, in the same transaction: a taint and the policy skip that carried it
-- commit together or not at all, before the worker advances the checkpoint.
-- Insert-only, as the table's own rules require: the first provenance of a
-- (source, thread, rule) wins.
create or replace function discovery_ledger_record_policy_skips(p_rows jsonb, p_taints jsonb default '[]'::jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'discovery_ledger_record_policy_skips: rows must be a json array' using errcode = '22023';
  end if;
  if p_taints is null or jsonb_typeof(p_taints) <> 'array' then
    raise exception 'discovery_ledger_record_policy_skips: taints must be a json array' using errcode = '22023';
  end if;
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
  select (t ->> 'source_id')::uuid, t ->> 'provider_thread_id', t ->> 'rule_id', (t ->> 'policy_version')::integer,
         t ->> 'provider_item_id', (t ->> 'run_id')::uuid
    from jsonb_array_elements(p_taints) t
  on conflict (source_id, provider_thread_id, rule_id) do nothing;
  insert into routing_ledger
    (source_id, provider_item_id, item_hash, decision, skip_reason, provider_thread_id, policy_version, exclusion_rule, run_id)
  select (r ->> 'source_id')::uuid, r ->> 'provider_item_id', r ->> 'item_hash', 'skipped', r ->> 'skip_reason',
         r ->> 'provider_thread_id', (r ->> 'policy_version')::integer, r ->> 'exclusion_rule', (r ->> 'run_id')::uuid
    from jsonb_array_elements(p_rows) r
  on conflict (source_id, provider_item_id) do update set
    item_hash = excluded.item_hash,
    skip_reason = excluded.skip_reason,
    provider_thread_id = excluded.provider_thread_id,
    policy_version = excluded.policy_version,
    exclusion_rule = excluded.exclusion_rule,
    run_id = excluded.run_id
  where routing_ledger.skip_reason in ('policy_excluded', 'policy_thread_excluded', 'policy_unevaluable');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function discovery_ledger_record_policy_skips(jsonb, jsonb) from public, anon, authenticated;
grant execute on function discovery_ledger_record_policy_skips(jsonb, jsonb) to service_role;

-- ── 3. One new audit action ────────────────────────────────────────────────
-- The CHECK restates the latest list (20261002181000_discovery_google_connect.sql)
-- plus that one value.
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
  'discovery.mailbox_access_changed', 'discovery.exclusion_policy_changed'
])) not valid;

-- ── 4. Thread taints ────────────────────────────────────────────────────────
-- A thread-scoped rule that matched on any message of
-- a conversation taints it: a reply that arrives in a later pass is excluded
-- without a fetch, even when the message that matched has since lost its label or
-- its ledger row was refreshed under a reordered policy. A taint is not derived
-- from a ledger reason, which keeps one reason per message and may be refreshed.
-- The reader emits a taint for every thread-scoped match, in any rule order; the
-- worker writes it with the page it came from, and reads the current version's
-- thread-scoped rules back before each source's reader is built.
--
-- provider_thread_id is per mailbox (the provider's own thread id), so a taint is
-- always read with source_id. A taint therefore belongs to its source and does not
-- carry over to a re-created one (a new source id starts with none; its next
-- backfill judges every conversation afresh under the current policy). Only a
-- real match is a taint: a rule that could not be evaluated excludes its message
-- but is never written here (an unverified field would otherwise taint for good). The first provenance wins: the table is written
-- only by insert … on conflict do nothing, and an update is refused. A row goes
-- when its source does (on delete cascade): that is not an update.
create table if not exists discovery_thread_taints (
  source_id          uuid not null references content_sources (id) on delete cascade,
  provider_thread_id text not null check (provider_thread_id <> ''),
  rule_id            text not null check (rule_id <> ''),
  -- The version that first carried the match, and the message that carried it.
  policy_version     integer not null check (policy_version >= 1),
  provider_item_id   text not null check (provider_item_id <> ''),
  run_id             uuid not null,
  recorded_at        timestamptz not null default now(),
  primary key (source_id, provider_thread_id, rule_id)
);

create or replace function discovery_thread_taints_append_only()
returns trigger language plpgsql set search_path = public as $$
begin
  -- P0001, like the other immutability triggers.
  raise exception 'thread taints are append-only' using errcode = 'P0001';
end;
$$;
revoke all on function discovery_thread_taints_append_only() from public, anon, authenticated;
drop trigger if exists discovery_thread_taints_append_only on discovery_thread_taints;
create trigger discovery_thread_taints_append_only before update on discovery_thread_taints
  for each row execute function discovery_thread_taints_append_only();

alter table discovery_thread_taints enable row level security;
-- No browser policy. Supabase's default privileges give service_role ALL on new
-- tables, so revoke everything first (#262 C10-2): the worker reads taints and
-- inserts them, and nothing else.
revoke all on discovery_thread_taints from public, anon, authenticated, service_role;
grant select, insert on discovery_thread_taints to service_role;
