-- Sending mailbox storage for two providers
-- (20261017120000_mailbox_connections_google.sql, #490 slice S1a):
--
--   - provider is microsoft or google, nothing else
--   - status is connected or revoked, and defaults to connected
--   - a connected row holds tokens, a revoked row holds none
--   - a Google row names its account (account_sub); a Microsoft row need not
--   - the revoke shape (status revoked, tokens null, revoked_at set) is accepted
--   - the Microsoft callback's upsert over a revoked Google row is accepted with
--     every Google-only column reset (R20), and the pre-R20 payload, which
--     left status alone, is refused by the status/token CHECK
--   - audit_log accepts mailbox.connected, mailbox.disconnected,
--     mailbox.approval_ended and mailbox.connect_refused, still accepts the
--     purge and retention actions of the list it restates, and still refuses an
--     unknown action
--   - mailbox_sending_connect_google replaces the user's row with a new id and
--     audits; mailbox_sending_mark_revoked marks only the row holding the blob
--     the send read and audits only then; mailbox_sending_disconnect deletes
--     and audits a Google row only
--   - when the audit insert fails, each of the three leaves the connection as
--     it was (one transaction)
--   - only service_role may execute them
--   - mailbox_sending_connect_google refuses an external user, or no user,
--     with not_eligible (42501), storing and auditing nothing
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/mailbox_connections_google.sql
-- Everything rolls back.

begin;

-- One insert in its own subtransaction: 'ok' (and the row removed again), or
-- the name of the CHECK that refused it.
create function pg_temp.try_insert(
  p_user uuid, p_provider text, p_tokens text, p_status text, p_sub text
) returns text language plpgsql as $$
declare
  v_constraint text;
begin
  insert into mailbox_connections (user_id, provider, email, tokens_encrypted, status, account_sub)
  values (p_user, p_provider, 'zz-mailbox-test@example.test', p_tokens, p_status, p_sub);
  delete from mailbox_connections where user_id = p_user;
  return 'ok';
exception when check_violation then
  get stacked diagnostics v_constraint = constraint_name;
  return coalesce(v_constraint, 'check_violation');
end;
$$;

create function pg_temp.expect_text(actual text, expected text, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, coalesce(expected, '<null>'), coalesce(actual, '<null>');
  end if;
end;
$$;

do $$
declare
  v_user     uuid := gen_random_uuid();
  v_switcher uuid := gen_random_uuid();
  v_row      mailbox_connections%rowtype;
  v_def      text;
  v_refused  text;
begin
  -- Throwaway actors: the auth trigger mirrors each into public.users, which
  -- mailbox_connections.user_id references.
  insert into auth.users (id, email) values
    (v_user, 'zz-mailbox-google-a@example.test'),
    (v_switcher, 'zz-mailbox-google-b@example.test');

  -- ── Provider ──────────────────────────────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'microsoft', 'blob', 'connected', null),
    'ok', 'a connected Microsoft row');
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'google', 'blob', 'connected', 'sub-1'),
    'ok', 'a connected Google row with its account');
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'yahoo', 'blob', 'connected', 'sub-1'),
    'mailbox_connections_provider_check', 'an unknown provider');

  -- ── Status and tokens ─────────────────────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'google', null, 'revoked', 'sub-1'),
    'ok', 'a revoked Google row without tokens');
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'google', 'blob', 'revoked', 'sub-1'),
    'mailbox_connections_status_tokens_check', 'a revoked row that keeps tokens');
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'microsoft', null, 'connected', null),
    'mailbox_connections_status_tokens_check', 'a connected row without tokens');
  -- Without tokens, so the status/token CHECK holds and only the status CHECK can refuse it.
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'google', null, 'paused', 'sub-1'),
    'mailbox_connections_status_check', 'an unknown status');

  -- ── Google account ────────────────────────────────────────────────────────
  perform pg_temp.expect_text(pg_temp.try_insert(v_user, 'google', 'blob', 'connected', null),
    'mailbox_connections_google_sub_check', 'a Google row without account_sub');

  -- The default status is connected (an existing Microsoft writer that names no status).
  insert into mailbox_connections (user_id, provider, email, tokens_encrypted)
  values (v_user, 'microsoft', 'zz-mailbox-test@example.test', 'blob');
  select * into v_row from mailbox_connections where user_id = v_user;
  perform pg_temp.expect_text(v_row.status, 'connected', 'status defaults to connected');
  perform pg_temp.expect_text(v_row.revoked_at::text, null, 'revoked_at defaults to null');
  delete from mailbox_connections where user_id = v_user;

  -- ── The revoke shape ──────────────────────────────────────────────────────
  insert into mailbox_connections (user_id, provider, email, tokens_encrypted, scopes, account_sub)
  values (v_switcher, 'google', 'zz-mailbox-google-b@example.test', 'google-blob',
          'openid https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email', 'sub-b');
  update mailbox_connections
     set status = 'revoked', tokens_encrypted = null, revoked_at = now(), updated_at = now()
   where user_id = v_switcher and tokens_encrypted = 'google-blob';
  select * into v_row from mailbox_connections where user_id = v_switcher;
  perform pg_temp.expect_text(v_row.status, 'revoked', 'the revoke marks the row revoked');
  if v_row.tokens_encrypted is not null or v_row.revoked_at is null then
    raise exception 'FAIL: the revoke leaves no token and records when';
  end if;

  -- ── The Microsoft upsert over a revoked Google row ────────────────────────
  -- The pre-R20 payload (the columns the callback wrote before #490) leaves
  -- status 'revoked' beside fresh tokens: the status/token CHECK refuses it.
  begin
    insert into mailbox_connections (user_id, provider, email, tokens_encrypted, scopes, updated_at)
    values (v_switcher, 'microsoft', 'zz-mailbox-ms@example.test', 'ms-blob',
            'offline_access User.Read Mail.Send', now())
    on conflict (user_id) do update set
      provider = excluded.provider, email = excluded.email, tokens_encrypted = excluded.tokens_encrypted,
      scopes = excluded.scopes, updated_at = excluded.updated_at;
    v_refused := 'ok';
  exception when check_violation then
    get stacked diagnostics v_refused = constraint_name;
  end;
  perform pg_temp.expect_text(v_refused, 'mailbox_connections_status_tokens_check',
    'the pre-R20 Microsoft upsert over a revoked Google row');

  -- The callback's payload since R20, as PostgREST upserts it (on conflict
  -- user_id, every named column from excluded): accepted, every column reset.
  insert into mailbox_connections (
    user_id, provider, email, tokens_encrypted, scopes, status, revoked_at, account_sub, updated_at
  ) values (
    v_switcher, 'microsoft', 'zz-mailbox-ms@example.test', 'ms-blob',
    'offline_access User.Read Mail.Send', 'connected', null, null, now()
  )
  on conflict (user_id) do update set
    provider = excluded.provider, email = excluded.email, tokens_encrypted = excluded.tokens_encrypted,
    scopes = excluded.scopes, status = excluded.status, revoked_at = excluded.revoked_at,
    account_sub = excluded.account_sub, updated_at = excluded.updated_at;
  select * into v_row from mailbox_connections where user_id = v_switcher;
  perform pg_temp.expect_text(v_row.provider, 'microsoft', 'the upsert switches the provider');
  perform pg_temp.expect_text(v_row.email, 'zz-mailbox-ms@example.test', 'the upsert stores the Microsoft address');
  perform pg_temp.expect_text(v_row.tokens_encrypted, 'ms-blob', 'the upsert stores the Microsoft tokens');
  perform pg_temp.expect_text(v_row.scopes, 'offline_access User.Read Mail.Send', 'the upsert stores the Microsoft scopes');
  perform pg_temp.expect_text(v_row.status, 'connected', 'the upsert resets status');
  perform pg_temp.expect_text(v_row.revoked_at::text, null, 'the upsert resets revoked_at');
  perform pg_temp.expect_text(v_row.account_sub, null, 'the upsert resets account_sub');
  if (select count(*) from mailbox_connections where user_id = v_switcher) <> 1 then
    raise exception 'FAIL: one sending mailbox per user';
  end if;

  -- ── Audit actions ─────────────────────────────────────────────────────────
  insert into audit_log (actor_id, action, detail) values
    (v_user, 'mailbox.connected', '{"provider":"google"}'::jsonb),
    (v_user, 'mailbox.disconnected', '{"provider":"google"}'::jsonb),
    (v_user, 'mailbox.approval_ended', '{"provider":"google"}'::jsonb),
    (v_user, 'mailbox.connect_refused', '{"provider":"google","reason":"wrong_account"}'::jsonb);
  if (select count(*) from audit_log where actor_id = v_user and action like 'mailbox.%') <> 4 then
    raise exception 'FAIL: the four mailbox audit actions are accepted';
  end if;
  -- The discovery.* rows need a tenant (the chain trigger), so the CHECK itself is read.
  if exists (
    select 1 from unnest(array['discovery.mailbox_purged', 'discovery.content_collected',
      'discovery.group_removal_held', 'discovery.tenant_purged', 'discovery.retention_policy_set',
      'discovery.mailbox_retained']) a
    where (select pg_get_constraintdef(oid) from pg_constraint where conname = 'audit_log_action_check')
      not like '%''' || a || '''%'
  ) then
    raise exception 'FAIL: the restated CHECK keeps the purge and retention actions';
  end if;

  v_refused := 'ok';
  begin
    insert into audit_log (actor_id, action, detail)
    values (v_user, 'mailbox.reconnected', '{"provider":"google"}'::jsonb);
  exception when check_violation then
    get stacked diagnostics v_refused = constraint_name;
  end;
  perform pg_temp.expect_text(v_refused, 'audit_log_action_check', 'an unknown mailbox audit action');

  raise notice 'PASS: mailbox_connections holds Microsoft and Google rows, revokes cleanly, and takes a Microsoft upsert over a revoked Google row';
end $$;

-- ── The state change functions ──────────────────────────────────────────────
do $$
declare
  v_user    uuid := gen_random_uuid();
  v_first   uuid;
  v_second  uuid;
  v_row     mailbox_connections%rowtype;
  v_audits  int;
  v_marked  boolean;
  v_deleted text;
  v_fn      text;
begin
  insert into auth.users (id, email) values (v_user, 'zz-mailbox-google-c@example.test');
  -- A new auth user is mirrored external and contained until onboarding; this one is a banker.
  update users set is_external = false where id = v_user;

  -- Connect: a new row each time, so its id names the approval; each connect audited.
  v_first := mailbox_sending_connect_google(v_user, 'zz-mailbox-google-c@example.test', 'blob-1',
    'openid https://www.googleapis.com/auth/gmail.send', 'sub-c');
  v_second := mailbox_sending_connect_google(v_user, 'zz-mailbox-google-c@example.test', 'blob-2',
    'openid https://www.googleapis.com/auth/gmail.send', 'sub-c');
  if v_first is null or v_second is null or v_first = v_second then
    raise exception 'FAIL: every connect writes a row with a new id';
  end if;
  select * into v_row from mailbox_connections where user_id = v_user;
  perform pg_temp.expect_text(v_row.id::text, v_second::text, 'the latest connect is the one row');
  perform pg_temp.expect_text(v_row.tokens_encrypted, 'blob-2', 'the latest connect stores its blob');
  perform pg_temp.expect_text(v_row.status, 'connected', 'a connect is connected');
  select count(*) into v_audits from audit_log where actor_id = v_user and action = 'mailbox.connected';
  if v_audits <> 2 then raise exception 'FAIL: each connect is audited (got %)', v_audits; end if;

  -- Mark revoked: refused for a blob the row no longer holds, accepted for the current one.
  v_marked := mailbox_sending_mark_revoked(v_second, 'blob-1');
  if v_marked then raise exception 'FAIL: a stale blob never revokes a newer approval'; end if;
  select count(*) into v_audits from audit_log where actor_id = v_user and action = 'mailbox.approval_ended';
  if v_audits <> 0 then raise exception 'FAIL: an unmarked row is not audited'; end if;
  v_marked := mailbox_sending_mark_revoked(v_second, 'blob-2');
  if not v_marked then raise exception 'FAIL: the current blob revokes'; end if;
  select * into v_row from mailbox_connections where user_id = v_user;
  perform pg_temp.expect_text(v_row.status, 'revoked', 'mark revoked sets status');
  if v_row.tokens_encrypted is not null or v_row.revoked_at is null then
    raise exception 'FAIL: mark revoked deletes the token and records when';
  end if;
  select count(*) into v_audits from audit_log where actor_id = v_user and action = 'mailbox.approval_ended';
  if v_audits <> 1 then raise exception 'FAIL: mark revoked is audited once'; end if;

  -- Disconnect: deletes and audits a Google row; nothing to delete is null and unaudited.
  v_deleted := mailbox_sending_disconnect(v_user);
  perform pg_temp.expect_text(v_deleted, 'google', 'disconnect returns the deleted provider');
  if exists (select 1 from mailbox_connections where user_id = v_user) then
    raise exception 'FAIL: disconnect deletes the row';
  end if;
  v_deleted := mailbox_sending_disconnect(v_user);
  perform pg_temp.expect_text(v_deleted, null, 'disconnect without a row');
  select count(*) into v_audits from audit_log where actor_id = v_user and action = 'mailbox.disconnected';
  if v_audits <> 1 then raise exception 'FAIL: only the real disconnect is audited (got %)', v_audits; end if;

  -- A Microsoft disconnect is not audited yet (T5).
  insert into mailbox_connections (user_id, provider, email, tokens_encrypted)
  values (v_user, 'microsoft', 'zz-mailbox-ms@example.test', 'ms-blob');
  v_deleted := mailbox_sending_disconnect(v_user);
  perform pg_temp.expect_text(v_deleted, 'microsoft', 'a Microsoft disconnect');
  select count(*) into v_audits from audit_log where actor_id = v_user and action = 'mailbox.disconnected';
  if v_audits <> 1 then raise exception 'FAIL: a Microsoft disconnect writes no audit row'; end if;

  -- Only service_role executes them.
  foreach v_fn in array array[
    'mailbox_sending_connect_google(uuid, text, text, text, text)',
    'mailbox_sending_mark_revoked(uuid, text)',
    'mailbox_sending_disconnect(uuid)'
  ] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'FAIL: % is executable by service_role only', v_fn;
    end if;
  end loop;

  raise notice 'PASS: connect, mark revoked and disconnect change the row and write their audit row';
end $$;

-- ── A failed audit write undoes the state change ────────────────────────────
-- An audit_log trigger that refuses mailbox.* rows, in this transaction only.
create function public.zz_refuse_mailbox_audit() returns trigger language plpgsql as $$
begin
  if new.action like 'mailbox.%' then
    raise exception 'zz audit refused';
  end if;
  return new;
end;
$$;

do $$
declare
  v_user    uuid := gen_random_uuid();
  v_id      uuid;
  v_row     mailbox_connections%rowtype;
  v_failed  boolean;
begin
  insert into auth.users (id, email) values (v_user, 'zz-mailbox-google-d@example.test');
  -- A new auth user is mirrored external and contained until onboarding; this one is a banker.
  update users set is_external = false where id = v_user;
  v_id := mailbox_sending_connect_google(v_user, 'zz-mailbox-google-d@example.test', 'blob-d',
    'openid https://www.googleapis.com/auth/gmail.send', 'sub-d');

  create trigger zz_refuse_mailbox_audit before insert on audit_log
    for each row execute function public.zz_refuse_mailbox_audit();

  v_failed := false;
  begin
    perform mailbox_sending_connect_google(v_user, 'zz-mailbox-google-d@example.test', 'blob-new',
      'openid https://www.googleapis.com/auth/gmail.send', 'sub-d');
  exception when others then v_failed := true;
  end;
  select * into v_row from mailbox_connections where user_id = v_user;
  if not v_failed or v_row.id <> v_id or v_row.tokens_encrypted <> 'blob-d' then
    raise exception 'FAIL: a connect whose audit fails leaves the earlier connection';
  end if;

  v_failed := false;
  begin
    perform mailbox_sending_mark_revoked(v_id, 'blob-d');
  exception when others then v_failed := true;
  end;
  select * into v_row from mailbox_connections where user_id = v_user;
  if not v_failed or v_row.status <> 'connected' or v_row.tokens_encrypted <> 'blob-d' then
    raise exception 'FAIL: a revoke whose audit fails leaves the row connected';
  end if;

  v_failed := false;
  begin
    perform mailbox_sending_disconnect(v_user);
  exception when others then v_failed := true;
  end;
  if not v_failed or not exists (select 1 from mailbox_connections where user_id = v_user) then
    raise exception 'FAIL: a disconnect whose audit fails leaves the row';
  end if;

  drop trigger zz_refuse_mailbox_audit on audit_log;
  raise notice 'PASS: a failed audit write undoes connect, mark revoked and disconnect';
end $$;

-- Bankers only (owner decision 2026-10-19): an external user, or no user at all, is refused
-- not_eligible (42501) and nothing is stored or audited.
do $$
declare
  v_external uuid := gen_random_uuid();
  v_nobody   uuid := gen_random_uuid();
  v_who      uuid;
  v_state    text;
  v_message  text;
begin
  -- A new auth user is mirrored external until onboarding says otherwise.
  insert into auth.users (id, email) values (v_external, 'zz-mailbox-google-x@example.test');
  if not exists (select 1 from users where id = v_external and is_external) then
    raise exception 'FAIL: setup, the external user is mirrored as external';
  end if;
  foreach v_who in array array[v_external, v_nobody] loop
    v_state := null;
    begin
      perform mailbox_sending_connect_google(v_who, 'zz-mailbox-google-x@example.test', 'blob-x',
        'openid https://www.googleapis.com/auth/gmail.send', 'sub-x');
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
    end;
    perform pg_temp.expect_text(v_state, '42501', 'connect refuses a non-banker');
    perform pg_temp.expect_text(v_message, 'not_eligible', 'the refusal names not_eligible');
    if exists (select 1 from mailbox_connections where user_id = v_who)
       or exists (select 1 from audit_log where actor_id = v_who and action = 'mailbox.connected') then
      raise exception 'FAIL: a refused connect stores and audits nothing';
    end if;
  end loop;
  raise notice 'PASS: an external user or no user cannot connect Gmail for sending';
end $$;

rollback;
