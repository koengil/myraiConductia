-- Access-request approval is an organization-admin decision. Assign employee
-- access is enough to grant the one requested key; the members-drawer envelope
-- still applies to free-form assignment.

create or replace function grant_access_request_permission(
  p_actor_id uuid,
  p_company_id uuid,
  p_user_id uuid,
  p_permission_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target users%rowtype;
  v_company companies%rowtype;
  v_access company_member_access%rowtype;
  v_created boolean := false;
  v_new_version bigint;
begin
  perform company_access_lock_actor(
    p_actor_id, p_company_id, 'company:access:assign'
  );
  select * into v_company from companies where id = p_company_id for share;
  select * into v_target from users where id = p_user_id for share;
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
  if p_permission_key is null
     or not exists (select 1 from company_permissions p where p.key = p_permission_key) then
    raise exception 'invalid_company_permission';
  end if;

  if app_has_company_permission(p_user_id, p_company_id, p_permission_key) then
    return jsonb_build_object('granted', false, 'already', true);
  end if;

  select * into v_access from company_member_access
    where company_id = p_company_id and user_id = p_user_id for update;
  if not found then
    insert into company_member_access (company_id, user_id)
    values (p_company_id, p_user_id)
    returning * into v_access;
    v_created := true;
  end if;

  v_new_version := case
    when v_created then v_access.version
    else v_access.version + 1
  end;

  insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
  values (p_company_id, p_user_id, p_permission_key, p_actor_id);

  insert into audit_log (actor_id, action, detail) values (
    p_actor_id, 'grant', jsonb_build_object(
      'reason', 'company_member_permission_granted',
      'company_id', p_company_id,
      'user_id', p_user_id,
      'source_type', 'direct',
      'permission_key', p_permission_key,
      'access_version', v_new_version,
      'via', 'access_request'
    )
  );

  if not v_created then
    update company_member_access
      set version = v_new_version, updated_at = now()
      where company_id = p_company_id and user_id = p_user_id;
  end if;

  if p_permission_key = 'company:invites:send' then
    update users set can_invite = true where id = p_user_id;
  end if;

  return jsonb_build_object(
    'granted', true,
    'already', false,
    'version', v_new_version
  );
end;
$$;

revoke all on function grant_access_request_permission(uuid, uuid, uuid, text) from public;
grant execute on function grant_access_request_permission(uuid, uuid, uuid, text) to service_role;
