-- Allow external client-company directors to invite employees without a deal.
-- Matches userCanInvite in src/lib/api/v1/access.ts (Employees HR view).

do $$
declare
  v_signature regprocedure := to_regprocedure(
    'public.create_invite(uuid,text,uuid,text,text,uuid,uuid,text,integer)'
  );
  v_definition text;
  v_old_block constant text := $old$
  elsif v_actor.is_external then
    -- External directors grow their own team only, and only onto a deal their
    -- own company is a party to.
    v_permitted := coalesce(v_actor.company_role = 'director'
      and v_actor.company_id = p_company_id, false)
      and p_deal_id is not null
      and exists (
        select 1 from deal_parties
         where deal_id = p_deal_id and company_id = v_actor.company_id for share
      );
$old$;
  v_new_block constant text := $new$
  elsif v_actor.is_external then
    -- External directors invite into their own company. Deal-less invites are
    -- allowed for client companies (Employees HR view). Deal-attached invites
    -- require a party seat on that deal.
    v_permitted := coalesce(v_actor.company_role = 'director'
      and v_actor.company_id = p_company_id, false)
      and (
        (p_deal_id is null and v_company_type = 'client')
        or (
          p_deal_id is not null
          and exists (
            select 1 from deal_parties
             where deal_id = p_deal_id and company_id = v_actor.company_id for share
          )
        )
      );
$new$;
begin
  if v_signature is null then
    raise exception 'create_invite_phase_signature_not_found';
  end if;
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_old_block in v_definition) = 0 then
    raise exception 'create_invite_external_director_block_not_found';
  end if;
  execute replace(v_definition, v_old_block, v_new_block);
end;
$$;
