-- supabase/migrations/20261019130000_team_mailbox_check.sql
-- Admin-managed team inbox (#581), phase 5: the worker's address check, in the database.
--
-- Before a team source is read, the worker asks the Google Directory whether the address is
-- a real user mailbox (an alias, a group, a suspended account and a missing one are not),
-- and writes the answer here. Two service-role functions, called from readOneSource:
--   1. discovery_team_mailbox_check_due(p_source_id)
--        Whether the check is due, on the database's clock, and what to verify when it is.
--   2. discovery_record_team_mailbox_check(p_id, p_status, p_reason, p_directory_user_id)
--        Writes the outcome to the registration and audits a change of status or reason.
--
-- Nothing here lets anything be read. The unchanged guard still refuses a team source (the
-- team branch of the guard, and the freshness window that reads verified_at, follow in a
-- later phase). This migration only keeps the registry's check columns up to date.
--
-- Audit rows about a team source carry ids and fixed codes only: the row written here is
-- discovery.team_mailbox_checked {teamMailboxId, status[, reason]}. The address is never in it.

-- ── 1. When a check is due ─────────────────────────────────────────────────
-- A registration is due when
--   - it was never checked (checked_at is null), or
--   - it is verified and its last success is 15 minutes old: a verified row is renewed at
--     the start of a pass well inside the 65 minutes a read may rely on it, or
--   - it is not verified (pending or refused) and its last attempt is 4 minutes old: those
--     rows retry on every tick. The tick is every 5 minutes and a check lands a few seconds
--     into its tick, so a test of "5 minutes old" would skip the next tick and retry only
--     every second one; 4 keeps "every tick" true.
-- A verified row whose last attempt failed transiently keeps its old verified_at, so it is due
-- again on the next tick until a check succeeds or the read window closes.
-- A source with no open registration (not a team source, or its registration was closed)
-- is never due; the guard refuses it.
create or replace function discovery_team_mailbox_check_due(p_source_id uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select jsonb_build_object(
              'due', coalesce(
                       tm.checked_at is null
                       or (tm.check_status = 'verified' and tm.verified_at < now() - interval '15 minutes')
                       or (tm.check_status <> 'verified' and tm.checked_at < now() - interval '4 minutes'),
                       false),
              'teamMailboxId', tm.id,
              'address', tm.address,
              'pinnedId', tm.directory_user_id)
     from content_sources cs
     join team_mailboxes tm on tm.id = cs.team_mailbox_id and tm.disconnected_at is null
     where cs.id = p_source_id),
    jsonb_build_object('due', false, 'teamMailboxId', null, 'address', null, 'pinnedId', null));
$$;
revoke all on function discovery_team_mailbox_check_due(uuid) from public, anon, authenticated;
grant execute on function discovery_team_mailbox_check_due(uuid) to service_role;

-- ── 2. Record the outcome ──────────────────────────────────────────────────
-- p_status is the verifier's word for what it learned:
--   verified  the address is an active user mailbox. p_directory_user_id (the Directory's
--             id, never an address) is pinned on the first success and kept after it.
--   refused   a definitive no. p_reason is one of the registry's check reasons; the pinned
--             id is kept, so an address handed to someone else is still caught later.
--   error     Google could not say (down, throttled, a timeout, a token that did not mint).
--             p_reason is 'directory_error'. Only checked_at and last_check_error* move:
--             the status, the reason and verified_at stay, so one blip never flips Ready
--             to Refused.
-- checked_at is written on every outcome. A verified or refused answer clears
-- last_check_error and last_check_error_at together (they are a pair); an error sets both.
-- An answer for another Directory id than the pinned one is recorded as refused
-- (identity_changed) even if the caller said verified: the pin is enforced here as well.
-- A registration that has been closed (Remove, a disconnect) records nothing: the answer of a
-- check that raced the close is dropped, and the function says so.
-- Refusals, each with nothing written: 22023 for an arguments pair that cannot be a check.
create or replace function discovery_record_team_mailbox_check(
  p_id                uuid,
  p_status            text,
  p_reason            text default null,
  p_directory_user_id text default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tm         team_mailboxes%rowtype;
  v_status     text := p_status;
  v_reason     text := p_reason;
  v_new_status text;
  v_new_reason text;
  v_changed    boolean;
begin
  if p_id is null or p_status is null or p_status not in ('verified', 'refused', 'error') then
    raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
  end if;
  if p_status = 'verified' then
    -- A Directory id is an opaque token. It is never an address, so one with an '@' is refused.
    if p_reason is not null or p_directory_user_id is null
       or length(p_directory_user_id) not between 1 and 128 or p_directory_user_id ~ '[@\s]' then
      raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
    end if;
  elsif p_status = 'refused' then
    if p_reason is null
       or p_reason not in ('group', 'alias', 'suspended', 'no_mailbox', 'not_found', 'identity_changed', 'directory_denied')
       or p_directory_user_id is not null then
      raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
    end if;
  else
    if p_reason is distinct from 'directory_error' or p_directory_user_id is not null then
      raise exception 'discovery_record_team_mailbox_check: bad arguments' using errcode = '22023';
    end if;
  end if;

  -- The registration's row lock orders this against Remove (which takes the same row after
  -- its advisory lock) and against another worker's record: whichever comes second sees
  -- the first's result.
  select * into v_tm from team_mailboxes where id = p_id for update;
  if not found or v_tm.disconnected_at is not null then
    return jsonb_build_object('recorded', false);
  end if;

  if v_status = 'verified' and v_tm.directory_user_id is not null
     and v_tm.directory_user_id <> p_directory_user_id then
    v_status := 'refused';
    v_reason := 'identity_changed';
  end if;

  if v_status = 'verified' then
    update team_mailboxes
       set check_status = 'verified', check_reason = null, checked_at = now(), verified_at = now(),
           directory_user_id = coalesce(directory_user_id, p_directory_user_id),
           last_check_error = null, last_check_error_at = null
     where id = v_tm.id
    returning check_status, check_reason into v_new_status, v_new_reason;
  elsif v_status = 'refused' then
    update team_mailboxes
       set check_status = 'refused', check_reason = v_reason, checked_at = now(),
           last_check_error = null, last_check_error_at = null
     where id = v_tm.id
    returning check_status, check_reason into v_new_status, v_new_reason;
  else
    update team_mailboxes
       set checked_at = now(), last_check_error = 'directory_error', last_check_error_at = now()
     where id = v_tm.id
    returning check_status, check_reason into v_new_status, v_new_reason;
  end if;

  -- A status or reason change is news; a repeat of the same answer is not. A transient
  -- error never changes either, so it is never audited here (it is on the row).
  v_changed := (v_tm.check_status, v_tm.check_reason) is distinct from (v_new_status, v_new_reason);
  if v_changed then
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (v_tm.tenant_id, 'service', 'discovery-worker', 'discovery.team_mailbox_checked',
            jsonb_build_object('teamMailboxId', v_tm.id, 'status', v_new_status)
            || case when v_new_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_new_reason) end);
  end if;

  return jsonb_build_object('recorded', true, 'changed', v_changed, 'status', v_new_status, 'reason', v_new_reason);
end;
$$;
revoke all on function discovery_record_team_mailbox_check(uuid, text, text, text) from public, anon, authenticated;
grant execute on function discovery_record_team_mailbox_check(uuid, text, text, text) to service_role;
