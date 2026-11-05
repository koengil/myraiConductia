-- Run only against an isolated migrated database. Nothing persists.
begin;
create temporary table boundary_probe (like public.outbound_messages including defaults including constraints);
do $$
declare boundary text;
begin
  foreach boundary in array array[null, 'internal', 'external', 'unverified']::text[] loop
    insert into boundary_probe (tenant_id, sender_id, to_emails, subject, body, verdict, status, recipient_boundary)
    values (gen_random_uuid(), gen_random_uuid(), array['zz-test@example.test'], 'ZZ TEST', 'ZZ TEST', 'compliant', 'sent', boundary);
  end loop;
  begin
    insert into boundary_probe (tenant_id, sender_id, to_emails, subject, body, verdict, status, recipient_boundary)
    values (gen_random_uuid(), gen_random_uuid(), array['zz-test@example.test'], 'ZZ TEST', 'ZZ TEST', 'compliant', 'sent', 'invalid');
    raise exception 'Invalid boundary was accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;
