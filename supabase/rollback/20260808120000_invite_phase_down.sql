-- Rollback for 20260808120000_invite_phase.sql.
--
-- This rollback is NOT lossless, and the order below exists to make the loss
-- explicit and recoverable rather than silent.
--
-- A pending invitation carrying phase 2 holds a decision an inviter made and
-- confirmed. Dropping the column destroys that decision, and acceptance
-- afterwards would grant phase 0 without telling anyone — which is exactly the
-- failure the forward migration exists to prevent, arriving through the back
-- door. So those invitations are withdrawn and audited FIRST, in one
-- transaction, before anything is dropped.
--
-- The containment UPDATE contends for the same row lock accept_invite takes
-- (`select ... for update`), so the two possible interleavings are both
-- truthful:
--   - containment commits first: acceptance then fails with invite_not_pending,
--     and no seat is granted at a phase nobody can see;
--   - acceptance commits first: the seat is granted at the phase that was
--     genuinely confirmed, and the row is no longer 'pending' so containment
--     leaves it alone.
-- There is deliberately no silent fallback to phase 0.
--
-- Recovery: withdrawn invitations must be reissued. They appear in audit_log
-- with detail->>'reason' = 'invite_phase_rollback'.

begin;

-- 1. Withdraw and audit every pending invitation whose phase would be lost.
--    Only rows this statement actually expired are audited, so a row accepted
--    concurrently is never reported as withdrawn.
with withdrawn as (
  update invites
     set status = 'expired'
   where status = 'pending'
     and phase > 0
  returning id, invited_by, deal_id, company_id, email, phase
)
insert into audit_log (actor_id, action, deal_id, detail)
select
  w.invited_by,
  'revoke',
  w.deal_id,
  jsonb_build_object(
    'reason', 'invite_phase_rollback',
    'invite_id', w.id,
    'company_id', w.company_id,
    'email', w.email,
    'phase', w.phase
  )
from withdrawn w;

-- 2. Drop the 9-argument create_invite. Re-running
--    20260804160000_invite_safeguard_2fa.sql afterwards restores the
--    8-argument version; without this drop the two would co-exist as
--    overloads and calls would be ambiguous.
revoke all on function public.create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer) from public;
drop function if exists public.create_invite(uuid, text, uuid, text, text, uuid, uuid, text, integer);

-- 3. Restore accept_invite BEFORE the column goes. A plpgsql body resolves
--    column references when it runs, not when it is created, so dropping
--    `invites.phase` while the new body still references it would leave every
--    acceptance failing at runtime.
create or replace function public.accept_invite(
  p_invite_id uuid,
  p_nonce uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_user_email text;
  v_invite invites%rowtype;
  v_company_type text;
  v_is_external boolean;
  v_role_id uuid;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select lower(email) into v_user_email from auth.users where id = v_user;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found then raise exception 'invite_not_found'; end if;
  if v_invite.status <> 'pending' then raise exception 'invite_not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'invite_expired'; end if;
  if v_invite.credential_nonce is distinct from p_nonce then raise exception 'credential_mismatch'; end if;
  if v_invite.email <> v_user_email then raise exception 'email_mismatch'; end if;
  if v_invite.tenant_id is distinct from (select tenant_id from users where id = v_user) then
    raise exception 'tenant_mismatch';
  end if;
  if v_invite.delivery_status <> 'sent'
     or v_invite.challenge_digest is null
     or v_invite.challenge_locked_at is not null
     or v_invite.challenge_verified_at is null
     or v_invite.challenge_verified_user_id is distinct from v_user
     or v_invite.challenge_verified_version is distinct from v_invite.challenge_version
  then
    raise exception 'invite_not_verified';
  end if;

  update invites
     set status = 'accepted', accepted_at = now(), accepted_user_id = v_user
   where id = p_invite_id and status = 'pending';
  if not found then raise exception 'invite_not_pending'; end if;

  select type into v_company_type from companies where id = v_invite.company_id;
  v_is_external := (v_company_type is distinct from 'bank');

  update users
     set company_id = v_invite.company_id,
         company_role = v_invite.company_role,
         is_external = v_is_external,
         status = 'active'
   where id = v_user;

  if v_invite.deal_id is not null then
    select id into v_role_id from roles where slug = v_invite.deal_role;
    insert into deal_memberships (deal_id, user_id, role_id, deal_role, phase, added_by)
    values (v_invite.deal_id, v_user, v_role_id, v_invite.deal_role, 0, v_invite.invited_by)
    on conflict (deal_id, user_id) do nothing;

    insert into audit_log (actor_id, action, deal_id, detail) values (
      v_invite.invited_by,
      'grant',
      v_invite.deal_id,
      jsonb_build_object(
        'user_id', v_user, 'deal_role', v_invite.deal_role, 'phase', 0, 'via', 'invite'
      )
    );
  end if;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    v_user,
    'invite_accepted',
    v_invite.deal_id,
    jsonb_build_object('invite_id', v_invite.id, 'email', v_invite.email)
  );

  return jsonb_build_object(
    'deal_id', v_invite.deal_id,
    'company_id', v_invite.company_id,
    'is_external', v_is_external
  );
end;
$$;

-- 4. Now the column can go.
alter table invites drop column phase;

commit;

-- 5. Finally, re-run supabase/migrations/20260804160000_invite_safeguard_2fa.sql
--    to restore the 8-argument create_invite and its grants.
