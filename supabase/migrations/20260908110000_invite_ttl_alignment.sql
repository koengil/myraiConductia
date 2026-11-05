-- supabase/migrations/20260908110000_invite_ttl_alignment.sql
-- Align invites.expires_at with the lifetime of the credential it describes.
--
-- The row said 7 days (20260731120000_onboarding_invites.sql) but the thing an
-- invitee actually clicks is a GoTrue one-time token, whose lifetime is the
-- hosted project's "Email OTP Expiration" setting and is capped by Supabase at
-- 24 hours. Nothing in the database knew that, so every invite advertised a
-- week and delivered at most a day.
--
-- The Ignatious launch (7 September 2026) walked straight into it: the first
-- director's link email read "This invitation expires in 7 days", he opened it
-- the next morning 15 hours later, and GoTrue rejected the token as expired.
-- The invite row was still 'pending' with six days left, so nothing in our own
-- state looked wrong.
--
-- One lifetime from here. The six-digit challenge and the link now expire
-- together, which is what the challenge email always claimed ("This code
-- expires with your invitation").
--
-- CONSEQUENCE, deliberate: rotate_invite_credential refuses a row whose
-- expires_at has passed, so a resend is only a recovery path INSIDE the
-- window. After it lapses the invite is terminal and recovery is a fresh
-- invite row, which create_invite already handles by flipping the stale
-- 'pending' row to 'expired' first and freeing the partial unique index.
-- docs/04-operations/production-bootstrap.md carries the operator version.
--
-- Existing rows are left alone. Back-dating live invitations would strand
-- anyone mid-onboarding, and the lazy pending->expired transitions inside
-- create/resend/accept retire them on their original terms.

alter table invites
  alter column expires_at set default now() + interval '24 hours';

-- Unchanged from 20260804160000_invite_safeguard_2fa.sql except the interval.
create or replace function public.rotate_invite_credential(
  p_invite_id uuid,
  p_challenge_digest text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
begin
  if p_challenge_digest is null or p_challenge_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'challenge_required';
  end if;

  select * into v_invite from invites where id = p_invite_id for update;
  if not found or v_invite.status <> 'pending' then raise exception 'not_pending'; end if;
  if v_invite.expires_at < now() then raise exception 'not_pending'; end if;

  update invites
     set credential_nonce = gen_random_uuid(),
         delivery_status = 'unsent',
         expires_at = now() + interval '24 hours',
         challenge_digest = p_challenge_digest,
         challenge_version = challenge_version + 1,
         challenge_issued_at = now(),
         challenge_attempts = 0,
         challenge_locked_at = null,
         challenge_verified_at = null,
         challenge_verified_user_id = null,
         challenge_verified_version = null
   where id = p_invite_id
  returning * into v_invite;

  insert into audit_log (actor_id, action, deal_id, detail) values (
    v_invite.invited_by,
    'invite_challenge_rotated',
    v_invite.deal_id,
    jsonb_build_object(
      'invite_id', v_invite.id,
      'company_id', v_invite.company_id,
      'challenge_version', v_invite.challenge_version,
      'outcome', 'rotated'
    )
  );

  return jsonb_build_object(
    'id', v_invite.id,
    'email', v_invite.email,
    'credential_nonce', v_invite.credential_nonce,
    'expires_at', v_invite.expires_at,
    'challenge_version', v_invite.challenge_version
  );
end;
$$;

-- create or replace keeps existing privileges; re-asserted so the function's
-- reachability does not depend on which migration last defined it.
revoke all on function public.rotate_invite_credential(uuid, text) from public;
grant execute on function public.rotate_invite_credential(uuid, text) to service_role;
