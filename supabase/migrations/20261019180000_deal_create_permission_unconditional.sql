create or replace function app_can_create_deals(p_actor_id uuid, p_company_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from users u where u.id = p_actor_id and u.firm_role in ('admin', 'cco'))
      or exists (
           select 1 from app_company_effective_permissions(p_actor_id, p_company_id) ep
            where ep.permission_key = 'company:deals:create');
$$;

revoke all on function app_can_create_deals(uuid, uuid) from public, anon, authenticated;
grant execute on function app_can_create_deals(uuid, uuid) to service_role;
