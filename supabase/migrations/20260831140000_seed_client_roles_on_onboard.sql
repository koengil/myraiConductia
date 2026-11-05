-- Default Employee/MD roles belong to an onboarded client organization, not a
-- CRM lead. Registering "Figma" must not create an org chart. Seed only when
-- someone is invited onto the company or attached as its first member.

drop trigger if exists seed_client_company_roles on companies;
drop function if exists trg_seed_client_company_roles();

create or replace function trg_seed_client_roles_on_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform seed_client_company_default_roles(new.company_id, new.invited_by);
  return new;
end;
$$;

drop trigger if exists seed_client_roles_on_invite on invites;
create trigger seed_client_roles_on_invite
  after insert on invites
  for each row execute function trg_seed_client_roles_on_invite();

create or replace function trg_seed_client_roles_on_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.company_id is not null
     and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id)
  then
    perform seed_client_company_default_roles(new.company_id, new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists seed_client_roles_on_membership on users;
create trigger seed_client_roles_on_membership
  after insert or update of company_id on users
  for each row execute function trg_seed_client_roles_on_membership();

-- CRM leads that were never invited onto or staffed: drop the unused templates.
delete from company_roles r
using companies c
where r.company_id = c.id
  and c.type = 'client'
  and lower(r.name) in ('employee', 'md')
  and r.archived_at is null
  and not exists (select 1 from users u where u.company_id = c.id)
  and not exists (select 1 from invites i where i.company_id = c.id);
