do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end;
$$;

alter default privileges in schema :"schema" grant all on tables to anon, authenticated;
alter default privileges in schema :"schema" grant execute on functions to anon, authenticated;
