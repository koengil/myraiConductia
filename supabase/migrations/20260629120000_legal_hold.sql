-- supabase/migrations/20260629120000_legal_hold.sql
-- S0.4 (Issue #50, Epic #46): per-deal legal hold / freeze. A deal under hold cannot
-- have its record purged (deal/document deletes blocked); place/lift are audited.
-- Idempotent: safe to re-run. Sibling of #49 (audit_log append-only).

-- 1. Widen the audit action enum to include hold events (required by the AC).
-- REPLAY NOTE: later migrations widen this CHECK further and a lived-in
-- database already holds rows with those actions, so on re-run this re-add
-- must not validate existing rows (`not valid`) — the newest widening
-- migration re-adds the full, validated constraint.
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check
  check (action in ('view','download','upload','export','grant','revoke','hold_placed','hold_lifted',
    'invite_domain_override','invite_challenge_issued','invite_challenge_rotated','invite_verification_succeeded','invite_verification_locked','mfa_enrolled','mfa_challenged'
  ))
  not valid;

-- 2. The hold state table. Active hold = lifted_at IS NULL.
create table if not exists legal_holds (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references deals (id),
  reason      text not null,
  placed_by   uuid not null references users (id),
  placed_at   timestamptz not null default now(),
  lifted_by   uuid references users (id),
  lifted_at   timestamptz
);

create unique index if not exists legal_holds_one_active_per_deal
  on legal_holds (deal_id) where lifted_at is null;
-- No separate (deal_id) index: the partial unique index above already serves
-- deal_is_under_hold (its lookup filters lifted_at IS NULL). (review nit, Martin)

-- Append/lift-only: service_role may read, insert, update. NO delete,
-- so the freeze history cannot be erased.
grant select, insert, update on legal_holds to service_role;

-- 3. Helper: is this deal under an active hold?
create or replace function deal_is_under_hold(p_deal_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from legal_holds where deal_id = p_deal_id and lifted_at is null
  );
$$;

-- 4. Row guard: block deleting a held deal (this also stops the cascade to documents).
create or replace function block_deal_delete_under_hold()
returns trigger language plpgsql as $$
begin
  if deal_is_under_hold(old.id) then
    raise exception 'deal % is under legal hold (S0.4): delete is not permitted', old.id
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists deals_no_delete_under_hold on deals;
create trigger deals_no_delete_under_hold
  before delete on deals
  for each row execute function block_deal_delete_under_hold();

-- 5. Row guard: block deleting a document whose deal is held (direct deletes).
create or replace function block_document_delete_under_hold()
returns trigger language plpgsql as $$
begin
  if deal_is_under_hold(old.deal_id) then
    raise exception 'document % belongs to a deal under legal hold (S0.4): delete is not permitted', old.id
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists documents_no_delete_under_hold on documents;
create trigger documents_no_delete_under_hold
  before delete on documents
  for each row execute function block_document_delete_under_hold();

-- 6. Statement guard: TRUNCATE bypasses row triggers; block it on deals/documents
-- whenever ANY active hold exists.
create or replace function block_truncate_when_any_hold()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from legal_holds where lifted_at is null) then
    raise exception 'truncate blocked: a deal is under legal hold (S0.4)'
      using errcode = 'P0001';
  end if;
  return null;
end;
$$;

drop trigger if exists deals_no_truncate_under_hold on deals;
create trigger deals_no_truncate_under_hold
  before truncate on deals
  for each statement execute function block_truncate_when_any_hold();

drop trigger if exists documents_no_truncate_under_hold on documents;
create trigger documents_no_truncate_under_hold
  before truncate on documents
  for each statement execute function block_truncate_when_any_hold();

-- 7. Place a hold: insert the row AND write the audit event.
create or replace function place_legal_hold(p_deal_id uuid, p_actor uuid, p_reason text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  insert into legal_holds (deal_id, reason, placed_by)
    values (p_deal_id, p_reason, p_actor)
    returning id into v_id;
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor, 'hold_placed', p_deal_id,
            jsonb_build_object('reason', p_reason, 'hold_id', v_id));
  return v_id;
end;
$$;

-- 8. Lift the active hold: stamp lifted_*, AND write the audit event.
create or replace function lift_legal_hold(p_deal_id uuid, p_actor uuid)
returns void language plpgsql as $$
declare v_id uuid;
begin
  update legal_holds set lifted_by = p_actor, lifted_at = now()
    where deal_id = p_deal_id and lifted_at is null
    returning id into v_id;
  if v_id is null then
    raise exception 'no active legal hold on deal % to lift (S0.4)', p_deal_id
      using errcode = 'P0001';
  end if;
  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor, 'hold_lifted', p_deal_id, jsonb_build_object('hold_id', v_id));
end;
$$;
