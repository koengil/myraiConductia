-- #172: administrative relationship facts, never an email preflight log.
create table if not exists public.deal_recipient_affiliations (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 deal_id uuid not null references public.deals(id) on delete cascade,
 normalized_email text not null check (normalized_email = lower(trim(normalized_email)) and normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 company_id uuid not null references public.companies(id),
 affiliation text not null check (affiliation in ('client','client_advisor','counterparty','counterparty_advisor')),
 represented_company_id uuid references public.companies(id),
 user_id uuid references public.users(id),
 invite_id uuid references public.invites(id),
 revision integer not null default 1 check (revision > 0),
 created_by uuid not null references public.users(id),
 updated_by uuid not null references public.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(deal_id,normalized_email),
 check ((user_id is null) <> (invite_id is null)),
 check ((affiliation in ('client_advisor','counterparty_advisor')) = (represented_company_id is not null))
);
alter table public.deal_recipient_affiliations enable row level security;
revoke all on public.deal_recipient_affiliations from anon, authenticated;
grant select,insert,update,delete on public.deal_recipient_affiliations to service_role;

create or replace function public.set_recipient_affiliation(
 p_actor uuid, p_deal_id uuid, p_email text, p_company_id uuid,
 p_affiliation text, p_represented_company_id uuid default null,
 p_user_id uuid default null, p_invite_id uuid default null,
 p_expected_revision integer default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 a users%rowtype; d deals%rowtype; c companies%rowtype; u users%rowtype;
 i invites%rowtype; r deal_recipient_affiliations%rowtype;
 normalized text := lower(trim(p_email));
 permitted boolean;
begin
 select * into a from users where id=p_actor for share;
 if a.id is null or a.status <> 'active' or coalesce(a.is_external,true) then raise exception 'forbidden'; end if;
 select * into c from companies where id=p_company_id for share;
 select * into d from deals where id=p_deal_id for share;
 if d.id is null or c.id is null or d.tenant_id is distinct from a.tenant_id or c.tenant_id is distinct from d.tenant_id then raise exception 'tenant_mismatch'; end if;
 perform 1 from deal_memberships where deal_id=d.id and user_id=a.id for share;
 permitted := coalesce(a.firm_role='admin',false)
  or coalesce(a.company_role='director' and a.company_id=d.bank_id,false)
  or exists(select 1 from deal_memberships where deal_id=d.id and user_id=a.id and
    (deal_role='md' or access_scope->>'can_manage_members'='true'));
 if not permitted then raise exception 'forbidden'; end if;
 if p_affiliation is null or p_affiliation not in ('client','client_advisor','counterparty','counterparty_advisor')
  or normalized is null or normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  or ((p_user_id is null) = (p_invite_id is null))
  or ((p_affiliation in ('client_advisor','counterparty_advisor')) <> (p_represented_company_id is not null)) then raise exception 'invalid_affiliation'; end if;
 -- Every external relationship must be connected to an actual deal party.
 if c.id=d.bank_id or not exists(select 1 from deal_parties where deal_id=d.id and company_id=c.id) then raise exception 'invalid_party'; end if;
 perform 1 from deal_parties where deal_id=d.id and company_id=c.id for share;
 if p_represented_company_id is not null then
  perform 1 from companies where id=p_represented_company_id and tenant_id=d.tenant_id for share;
  if not found then raise exception 'invalid_represented_party'; end if;
  perform 1 from deal_parties where deal_id=d.id and company_id=p_represented_company_id for share;
  if not found or p_represented_company_id=c.id then raise exception 'invalid_represented_party'; end if;
 end if;
 if p_user_id is not null then
  select * into u from users where id=p_user_id for share;
  if u.id is null or u.tenant_id is distinct from d.tenant_id or u.company_id is distinct from c.id
    or lower(trim(u.email)) is distinct from normalized or u.status <> 'active' then raise exception 'invalid_member'; end if;
  perform 1 from deal_memberships where deal_id=d.id and user_id=u.id for share;
  if not found then raise exception 'invalid_member'; end if;
 else
  select * into i from invites where id=p_invite_id for share;
  if i.id is null or i.tenant_id is distinct from d.tenant_id or i.deal_id is distinct from d.id
    or i.company_id is distinct from c.id or lower(trim(i.email)) is distinct from normalized
    or i.status <> 'pending' or i.expires_at <= now() then raise exception 'invalid_invite'; end if;
 end if;
 -- Serialize creation as well as edits so two first writes cannot silently win.
 perform pg_advisory_xact_lock(hashtextextended(d.id::text || ':' || normalized,0));
 select * into r from deal_recipient_affiliations where deal_id=d.id and normalized_email=normalized for update;
 if (r.id is null and p_expected_revision is not null)
   or (r.id is not null and r.revision is distinct from p_expected_revision) then raise exception 'affiliation_revision_conflict'; end if;
 if r.id is null then
  insert into deal_recipient_affiliations(tenant_id,deal_id,normalized_email,company_id,affiliation,represented_company_id,user_id,invite_id,created_by,updated_by)
   values(d.tenant_id,d.id,normalized,c.id,p_affiliation,p_represented_company_id,p_user_id,p_invite_id,a.id,a.id) returning * into r;
 else
  update deal_recipient_affiliations set company_id=c.id,affiliation=p_affiliation,
   represented_company_id=p_represented_company_id,user_id=p_user_id,invite_id=p_invite_id,
   revision=revision+1,updated_by=a.id,updated_at=now() where id=r.id returning * into r;
 end if;
 insert into audit_log(actor_id,action,deal_id,detail) values(a.id,'update',d.id,
  jsonb_build_object('kind','recipient_affiliation','affiliationId',r.id,'email',normalized,
   'affiliation',r.affiliation,'representedCompanyId',r.represented_company_id,'revision',r.revision));
 return to_jsonb(r);
end $$;
revoke all on function public.set_recipient_affiliation(uuid,uuid,text,uuid,text,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.set_recipient_affiliation(uuid,uuid,text,uuid,text,uuid,uuid,uuid,integer) to service_role;

-- Evidence only on the normal committed outgoing record. Historical rows stay NULL.
alter table public.outbound_messages add column if not exists recipient_review jsonb;

-- Wrappers preserve existing invite/grant authority and roll back both facts together.
create or replace function public.create_invite_with_affiliation(
 p_actor uuid,p_email text,p_company_id uuid,p_company_role text,p_challenge_digest text,
 p_domain_confirmation_id uuid default null,p_deal_id uuid default null,p_deal_role text default null,
 p_phase integer default 0,p_affiliation text default null,p_represented_company_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; prior_revision integer;
begin
 result:=public.create_invite(p_actor,p_email,p_company_id,p_company_role,p_challenge_digest,p_domain_confirmation_id,p_deal_id,p_deal_role,p_phase);
 -- A duplicate invitation is not permission to replace its existing relationship.
 if coalesce((result->>'duplicate')::boolean,false) then return result; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_deal_id::text || ':' || lower(trim(p_email)),0));
 select revision into prior_revision from deal_recipient_affiliations where deal_id=p_deal_id and normalized_email=lower(trim(p_email)) for update;
 perform public.set_recipient_affiliation(p_actor,p_deal_id,p_email,p_company_id,p_affiliation,p_represented_company_id,null,(result->>'id')::uuid,prior_revision);
 return result;
end $$;
revoke all on function public.create_invite_with_affiliation(uuid,text,uuid,text,text,uuid,uuid,text,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.create_invite_with_affiliation(uuid,text,uuid,text,text,uuid,uuid,text,integer,text,uuid) to service_role;

create or replace function public.grant_existing_account_with_affiliation(
 p_actor uuid,p_email text,p_company_id uuid,p_deal_id uuid,p_deal_role text,
 p_phase integer default 0,p_affiliation text default null,p_represented_company_id uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; prior_revision integer;
begin
 result:=public.grant_existing_account_to_deal(p_actor,p_email,p_company_id,p_deal_id,p_deal_role,p_phase);
 -- A no-op membership grant cannot silently change an existing relationship.
 if not coalesce((result->>'access_granted')::boolean,false) then return result; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_deal_id::text || ':' || lower(trim(p_email)),0));
 select revision into prior_revision from deal_recipient_affiliations where deal_id=p_deal_id and normalized_email=lower(trim(p_email)) for update;
 perform public.set_recipient_affiliation(p_actor,p_deal_id,p_email,p_company_id,p_affiliation,p_represented_company_id,(result->>'id')::uuid,null,prior_revision);
 return result;
end $$;
revoke all on function public.grant_existing_account_with_affiliation(uuid,text,uuid,uuid,text,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.grant_existing_account_with_affiliation(uuid,text,uuid,uuid,text,integer,text,uuid) to service_role;
