-- Session-callable consent status for the "Deal discovery" card (#262, Q2).
-- Answers for auth.uid() only and never exposes the allowlist views.
--
-- `consented` is the open consent on the caller's CURRENT seated invite, the
-- one the guard reads (C12). An open consent on an older invite (an earlier
-- stint at the firm, before a re-invite) never reads anything, so it is not
-- reported as consent: `consented` is false and the card offers Connect. It is
-- reported separately as `staleConsent`, true only when the caller holds an
-- open consent and none of them is on the seated invite, so the card can still
-- offer "Stop reading" and the member is never left with a consent they cannot
-- see. With no seat at all (the registration paused, say) any open consent is
-- stale in that sense, for the same reason.
--
-- `reading` is database eligibility (audit round 3, H2; owner decision D2): true
-- exactly when mailbox_guard_check allows the seated address for the caller as its
-- owner, because both ask one decision, mailbox_guard_verdict. It does not say a pass
-- is running or will read: the worker's provider-group mirror and flags are not
-- database facts, and the card says "Conductia reads your mailbox when your firm's
-- reader runs". Otherwise `readingReason` is the guard's reason, in the guard's order
-- and vocabulary (no_source before no_consent; a paused source is source_paused),
-- except `domain` and `not_on_a_deal` (about the member, before any source) and
-- `no_invite` when the caller has no seat (mailbox_reading_reason in 20261001130000
-- lists the set and the mapping). Consent alone is not reading: the card says
-- "You're connected" only when `reading` is true.
--
-- `eligible` is whether a grant would be accepted now: seated, on a registered
-- domain, and MD or deal team on a deal of the member's tenant (A2). `reason`
-- names the first of those that fails, `domain` or `not_on_a_deal`. The deal
-- test is a grant-time precondition only, so a consented member who has left
-- every deal still reads `eligible: false` here while `reading` and
-- `readingReason` follow the ladder (the guard does not test the deal), and
-- `readingReason` says `not_on_a_deal` only while there is no open consent.
create or replace function mailbox_consent_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_seat mailbox_seated_invites%rowtype;
  v_open mailbox_consents%rowtype;
  v_stale mailbox_consents%rowtype;
  v_eligible boolean;
  v_domain_ok boolean;
  v_on_deal boolean;
  v_reason text;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_seat from mailbox_seated_invites where user_id = v_user;
  if not found then
    -- Any open consent of the caller, whatever their eligibility now: the
    -- registration can change (domains, firm company, status) without touching
    -- users, so no trigger closes the consent, and the card must keep offering
    -- "Stop reading my mailbox" (review round 4). Withdrawal needs no eligibility.
    -- Consent resurrection is accepted as designed (audit round 1, item 19): when
    -- an admin pauses the registration (disables it, narrows its domains, or
    -- points it at another firm) and later restores it, this open consent is
    -- allowed again with no new opt-in, because the member consented and only the
    -- registration was paused. Losing the seat is what ends a consent (R21), and
    -- deleting the invite withdraws it; changing the registration does not.
    select * into v_stale from mailbox_consents
    where user_id = v_user and withdrawn_at is null
    order by granted_at desc limit 1;
    return jsonb_build_object('eligible', false, 'reason', 'no_invite',
      'consented', false, 'staleConsent', v_stale.id is not null,
      'since', null, 'address', v_stale.address,
      'reading', false, 'readingReason', 'no_invite');
  end if;
  select * into v_open from mailbox_consents
  where invite_id = v_seat.invite_id and user_id = v_user and withdrawn_at is null;
  if not found then
    select * into v_stale from mailbox_consents
    where user_id = v_user and withdrawn_at is null
    order by granted_at desc limit 1;
  end if;
  -- Same tests as mailbox_consent_grant(): seated on a provider's registered domain for this firm,
  -- and MD or deal team on a deal of the member's tenant.
  v_domain_ok := cardinality(mailbox_reader_providers(v_seat.tenant_id, v_seat.address, v_seat.company_id)) > 0;
  v_on_deal := mailbox_member_on_a_deal(v_seat.tenant_id, v_user);
  v_eligible := v_domain_ok and v_on_deal;
  v_reason := mailbox_reading_reason(v_seat.tenant_id, v_seat.address, v_user, v_seat.company_id, v_open.id is not null);
  return jsonb_build_object(
    'eligible', v_eligible,
    'reason', case when not v_domain_ok then 'domain' when not v_on_deal then 'not_on_a_deal' end,
    'consented', v_open.id is not null,
    'staleConsent', v_open.id is null and v_stale.id is not null,
    'since', v_open.granted_at,
    'address', v_seat.address,
    'reading', v_reason is null,
    'readingReason', v_reason
  );
end;
$$;
revoke all on function mailbox_consent_status() from public, anon;
grant execute on function mailbox_consent_status() to authenticated;
