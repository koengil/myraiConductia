-- supabase/migrations/20261023110300_discovery_team_proposal_read.sql
-- G-01 (#173), slice 4 of 5: who reads a team inbox's proposals, and the writer's team branch. Inert: no team source
-- reaches the propose step until slice 5, and not even then while TEAM_PROPOSAL_FIRMS ships empty and no approval row
-- exists, so no team row can be written and none is read. Personal sources are read and written exactly as before.
--
-- 1. app_reads_team_mailbox(p_team_mailbox, p_user) -> boolean   authenticated + service_role, caller-bound
--    The one rule for who reads a team inbox, keyed by the inbox, shared with the next task (G-07 calls it instead of
--    keeping a second copy). It is true only while the inbox is still admitted (an allowed_team_mailboxes row: a
--    refused, removed or disconnected inbox has no reader at all), and then for
--      a reader   an open team_mailbox_members row for the user, who is active, internal, in the inbox's tenant and
--                 firm company, and not a firm admin (the join app_owns_item makes, 20261019160000:117-129); or
--      the CCO    the user's firm_role is 'cco' (active, internal, same tenant), seated in the inbox's own firm company.
--                 A CCO of another company of the tenant reads nothing.
--    Caller-bound like every RLS helper: it answers only about the caller (service_role may ask about anyone), so a
--    signed-in user cannot probe who else reads an inbox.
--
-- 2. app_reads_proposal_source(p_source, p_tenant, p_run, p_user) -> boolean   authenticated + service_role, caller-bound
--    May this user read the rows of one (source, run)? A personal source: its owner, while the mailbox is on the
--    allowlist (app_owns_mailbox_source, unchanged). A team source: only when a pass row exists for (run, source) and
--    app_reads_team_mailbox admits the user. The pass is what makes a row readable, not a live approval: a revoked
--    approval stops new passes and new rows, and rows written under a pass stay readable to the same audience. Rows
--    with no pass (written by a build before #683, or without `begin`) are never readable.
--
-- 3. discovery_model_proposals_select now asks app_reads_proposal_source where it asked app_owns_mailbox_source. The
--    rest of the policy is 20261014120000's: live 'deal' rows only, and a row naming a rules-found candidate only while
--    the reader can see that candidate.
--
-- 4. discovery_record_model_proposal, restated from 20261023110000 (slice 1) with ONE addition: a team source may be
--    written only while the team_proposals approval for the inbox's firm company is live AND the run holds an open
--    pass for the source whose lease has not lapsed (42501 team_not_approved, before anything else is read). This
--    replaces slice 1's outright refusal of every team source. The writer is the fourth place the
--    switch is checked, after the hand-off, begin and renew; it asks the row half only (the TS half is a worker
--    constant the database cannot see). It reads the pass row FOR SHARE, so a write cannot land after the pass is
--    closed: end locks that row FOR UPDATE, and the writer's check is then made again against the closed pass.
--    discovery_proposal_may_name and discovery_proposal_known_deals are NOT restated: slice 1 holds their final bodies.
--
-- The new helpers carry the search path `public, pg_temp`; create or replace keeps the owner and the grants of the writer,
-- which are restated below all the same.
--
-- Reverse: restate the policy with app_owns_mailbox_source(content_source_id, tenant_id, auth.uid()), restate the writer
-- from 20261023110000, and drop the two helpers.

-- ── 1. The inbox-keyed reader test ──────────────────────────────────────────
-- PL/pgSQL, for its plan cache (see app_owns_item, 20261019160000): the proposals policy calls it once per row.
create or replace function app_reads_team_mailbox(p_team_mailbox uuid, p_user uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return coalesce(
    (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
    and exists (
      select 1
      from allowed_team_mailboxes a
      join users u on u.id = p_user and u.tenant_id = a.tenant_id
                  and u.company_id = a.firm_company_id
                  and u.status = 'active' and u.is_external = false
      where a.team_mailbox_id = p_team_mailbox
        and (
          -- the inbox firm's CCO
          u.firm_role = 'cco'
          -- or a reader the firm admin added, still open, who is not a firm admin
          or (u.firm_role is distinct from 'admin'
              and exists (select 1 from team_mailbox_members m
                          where m.team_mailbox_id = a.team_mailbox_id and m.user_id = u.id and m.removed_at is null))
        )),
    false);
end;
$$;
revoke all on function app_reads_team_mailbox(uuid, uuid) from public, anon;
grant execute on function app_reads_team_mailbox(uuid, uuid) to authenticated, service_role;

-- ── 2. The source-and-run reader test ───────────────────────────────────────
create or replace function app_reads_proposal_source(p_source uuid, p_tenant uuid, p_run uuid, p_user uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return coalesce(
    (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
    and (
      -- a personal source: its owner, while the mailbox is allowlisted
      app_owns_mailbox_source(p_source, p_tenant, p_user)
      -- a team source: a pass exists for this run and the user reads the source's inbox
      or exists (
        select 1
        from content_sources c
        join discovery_team_proposal_passes ps on ps.content_source_id = c.id and ps.tenant_id = c.tenant_id
                                              and ps.run_id = p_run
        where c.id = p_source and c.tenant_id = p_tenant and c.kind = 'mailbox' and c.team_mailbox_id is not null
          and app_reads_team_mailbox(c.team_mailbox_id, p_user))
    ),
    false);
end;
$$;
revoke all on function app_reads_proposal_source(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function app_reads_proposal_source(uuid, uuid, uuid, uuid) to authenticated, service_role;

-- ── 3. The read policy ──────────────────────────────────────────────────────
drop policy if exists discovery_model_proposals_select on discovery_model_proposals;
create policy discovery_model_proposals_select on discovery_model_proposals for select to authenticated
  using (outcome = 'deal'
         and archived_at is null
         and app_reads_proposal_source(content_source_id, tenant_id, run_id, auth.uid())
         and (deal_key is null or deal_key like 'm:%' or app_can_see_candidate(candidate_id, auth.uid())));

-- ── 4. The one writer, with the team branch ─────────────────────────────────
-- 20261023110000's body. The one change is the team approval and pass check after the source is found and found to have a reader.
create or replace function discovery_record_model_proposal(p_tenant_id uuid, p_proposal jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id        uuid;
  v_source    uuid := (p_proposal->>'content_source_id')::uuid;
  v_candidate uuid := (p_proposal->>'candidate_id')::uuid;
  v_run       uuid := (p_proposal->>'run_id')::uuid;
  v_cand_tenant uuid;
  v_state     text;
  v_archived  timestamptz;
  v_owner     uuid;
  v_team      uuid;
  v_firm      uuid;
  v_known     boolean;
begin
  select owner_user_id, team_mailbox_id into v_owner, v_team
  from content_sources where id = v_source and tenant_id = p_tenant_id and kind = 'mailbox';
  if not found then
    raise exception 'discovery_record_model_proposal: source not in tenant' using errcode = '22023';
  end if;
  if v_owner is null and v_team is null then
    raise exception 'discovery_record_model_proposal: source has no reader' using errcode = '22023';
  end if;
  if v_team is not null then
    -- A team source is written only while the inbox's firm company holds a live team_proposals approval and this run
    -- holds an open pass for the source. The pass row is read FOR SHARE: end closes it FOR UPDATE, so a write that waits
    -- for a closing pass is refused once the close commits.
    select t.firm_company_id into v_firm from team_mailboxes t where t.id = v_team and t.tenant_id = p_tenant_id;
    if v_firm is null or not app_tenant_capability_on(p_tenant_id, v_firm, 'team_proposals') then
      raise exception 'team_not_approved' using errcode = '42501';
    end if;
    -- The pass must also hold a live lease (review F6): a pass whose lease lapsed is one a later begin or the sweep may
    -- close as unclosed at any moment, so nothing more is written under it.
    perform 1 from discovery_team_proposal_passes ps
    where ps.tenant_id = p_tenant_id and ps.content_source_id = v_source and ps.run_id = v_run and ps.closed_at is null
      and ps.lease_until > now()
    for share;
    if not found then
      raise exception 'team_not_approved' using errcode = '42501';
    end if;
  end if;
  if v_candidate is not null then
    select tenant_id, discovery_state into v_cand_tenant, v_state from deal_candidates where id = v_candidate for share;
    v_known := found;
    if v_known and v_cand_tenant is distinct from p_tenant_id then
      raise exception 'discovery_record_model_proposal: candidate not in tenant' using errcode = '22023';
    end if;
    -- The information barrier on write too (review #509-5): a row the source's readers read may name only a
    -- candidate this source's own mail backs.
    if v_known and not discovery_proposal_may_name(v_source, v_candidate) then
      raise exception 'discovery_record_model_proposal: candidate not visible to the source' using errcode = '22023';
    end if;
    if not v_known or v_state not in ('proposed', 'confirmed') then
      v_archived := now(); -- deleted, rejected or merged since the run read it
    end if;
  end if;
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, sent_at, party_domains,
                                         outcome, deal_key, deal_name, candidate_id, phase, p_deal, p_phase,
                                         model, prompt_version, prompt_hash, response_id, run_id, archived_at)
  select p_tenant_id, v_source, r.message_key, r.item_hash, r.sent_at,
         array(select jsonb_array_elements_text(coalesce(p_proposal->'party_domains', '[]'::jsonb))),
         r.outcome, r.deal_key, r.deal_name, v_candidate, r.phase, r.p_deal, r.p_phase,
         r.model, r.prompt_version, r.prompt_hash, r.response_id, r.run_id, v_archived
  from jsonb_to_record(p_proposal) as r(message_key text, item_hash text, sent_at timestamptz, outcome text,
       deal_key text, deal_name text, phase text, p_deal numeric, p_phase numeric, model text,
       prompt_version text, prompt_hash text, response_id text, run_id uuid)
  on conflict (tenant_id, content_source_id, message_key, prompt_version, model) do update
    set item_hash     = excluded.item_hash,
        sent_at       = excluded.sent_at,
        party_domains = excluded.party_domains,
        outcome       = excluded.outcome,
        deal_key      = excluded.deal_key,
        deal_name     = excluded.deal_name,
        candidate_id  = excluded.candidate_id,
        phase         = excluded.phase,
        p_deal        = excluded.p_deal,
        p_phase       = excluded.p_phase,
        archived_at   = excluded.archived_at,
        prompt_hash   = excluded.prompt_hash,
        response_id   = excluded.response_id,
        run_id        = excluded.run_id,
        updated_at    = now()
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function discovery_record_model_proposal(uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_record_model_proposal(uuid, jsonb) to service_role;
