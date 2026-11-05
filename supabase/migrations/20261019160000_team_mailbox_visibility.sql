-- supabase/migrations/20261019160000_team_mailbox_visibility.sql
-- Admin-managed team inbox (#581), phase 10: the members of a team inbox, and only they, see what
-- discovery found in it.
--
-- Until now a team source stored items that nobody could read: every RLS helper joins the mailbox
-- allowlist on `user_id = content_sources.owner_user_id`, and a team source has no owner. This
-- migration gives the helpers one explicit team branch, and changes nothing else about them.
--
-- A member is owner-equivalent for the team source (design R4): they read its items' text, see its
-- links and milestones, and see the candidates it evidences. Everyone else gets nothing from team
-- provenance, even on a candidate they see through their own mail:
--
--   app_owns_item                    + a third disjunct: the item has provenance in a team source that is in
--                                      allowed_team_mailboxes (the registration checked once), and the viewer is an
--                                      open member of it who is still an active, internal colleague seated in the
--                                      registration's firm and not a firm admin (team_mailbox_readers' own test,
--                                      written against the base tables so the two views are not nested)
--   app_item_has_allowed_source      UNCHANGED, so it stays team-blind. The colleague branch of app_can_see_item
--                                      ("anyone who sees a candidate it evidences, while the item is allowlisted") is
--                                      therefore unchanged too, and it never reaches a team-only item: links,
--                                      milestones and the deal email read reach a team item only through
--                                      app_owns_item, which makes them members-only with no change of their own
--   app_item_cco_allowed_source      NEW: app_item_has_allowed_source, or provenance in an allowed team source. Only
--                                      the control room's branches use it, so the CCO keeps team metadata (never
--                                      text) as it keeps any allowlisted item's (the control-room carve-out,
--                                      thread T8)
--   app_can_see_item                 the CCO branch uses app_item_cco_allowed_source; the owner and colleague
--                                      branches are unchanged
--   app_can_see_candidate            the viewer branch also admits firm or confirmed evidence from a team source the
--                                      viewer reads; the CCO branch uses app_item_cco_allowed_source
--   discovery_refresh_candidate_visibility
--                                    one row per team reader besides one per personal owner, summed when a person is
--                                      both (candidate_visibility has one row per candidate and person)
--   team_mailbox_members_aa_visibility
--                                    an after-row trigger on team_mailbox_members: an addition, a removal, a seat lost
--                                      and a disconnect each refresh the visibility of every candidate the inbox
--                                      evidences, so Add and Remove take effect with no job
--
-- No freshness term anywhere here (design R7, review round 2 M-A). The team half of the allowlist has no
-- clock, so a Pause, a worker outage or a directory blip that leaves the last check older than 65 minutes stops
-- reads (the guard) and never what a member already sees. A definitive refusal still takes the inbox out of
-- allowed_team_mailboxes, and so out of every read below at once; the visibility rows are not rebuilt for it,
-- so a re-verification brings the members' candidates back without waiting for a new candidate event.
--
-- Lock order (design R5, #461's rule): the trigger takes the tenant's discovery lock before it refreshes
-- visibility, and so before the audit row the sibling trigger writes. Triggers of one event fire in name
-- order, and `aa_visibility` sorts ahead of `audit`, so the order is the one discovery_upsert_candidates
-- keeps: lock, refresh visibility, then audit. The member RPCs and the seat-loss trigger already hold the
-- lock when they write (20261019150000); taking it again in the same transaction is free.
--
-- Every definer below pins `search_path = public, pg_temp` (20261016100000): create or replace resets the
-- function's configuration to what it states, so a bare `public` here would undo the convention.
-- Bodies restated from their latest definitions on this base:
--   app_owns_item and app_can_see_candidate     20261001180000_site_allowlist.sql
--   app_can_see_item                            20261001150000_mailbox_allowlist_rls.sql
--   discovery_refresh_candidate_visibility      20260925120000_discovery_core.sql
-- create or replace keeps the grants of the four functions that already exist.

-- ── 1. The control room's test: an allowlisted source, personal or team ─────
-- Internal: called only from the helpers below. Like app_item_has_allowed_source it is the service
-- role's, and the helpers (definers) call it as their owner.
create or replace function app_item_cco_allowed_source(p_item uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app_item_has_allowed_source(p_item)
      or exists (
           select 1 from source_item_sources s
           join source_items si on si.id = s.source_item_id
           join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                                 and c.tenant_id = si.tenant_id and c.team_mailbox_id is not null
           join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                        and a.address = lower(c.address) and a.provider = c.provider
           where s.source_item_id = p_item);
$$;
revoke all on function app_item_cco_allowed_source(uuid) from public, anon, authenticated;
grant execute on function app_item_cco_allowed_source(uuid) to service_role;

-- ── 2. An item's owner: the mailbox owner, the site's registrant, or a team reader ──
-- The first two disjuncts are 20261001180000's, unchanged. The third is the team branch: the item has
-- provenance in a team source of an inbox the allowlist admits, and the viewer is one of its readers. The
-- reader test is team_mailbox_readers' (open member; active, internal, seated in the registration's firm;
-- not a firm admin) against the base tables, with the registration read once through allowed_team_mailboxes,
-- which already requires it open.
--
-- PL/pgSQL, for its plan cache, with the query unchanged. app_can_see_item calls this from inside its own
-- body, and a non-inlined SQL function called that way is planned afresh on every outer call: each call
-- re-expanded allowed_mailboxes and allowed_team_mailboxes, ~10 ms, once per link, so a member's ~2k-link
-- candidate ran past the signed-in statement timeout. PL/pgSQL keeps the statement's plan for the session,
-- whoever calls it.
create or replace function app_owns_item(p_item uuid, p_user uuid)
returns boolean language plpgsql security definer stable set search_path = public, pg_temp as $$
begin
  return (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and (
       exists (
         select 1
         from source_item_sources s
         join source_items si on si.id = s.source_item_id
         join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                               and c.tenant_id = si.tenant_id
         join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
         join allowed_mailboxes a on a.tenant_id = c.tenant_id
                                 and a.address = lower(c.address)
                                 and a.user_id = c.owner_user_id
                                 and a.provider = c.provider
         where s.source_item_id = p_item and c.owner_user_id = p_user)
       or exists (
         select 1
         from source_item_sources s
         join source_items si on si.id = s.source_item_id
         join content_sources c on c.id = s.content_source_id and c.kind = 'sharepoint_site'
                               and c.tenant_id = si.tenant_id
         join allowed_sites a on a.tenant_id = c.tenant_id and a.address = lower(c.address)
                             and a.registered_by = p_user
         where s.source_item_id = p_item and app_is_firm_admin(c.tenant_id, p_user))
       or exists (
         select 1
         from source_item_sources s
         join source_items si on si.id = s.source_item_id
         join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                               and c.tenant_id = si.tenant_id and c.team_mailbox_id is not null
         join allowed_team_mailboxes a on a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                      and a.address = lower(c.address) and a.provider = c.provider
         join team_mailbox_members m on m.team_mailbox_id = a.team_mailbox_id
                                    and m.user_id = p_user and m.removed_at is null
         join users ru on ru.id = m.user_id and ru.tenant_id = a.tenant_id
                      and ru.company_id = a.firm_company_id
                      and ru.status = 'active' and ru.is_external = false
                      and ru.firm_role is distinct from 'admin'
         where s.source_item_id = p_item)
     );
end;
$$;

-- ── 3. A candidate: through a visibility row while evidence of the viewer's own, or of a team inbox they read, backs it ──
-- 20261001180000's body. The viewer branch gains a second kind of backing evidence (team provenance the
-- viewer reads, with the same firm or confirmed, unrejected test as the personal one), and the CCO branch
-- asks app_item_cco_allowed_source where it asked app_item_has_allowed_source. `u` is the viewer's row,
-- already tenant-matched to the candidate by the outer join.
--
-- The two kinds of backing evidence are asked in ONE scan of the candidate's links, which stops at the first
-- link the viewer reads either way. The evidence_links policy calls this once per link, so two separate scans
-- made a viewer the first one fails (a team reader with no mailbox of their own on the candidate) walk every
-- link per row: quadratic, past the signed-in statement timeout at ~2k links. Asked together, each kind keeps
-- its own conditions (the personal one is 20261001180000's join, as predicates), and the scan stops early for
-- any viewer either kind backs.
create or replace function app_can_see_candidate(p_candidate uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public, pg_temp as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1 from deal_candidates dc
       join users u on u.id = p_user and u.tenant_id = dc.tenant_id
       where dc.id = p_candidate
         and (
           (exists (select 1 from candidate_visibility v where v.candidate_id = dc.id and v.person_id = p_user)
            and exists (
              select 1
              from evidence_links l
              join source_items si on si.id = l.source_item_id and si.tenant_id = dc.tenant_id
              join source_item_sources s on s.source_item_id = si.id
              join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                                    and c.tenant_id = dc.tenant_id
              where l.candidate_id = dc.id and l.state <> 'rejected'
                and (l.route_tier = 'firm' or l.state = 'confirmed')
                and (
                  -- the viewer's own mailbox, on the allowlist
                  (c.owner_user_id = p_user
                   and exists (select 1 from allowed_mailboxes a
                               where a.tenant_id = c.tenant_id and a.address = lower(c.address)
                                 and a.user_id = p_user and a.provider = c.provider))
                  -- a team inbox the allowlist admits and the viewer reads
                  or (c.team_mailbox_id is not null
                      and u.status = 'active' and u.is_external = false
                      and u.firm_role is distinct from 'admin'
                      and exists (select 1 from allowed_team_mailboxes a
                                  join team_mailbox_members m on m.team_mailbox_id = a.team_mailbox_id
                                                             and m.user_id = p_user and m.removed_at is null
                                  where a.team_mailbox_id = c.team_mailbox_id and a.tenant_id = c.tenant_id
                                    and a.address = lower(c.address) and a.provider = c.provider
                                    and a.firm_company_id = u.company_id)))))
           or (app_is_firm_cco(dc.tenant_id, p_user)
               and (app_mailbox_retained_for_control_room(dc.tenant_id, p_user)
                    or exists (select 1 from evidence_links l
                               join source_items si on si.id = l.source_item_id and si.tenant_id = dc.tenant_id
                               where l.candidate_id = dc.id and app_item_cco_allowed_source(si.id))))
         )
     );
$$;

-- ── 4. An item's metadata: its owners; the control room; anyone who sees a candidate it evidences ──
-- 20261001150000's body with the CCO branch asking app_item_cco_allowed_source. The owner branch is
-- app_owns_item (so a team reader is included through section 2), and the colleague branch is unchanged: it asks
-- the team-blind app_item_has_allowed_source, so it never admits a team-only item to someone who is not a reader.
create or replace function app_can_see_item(p_item uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public, pg_temp as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and (
       app_owns_item(p_item, p_user)
       or exists (
         select 1 from source_items si
         where si.id = p_item
           and app_is_firm_cco(si.tenant_id, p_user)
           and (app_mailbox_retained_for_control_room(si.tenant_id, p_user) or app_item_cco_allowed_source(si.id))
       )
       or (app_item_has_allowed_source(p_item) and exists (
         select 1 from evidence_links l
         where l.source_item_id = p_item
           and l.candidate_id is not null
           and l.state <> 'rejected'
           and (l.route_tier = 'firm' or l.state = 'confirmed')
           and app_can_see_candidate(l.candidate_id, p_user)
       ))
     );
$$;

-- ── 5. Candidate visibility: one row per personal owner and per team reader ─
-- discovery_core's body. Each owner of a firm or confirmed, unrejected item, in the candidate's tenant, gets
-- a row with a count of their items; so does each reader of a team inbox that holds one. The two are
-- unioned before the count, so a person who both owns a personal copy and reads the team one gets one row
-- (the primary key is (candidate, person)) counting each item once. The team side reads team_mailbox_readers
-- and not allowed_team_mailboxes: the rows are an index, app_can_see_candidate judges the allowlist at read
-- time, and an inbox refused for a while must find its members' rows still there when it is verified again.
create or replace function discovery_refresh_candidate_visibility(p_candidate_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from candidate_visibility where candidate_id = p_candidate_id;

  insert into candidate_visibility (candidate_id, person_id, source_item_count)
  select p.candidate_id, p.person_id, count(distinct p.source_item_id)::integer
  from (
    select l.candidate_id, l.source_item_id, c.owner_user_id as person_id
    from evidence_links l
    join deal_candidates dc on dc.id = l.candidate_id
    join source_item_sources s on s.source_item_id = l.source_item_id
    join content_sources c on c.id = s.content_source_id and c.tenant_id = dc.tenant_id
    join users u on u.id = c.owner_user_id and u.tenant_id = dc.tenant_id
    where l.candidate_id = p_candidate_id
      and l.state <> 'rejected'
      and (l.route_tier = 'firm' or l.state = 'confirmed')
    union all
    select l.candidate_id, l.source_item_id, r.user_id as person_id
    from evidence_links l
    join deal_candidates dc on dc.id = l.candidate_id
    join source_item_sources s on s.source_item_id = l.source_item_id
    join content_sources c on c.id = s.content_source_id and c.tenant_id = dc.tenant_id
                          and c.team_mailbox_id is not null
    join team_mailbox_readers r on r.team_mailbox_id = c.team_mailbox_id and r.tenant_id = dc.tenant_id
    where l.candidate_id = p_candidate_id
      and l.state <> 'rejected'
      and (l.route_tier = 'firm' or l.state = 'confirmed')
  ) p
  group by p.candidate_id, p.person_id;
end;
$$;

-- ── 6. A membership change refreshes the inbox's candidates ─────────────────
-- Fires for the four writers of membership: the add RPC (an insert), the remove RPC, the seat-loss trigger
-- and Remove of an inbox (each an update that closes the row). The tenant's discovery lock comes first, then
-- one refresh per candidate the inbox evidences, in id order. A reader's visibility rows are an index over
-- evidence, and the helpers above judge membership at read time too, so a removal is effective at once even
-- for a row the refresh has not yet reached; the refresh keeps the index, and what candidate_visibility
-- shows the control room, honest.
create or replace function team_mailbox_members_refresh_visibility()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_cand   uuid;
begin
  -- (OLD exists for an update only; the audit trigger keeps the same shape.)
  if tg_op = 'UPDATE' then
    if old.removed_at is not distinct from new.removed_at then
      return null;
    end if;
  end if;
  select tm.tenant_id into v_tenant from team_mailboxes tm where tm.id = new.team_mailbox_id;
  perform discovery_lock_tenant(v_tenant);
  for v_cand in
    select distinct l.candidate_id
    from content_sources c
    join source_item_sources s on s.content_source_id = c.id
    join evidence_links l on l.source_item_id = s.source_item_id and l.candidate_id is not null
    where c.team_mailbox_id = new.team_mailbox_id
    order by l.candidate_id
  loop
    perform discovery_refresh_candidate_visibility(v_cand);
  end loop;
  return null;
end;
$$;
revoke all on function team_mailbox_members_refresh_visibility() from public, anon, authenticated;
-- Named to fire ahead of team_mailbox_members_audit (same event, name order): lock, refresh, then audit.
drop trigger if exists team_mailbox_members_aa_visibility on team_mailbox_members;
create trigger team_mailbox_members_aa_visibility
  after insert or update of removed_at on team_mailbox_members
  for each row execute function team_mailbox_members_refresh_visibility();

-- ── 7. RLS cost at a member's scale (audit item 5) ──────────────────────────
-- A member's candidate can hold thousands of links, and the evidence_links policy judged the
-- candidate once per link. Two changes, neither of which changes what anyone sees:
--   - app_visible_candidate_ids(): the candidates the caller sees, asked once per statement. The
--     policy below tests membership in that set instead of calling app_can_see_candidate per row.
--     It is app_can_see_candidate itself, over the caller's own tenant's candidates (the helper
--     admits no candidate of another tenant), so the two answer the same by construction.
--   - expression indexes for the person tests allowed_team_mailboxes makes per evaluation (a user's
--     or an invite's address is the team address), which were sequential scans of lower(email).
create index if not exists users_lower_email_idx on users (lower(email));
create index if not exists invites_tenant_lower_email_idx on invites (tenant_id, lower(email));

create or replace function app_visible_candidate_ids()
returns setof uuid language sql stable security definer set search_path = public, pg_temp as $$
  select dc.id
  from deal_candidates dc
  join users u on u.id = auth.uid() and u.tenant_id = dc.tenant_id
  where app_can_see_candidate(dc.id, auth.uid());
$$;
revoke all on function app_visible_candidate_ids() from public, anon;
grant execute on function app_visible_candidate_ids() to authenticated, service_role;

-- 20261001150000_mailbox_allowlist_rls.sql's policy with the one change: the candidate test is the
-- set above, evaluated once per statement, not app_can_see_candidate once per link.
drop policy if exists evidence_links_select on evidence_links;
create policy evidence_links_select on evidence_links for select to authenticated
  using (
    candidate_id is not null
    and candidate_id in (select app_visible_candidate_ids())
    and app_can_see_item(source_item_id, auth.uid())
    and (
      (state <> 'rejected' and (route_tier = 'firm' or state = 'confirmed'))
      or app_owns_item(source_item_id, auth.uid())
      or app_is_control_room(auth.uid())
    )
  );
