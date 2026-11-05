-- #312 [3/3]: replace_company_member_access locks its target user FOR NO KEY UPDATE
-- before it writes any audit row, instead of FOR SHARE.
--
-- It took the target's user row FOR SHARE, wrote its grant/revoke audit rows (which
-- take the tenant's audit-chain advisory lock in zz_audit_log_chain_append), and only
-- then UPDATEd users.can_invite on the same row: a share lock upgraded after the chain
-- lock. A step skip (#312, rail_skip_approver) holds the approver's user row FOR SHARE
-- and writes its own audit row last, so the order is user -> seat -> chain. With the
-- approver as the target the two formed a cycle: the skip waited for the chain lock
-- while this function waited to update the row the skip held, and Postgres aborted
-- one with 40P01.
--
-- Taking the row lock it will need up front removes the upgrade: whichever of the two
-- locks the user row first finishes, and the other waits for it. NO KEY UPDATE, not
-- FOR UPDATE: the UPDATE below never changes a key column, and foreign-key checks
-- (FOR KEY SHARE) from rows that reference the user are not blocked.
--
-- Re-declared from 20260816120000_client_company_access_management.sql with only that
-- lock changed and the search_path pinned to public, pg_temp. Same signature, same
-- grants. tests/integration/company-access-skip-lock.test.ts proves the skip and this
-- function on the same user no longer deadlock.

create or replace function replace_company_member_access(
  p_actor_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_expected_version bigint,
  p_role_ids uuid[] default array[]::uuid[],
  p_direct_permission_keys text[] default array[]::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_root boolean;
  v_target users%rowtype;
  v_company companies%rowtype;
  v_access company_member_access%rowtype;
  v_role_ids uuid[];
  v_direct text[];
  v_bundle text[];
  v_before_roles uuid[];
  v_before_direct text[];
  v_permission text;
  v_created boolean := false;
  v_changed boolean;
  v_new_version bigint;
begin
  v_root := company_access_lock_actor(
    p_actor_id, p_company_id, 'company:access:assign'
  );
  select * into v_company from companies where id = p_company_id for share;
  -- The row is updated below (can_invite) after the audit rows: lock it for that
  -- update now, before any audit insert takes the chain lock (#312 [3/3]).
  select * into v_target from users where id = p_user_id for no key update;
  if not found
     or v_target.status <> 'active'
     or v_target.company_id is distinct from p_company_id
     or v_target.tenant_id is distinct from v_company.tenant_id then
    raise exception 'company_member_not_eligible';
  end if;
  if v_company.type = 'bank' and v_target.is_external then
    raise exception 'company_member_not_eligible';
  end if;
  if app_company_is_access_root(p_user_id, p_company_id) then
    raise exception 'protected_access_root';
  end if;

  select coalesce(array_agg(distinct id order by id), array[]::uuid[])
    into v_role_ids from unnest(coalesce(p_role_ids, array[]::uuid[])) requested(id);
  select coalesce(array_agg(distinct key order by key), array[]::text[])
    into v_direct from unnest(coalesce(p_direct_permission_keys, array[]::text[])) requested(key);
  perform company_access_validate_envelope(
    p_actor_id, p_company_id, v_direct, v_root
  );
  if exists (
    select 1 from unnest(v_role_ids) requested(id)
    left join company_roles r
      on r.company_id = p_company_id and r.id = requested.id and r.archived_at is null
    where r.id is null
  ) then
    raise exception 'invalid_company_role';
  end if;
  select coalesce(array_agg(distinct rp.permission_key order by rp.permission_key), array[]::text[])
    into v_bundle
    from company_role_permissions rp
    where rp.company_id = p_company_id and rp.role_id = any(v_role_ids);
  perform company_access_validate_envelope(
    p_actor_id, p_company_id, v_bundle, v_root
  );

  select * into v_access from company_member_access
    where company_id = p_company_id and user_id = p_user_id for update;
  if found then
    if v_access.version is distinct from p_expected_version then raise exception 'stale_version'; end if;
  else
    if p_expected_version is distinct from 0 then raise exception 'stale_version'; end if;
    insert into company_member_access (company_id, user_id)
    values (p_company_id, p_user_id)
    returning * into v_access;
    v_created := true;
  end if;
  select coalesce(array_agg(role_id order by role_id), array[]::uuid[])
    into v_before_roles from company_member_roles
    where company_id = p_company_id and user_id = p_user_id;
  select coalesce(array_agg(permission_key order by permission_key), array[]::text[])
    into v_before_direct from company_member_permissions
    where company_id = p_company_id and user_id = p_user_id;
  v_changed := v_created
    or v_before_roles is distinct from v_role_ids
    or v_before_direct is distinct from v_direct;
  v_new_version := case
    when v_created then v_access.version
    when v_changed then v_access.version + 1
    else v_access.version
  end;

  insert into audit_log (actor_id, action, detail)
  select
    p_actor_id,
    'revoke',
    jsonb_build_object(
        'reason', 'company_member_role_revoked', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'role', 'source_id', previous.id,
        'permission_key', permission.permission_key,
        'access_version', v_new_version
      )
  from unnest(v_before_roles) previous(id)
  left join company_role_permissions permission on permission.role_id = previous.id
  where not (previous.id = any(v_role_ids));

  insert into audit_log (actor_id, action, detail)
  select
    p_actor_id,
    'grant',
    jsonb_build_object(
        'reason', 'company_member_role_granted', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'role', 'source_id', requested.id,
        'permission_key', permission.permission_key,
        'access_version', v_new_version
      )
  from unnest(v_role_ids) requested(id)
  left join company_role_permissions permission on permission.role_id = requested.id
  where not (requested.id = any(v_before_roles));
  for v_permission in
    select key from unnest(v_before_direct) previous(key) where not (key = any(v_direct))
  loop
    insert into audit_log (actor_id, action, detail) values (
      p_actor_id, 'revoke', jsonb_build_object(
        'reason', 'company_member_permission_revoked', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'direct',
        'permission_key', v_permission, 'access_version', v_new_version
      )
    );
  end loop;
  for v_permission in
    select key from unnest(v_direct) requested(key) where not (key = any(v_before_direct))
  loop
    insert into audit_log (actor_id, action, detail) values (
      p_actor_id, 'grant', jsonb_build_object(
        'reason', 'company_member_permission_granted', 'company_id', p_company_id,
        'user_id', p_user_id, 'source_type', 'direct',
        'permission_key', v_permission, 'access_version', v_new_version
      )
    );
  end loop;

  delete from company_member_roles
    where company_id = p_company_id
      and user_id = p_user_id
      and not (role_id = any(v_role_ids));
  insert into company_member_roles (company_id, user_id, role_id, assigned_by)
  select p_company_id, p_user_id, id, p_actor_id
  from unnest(v_role_ids) requested(id)
  where not (id = any(v_before_roles));
  delete from company_member_permissions
    where company_id = p_company_id
      and user_id = p_user_id
      and not (permission_key = any(v_direct));
  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  select p_company_id, p_user_id, key, p_actor_id
  from unnest(v_direct) requested(key)
  where not (key = any(v_before_direct));

  if v_changed then
    update company_member_access set version = v_new_version, updated_at = now()
      where company_id = p_company_id and user_id = p_user_id
      returning * into v_access;
    update users set can_invite = ('company:invites:send' = any(v_direct))
      where id = p_user_id;
  end if;

  return jsonb_build_object(
    'company_id', p_company_id,
    'user_id', p_user_id,
    'version', v_access.version,
    'role_ids', to_jsonb(v_role_ids),
    'direct_permissions', to_jsonb(v_direct),
    'effective_permissions', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'permission_key', effective.permission_key,
          'source_type', effective.source_type,
          'source_id', effective.source_id,
          'source_name', effective.source_name
        ) order by effective.permission_key, effective.source_type, effective.source_id
      )
      from app_company_effective_permissions(p_user_id, p_company_id) effective
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function replace_company_member_access(uuid, uuid, uuid, bigint, uuid[], text[]) from public, anon, authenticated;
grant execute on function replace_company_member_access(uuid, uuid, uuid, bigint, uuid[], text[]) to service_role;
