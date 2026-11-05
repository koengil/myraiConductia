grant usage on schema :"schema" to service_role, anon, authenticated;
grant select, insert, update on audit_log to service_role;

do $$
declare
  v_function regprocedure;
  v_config text[];
  v_raw text;
  v_new_path text;
begin
  for v_function, v_config in
    select p.oid::regprocedure, p.proconfig from pg_proc p
    where p.pronamespace = current_schema()::regnamespace
      and (p.proname like 'skill_publication_%' or p.proname like 'skill_authoring_%')
  loop
    select cfg into v_raw from unnest(coalesce(v_config, '{}'::text[])) as cfg
    where cfg like 'search_path=%';
    if v_raw is null then
      continue;
    end if;
    select string_agg(
      case when btrim(entry) = 'public' then quote_ident(current_schema()) else quote_ident(btrim(entry)) end,
      ', ' order by ordinality
    ) into v_new_path
    from unnest(string_to_array(split_part(v_raw, '=', 2), ',')) with ordinality as entry;
    execute format('alter function %s set search_path = %s', v_function, v_new_path);
  end loop;
end;
$$;
