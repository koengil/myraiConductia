-- supabase/migrations/20260925100000_audit_hash_chain.sql
-- Per-tenant hash chain on audit_log, and a `model` actor type (Q13, D62).
--
-- Every row inserted from here on is chained within its tenant:
--
--   hash = sha256(coalesce(prev_hash, '') || convert_to(audit_canonical_row(row), 'UTF8'))
--
-- where prev_hash is the hash of the tenant's previous row and chain_seq counts
-- from 1 (the genesis row, prev_hash null). A BEFORE INSERT trigger computes
-- all of it, so no writer changes: the trigger resolves the tenant itself
-- (NEW.tenant_id, then the deal's tenant, then the actor's tenant, then the
-- reserved nil-UUID system tenant). Rows written before this migration stay
-- unchained (chain_seq null).
--
-- Tenant rule. With a deal_id, a supplied tenant_id must equal the deal's
-- tenant; the deal wins over the actor, whose tenant is not checked. With no
-- deal_id and an actor_id, a supplied tenant_id must equal the actor's
-- users.tenant_id. With neither (service and model rows), an explicit
-- tenant_id is accepted. A mismatch raises check_violation.
--
-- Actor rule. actor_type 'user' carries an actor_id. 'service' and 'model'
-- rows carry no actor_id and name their service_identity; a requester a
-- service acts for goes in detail (D57). A 'model' row always speaks through
-- the model gateway. Pre-migration rows (actor_type null) are exempt.
--
-- Concurrency. The trigger takes a per-tenant transaction advisory lock before
-- it reads the tenant's last row, so concurrent inserts serialize per tenant
-- and cannot fork the chain. That relies on READ COMMITTED taking a fresh
-- snapshot per statement (Supabase's default). A writer running REPEATABLE
-- READ could read a stale tail; the partial unique index on
-- (tenant_id, chain_seq) makes that fail loudly instead of forking silently.
-- The lock is held until the writer's transaction ends.
--
-- Trigger order. BEFORE INSERT triggers fire in name order, and the hash
-- covers NEW as the chain trigger sees it. zz_audit_log_chain_append must stay
-- the last BEFORE INSERT trigger on audit_log by name: any later trigger that
-- changes NEW must sort before it.
--
-- Format versions. The canonical row begins with a format tag
-- (`audit_log/v1`); rows store no format tag. A row verifies when its stored
-- hash matches under any known version; the verifier tries every version. The
-- canonical form is ported to TypeScript in src/lib/audit/chain.ts, and
-- scripts/verify-audit-chain.ts recomputes every tenant's chain from it. A
-- change to audit_canonical_row adds a new version to the verifier's map and
-- never removes an old one.
--
-- Limits. A table owner who disables the triggers can rewrite any suffix of a
-- tenant's chain, including truncating the tail or rebuilding it entirely,
-- and it still verifies. Detecting that needs an external per-tenant
-- latest-hash anchor, which is an open decision. service_role can only
-- append.
--
-- The trigger function takes the table name as TG_ARGV[0], so a later table
-- (compliance_events, Q22) reuses it with its own audit_canonical_row overload
-- and its own per-tenant chain.

-- 1. Columns. All nullable: pre-migration rows carry none of them.
alter table audit_log add column if not exists tenant_id  uuid;
alter table audit_log add column if not exists actor_type text;
alter table audit_log add column if not exists chain_seq  bigint;
alter table audit_log add column if not exists prev_hash  bytea;
alter table audit_log add column if not exists hash       bytea;

-- 2. Actor type. A model is a distinct actor, and it always speaks through the
--    model gateway.
alter table audit_log drop constraint if exists audit_log_actor_type_check;
alter table audit_log add constraint audit_log_actor_type_check
  check (actor_type in ('user', 'service', 'model'));

alter table audit_log drop constraint if exists audit_log_model_actor_check;
alter table audit_log add constraint audit_log_model_actor_check
  check (actor_type is distinct from 'model' or service_identity = 'model-gateway');

-- actor_type agrees with the actor columns: a user row names its user; a
-- service or model row names no user, only its service identity. A requester
-- a service acts for goes in detail (D57). Pre-migration rows (actor_type
-- null) are exempt.
alter table audit_log drop constraint if exists audit_log_actor_type_shape_check;
alter table audit_log add constraint audit_log_actor_type_shape_check
  check (
    actor_type is null
    or (actor_type = 'user' and actor_id is not null)
    or (actor_type in ('service', 'model') and actor_id is null and service_identity is not null)
  );

-- A chained row is complete, and only the genesis row lacks a prev_hash.
-- Pre-migration rows (chain_seq null) are exempt.
alter table audit_log drop constraint if exists audit_log_chain_shape_check;
alter table audit_log add constraint audit_log_chain_shape_check
  check (
    chain_seq is null
    or (
      tenant_id is not null and actor_type is not null and hash is not null and chain_seq > 0
      and ((chain_seq = 1) = (prev_hash is null))
    )
  );

-- 3. Fork backstop, and the index the trigger's tail read uses.
create unique index if not exists audit_log_tenant_chain_seq_key
  on audit_log (tenant_id, chain_seq) where chain_seq is not null;

-- 4. Action enum: the full list from 20260921110000 (the latest migration to
--    rebuild it before this one) plus the discovery actions. This rebuild
--    replaces the constraint, so any action it leaves out is dropped for
--    every later write; tests/audit-action-check-history.test.ts fails if
--    the latest CHECK loses an action an earlier one allowed.
--    `not valid` for the same replay reason as 20260916140000: new rows are
--    still checked.
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
  'discovery.milestone_extracted', 'discovery.stage_assessed'
])) not valid;

-- 5. Canonical form of one row: a JSON array rendered by jsonb, so string
--    escaping is Postgres's escape_json and the separators are fixed (", ").
--    Every element is text or null:
--      [format tag, id, tenant_id, chain_seq, ts as UTC with microseconds,
--       actor_type, actor_id, service_identity, action, deal_id, document_id,
--       detail rendered as jsonb text]
--    detail is embedded as its jsonb text, not re-serialized, so numbers keep
--    exactly the digits jsonb stores. prev_hash and hash are not part of it:
--    prev_hash is prepended to the hash input, hash is the output.
create or replace function audit_canonical_row(r audit_log)
returns text
language sql
stable
set search_path = public
as $$
  select jsonb_build_array(
    'audit_log/v1',
    r.id::text,
    r.tenant_id::text,
    r.chain_seq::text,
    to_char(r.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.actor_type,
    r.actor_id::text,
    r.service_identity,
    r.action,
    r.deal_id::text,
    r.document_id::text,
    r.detail::text
  )::text;
$$;

-- Pure, but no client role needs it: the trigger calls it as the owner.
revoke all on function audit_canonical_row(audit_log) from public;
revoke all on function audit_canonical_row(audit_log) from anon, authenticated;

-- 6. The chain trigger. security definer so the tail read sees every row of
--    the tenant regardless of the writer's RLS (the table owner bypasses RLS).
create or replace function audit_chain_append()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table        text := tg_argv[0];
  v_deal_tenant  uuid;
  v_actor_tenant uuid;
  v_last_seq     bigint;
  v_last_hash    bytea;
begin
  if v_table is null or v_table <> tg_table_name then
    raise exception 'audit_chain_append: trigger argument % does not name table %', v_table, tg_table_name
      using errcode = '22023';
  end if;

  if v_table = 'audit_log' then
    -- Discovery writers always know their tenant; a missing one is a bug.
    if new.tenant_id is null and new.action like 'discovery.%' then
      raise exception 'audit_log: % requires tenant_id', new.action
        using errcode = '23502';
    end if;

    if new.deal_id is not null then
      select d.tenant_id into v_deal_tenant from deals d where d.id = new.deal_id;
    end if;

    -- The actor's tenant matters only when no deal names one.
    if new.actor_id is not null and v_deal_tenant is null then
      select u.tenant_id into v_actor_tenant from users u where u.id = new.actor_id;
    end if;

    -- A supplied tenant_id must agree with the deal, or with the actor when
    -- there is no deal. The deal wins over the actor, whose tenant is not
    -- checked then: a user acting on another tenant's deal writes to the
    -- deal's chain. With neither (service and model rows) an explicit
    -- tenant_id stands.
    if new.tenant_id is not null then
      if new.deal_id is not null then
        if v_deal_tenant is not null and v_deal_tenant <> new.tenant_id then
          raise exception 'audit_log: tenant_id % does not match the tenant of deal %', new.tenant_id, new.deal_id
            using errcode = '23514';
        end if;
      elsif new.actor_id is not null and v_actor_tenant is distinct from new.tenant_id then
        raise exception 'audit_log: tenant_id % does not match the tenant of actor %', new.tenant_id, new.actor_id
          using errcode = '23514';
      end if;
    end if;

    -- Unresolvable (e.g. a service row with neither actor nor deal): the
    -- reserved system tenant.
    new.tenant_id := coalesce(
      new.tenant_id, v_deal_tenant, v_actor_tenant, '00000000-0000-0000-0000-000000000000'::uuid
    );

    if new.actor_type is null then
      new.actor_type := case when new.actor_id is not null then 'user' else 'service' end;
    end if;
  end if;

  if new.tenant_id is null then
    raise exception '%: tenant_id is required on a chained row', v_table
      using errcode = '23502';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_table || ':' || new.tenant_id::text, 0));

  execute format(
    'select chain_seq, hash from %I where tenant_id = $1 and chain_seq is not null
      order by chain_seq desc limit 1',
    v_table
  ) into v_last_seq, v_last_hash using new.tenant_id;

  -- Whatever the writer supplied, the chain fields are the trigger's.
  new.chain_seq := coalesce(v_last_seq, 0) + 1;
  new.prev_hash := v_last_hash;
  new.hash := sha256(coalesce(new.prev_hash, ''::bytea) || convert_to(audit_canonical_row(new), 'UTF8'));
  return new;
end;
$$;

revoke all on function audit_chain_append() from public;
revoke all on function audit_chain_append() from anon, authenticated;

-- BEFORE INSERT triggers fire in name order, and the hash covers NEW as this
-- trigger sees it. It must stay the last BEFORE INSERT trigger on audit_log by
-- name: any later trigger that changes NEW must sort before it. The first
-- name it shipped under is dropped so a re-run leaves exactly one.
drop trigger if exists audit_log_chain_append on audit_log;
drop trigger if exists zz_audit_log_chain_append on audit_log;
create trigger zz_audit_log_chain_append
  before insert on audit_log
  for each row execute function audit_chain_append('audit_log');
