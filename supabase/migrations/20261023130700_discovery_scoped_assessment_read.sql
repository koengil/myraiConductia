-- G-07 slice 4 (#173, design R4, R12): a scoped assessment, and a dismissal of one, is read by its team inbox's
-- audience: the inbox's open readers and the CCO of the inbox's firm, through G-01's inbox-keyed reader
-- app_reads_team_mailbox (20261023110300). Until now the policies returned no scoped row to anyone (fail closed,
-- 20261023130100) and dismissing one was refused (20261023130200).
--
-- app_reads_team_mailbox checks the inbox against allowed_team_mailboxes in the inbox's own tenant, and the reader's
-- seat in the inbox's firm company. The composite reference (team_mailbox_id, tenant_id) -> team_mailboxes makes that
-- tenant the row's tenant, so a scoped row never reaches another tenant. A removed member, a refused or disconnected
-- inbox, a firm admin who is not a reader, and every other person read the shared rows only, as before.
--
-- Known gap, unchanged here (thread T-9): a CCO of another firm in the same tenant already reads the team-only
-- milestone events through the tenant-wide item-level CCO branch, so could rebuild the station; app_reads_team_mailbox
-- itself admits only the inbox firm's CCO. Slice 3b (#753) is the first change that creates team-only events (rule
-- events on a team inbox's mail), so from it on T-9 is reachable in a multi-firm tenant once a firm is approved.
-- Ignatious is single-firm today.
--
-- Two policies and one definer are restated; the definer keeps its signature, so `create or replace` keeps its owner
-- and ACL, and the grants are restated anyway. No table changes.
--
-- Reverse: restate both policies and the definer from 20261023130100 and 20261023130200.

-- ── 1. The read policies: the shared predicate, or a reader of the row's inbox ──────
-- Restated from 20261023130100 (their newest definition); the change is the second disjunct.
drop policy if exists corrections_select on corrections;
create policy corrections_select on corrections for select to authenticated using (
  (team_mailbox_id is null and (
    app_can_see_candidate(candidate_id, auth.uid())
    or (deal_id is not null and action in ('promote', 'dismiss_suggestion')
        and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid())))))
  or (team_mailbox_id is not null and app_reads_team_mailbox(team_mailbox_id, auth.uid())));

drop policy if exists stage_assessments_select on stage_assessments;
create policy stage_assessments_select on stage_assessments for select to authenticated using (
  (team_mailbox_id is null and (
    app_can_see_candidate(candidate_id, auth.uid())
    or (deal_id is not null and (app_is_deal_member(deal_id, auth.uid()) or app_is_deal_overseer(deal_id, auth.uid())))))
  or (team_mailbox_id is not null and app_reads_team_mailbox(team_mailbox_id, auth.uid())));

-- ── 2. Dismissal: the MD dismisses a scoped row only as a reader of its inbox ────────
-- Restated from 20261023130200 (its newest definition). The change: a scoped assessment is refused with 42501
-- 'not_in_team_audience' only when the MD does not read its inbox; a reader may dismiss it, and the correction
-- carries the inbox, so the dismissal is read under the scoped policy above.
create or replace function discovery_dismiss_suggestion(p_deal_id uuid, p_assessment_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare
  v_actor uuid := auth.uid();
  a stage_assessments;
  v_corr uuid;
begin
  if v_actor is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required' using errcode = '22023'; end if;
  if not app_is_deal_md(p_deal_id, v_actor) then raise exception 'not_md' using errcode = '42501'; end if;
  select * into a from stage_assessments sa where sa.id = p_assessment_id and sa.deal_id = p_deal_id;
  if a.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  if a.team_mailbox_id is not null and not app_reads_team_mailbox(a.team_mailbox_id, v_actor) then
    raise exception 'not_in_team_audience' using errcode = '42501';
  end if;
  perform discovery_lock_tenant(a.tenant_id);
  insert into corrections (tenant_id, candidate_id, deal_id, actor_id, action, before, after, reason, team_mailbox_id)
  values (a.tenant_id, a.candidate_id, p_deal_id, v_actor, 'dismiss_suggestion',
          jsonb_build_object('stepId', a.step_id), jsonb_build_object('assessmentId', a.id), trim(p_reason), a.team_mailbox_id)
  returning id into v_corr;
  insert into audit_log (tenant_id, actor_id, actor_type, deal_id, action, detail)
  values (a.tenant_id, v_actor, 'user', p_deal_id, 'discovery.correction',
          jsonb_build_object('candidateId', a.candidate_id, 'correctionId', v_corr, 'action', 'dismiss_suggestion'));
  return v_corr;
end; $$;

revoke all on function discovery_dismiss_suggestion(uuid, uuid, text) from public, anon, authenticated;
grant execute on function discovery_dismiss_suggestion(uuid, uuid, text) to authenticated;
