-- Create leads is a separate ask from View Leads. A member who can already
-- open /leads must still be able to request company:leads:create without
-- colliding with a pending View Leads row.

do $$
declare
  rec record;
begin
  for rec in
    select conname
    from pg_constraint
    where conrelid = 'access_requests'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%destination%'
  loop
    execute format('alter table access_requests drop constraint %I', rec.conname);
  end loop;
end
$$;

alter table access_requests
  add constraint access_requests_destination_check
  check (destination in ('leads', 'leads_create', 'organization'));
