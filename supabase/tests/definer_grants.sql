-- #233: the publishable key must not reach SECURITY DEFINER functions, and
-- authenticated may execute only the allowlisted ones the calling role
-- genuinely needs (the RLS helpers its policies call, the two invite
-- functions called with the user's session, and the discovery ingestion
-- health view, re-granted by 20260929180000). Tables that RLS closes by having
-- no policy must hold no anon/authenticated grant either: TRUNCATE ignores RLS.
-- Catalog reads only; nothing here calls a function.
do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1)
    into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'SECURITY DEFINER functions executable by anon: %', v_bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1)
    into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname <> all (array[
      'app_is_overseer', 'app_user_tenant', 'app_user_company',
      'app_is_deal_member', 'app_is_deal_md', 'app_user_is_director',
      'app_has_company_permission', 'app_company_is_access_root',
      'app_is_control_room', 'app_owns_item', 'app_can_see_candidate',
      'app_can_see_item', 'app_is_deal_overseer', 'app_user_is_external',
      'app_actor_in_user_tenant', 'accept_invite', 'verify_invite_challenge',
      -- #243: refuses anyone but a firm admin or the control room of the
      -- caller's own tenant; re-granted by 20260929180000.
      'discovery_ingestion_health',
      -- #262: called with the member's or firm admin's own session; each acts
      -- on auth.uid() and checks the caller's role and seat itself. They are
      -- created after 20260929170000, so their grants live in the #262
      -- migrations (20261001130000, 20261001140000, 20261001160000,
      -- 20261001180000), not in that migration's grant list.
      'mailbox_consent_grant', 'mailbox_consent_withdraw', 'mailbox_consent_status',
      'discovery_allowlist_health',
      'site_register', 'site_unregister', 'discovery_site_registrations',
      -- #262 round 3: a firm admin merges an archived mailbox source into the live one
      -- (checks the caller's role and tenant itself; 20261001130000).
      'discovery_unify_mailbox_sources',
      -- Deal discovery corrections (20261002210000_discovery_corrections.sql):
      -- called with the banker's own session. Each acts on auth.uid() (none
      -- takes an actor argument) and checks tenant, candidate visibility and
      -- deal-create authority itself, answering 42501 or P0002 otherwise.
      'discovery_rename_candidate', 'discovery_reject_candidate', 'discovery_set_station',
      'discovery_merge_candidates', 'discovery_correction_authority',
      -- Split and reassign (20261002230000_discovery_split_reassign.sql): the same
      -- contract. Each acts on auth.uid(), takes no actor argument, and checks
      -- tenant, candidate visibility and deal-create authority itself.
      'discovery_split_candidate', 'discovery_reassign_link',
      -- Promotion (20261002220000_discovery_promotion.sql): the MD dismisses the
      -- rail's evidence marker on their own session. It acts on auth.uid() and
      -- answers 42501 to anyone who is not the deal's MD. discovery_promote_candidate
      -- is deliberately NOT here: it is service_role only, like create_deal_gate0
      -- (#262 review, E3), and the next block asserts it.
      'discovery_dismiss_suggestion',
      -- #259 phase 4 (20261002181000_discovery_google_connect.sql): reads
      -- auth.uid(); returns the caller's own Google mailbox state or refuses
      -- 42501. The pause and resume RPC also requires the source's own firm admin.
      -- There is no connect RPC: the opt-in is #262's mailbox_consent_grant.
      'discovery_google_mailbox_status', 'discovery_set_mailbox_source_status',
      -- #353's first-read window (20261018110000), restated by #581 (20261019110000): the source's own
      -- firm admin, acting on auth.uid() (supabase/tests/team_mailboxes.sql covers the team branch).
      'discovery_set_mailbox_source_window',
      -- Reader liveness (20261008210000_discovery_restart_source.sql): the source's own firm admin
      -- restarts a halted mailbox source (supabase/tests/discovery_google.sql).
      'discovery_restart_mailbox_source',
      -- Admin-managed team inbox (#581, 20261019100000 and 20261019120000_team_mailbox_list.sql): the firm
      -- admin's connect, list and Remove, each acting on auth.uid() and checking the firm admin itself
      -- (supabase/tests/team_mailboxes.sql).
      'discovery_connect_team_mailbox', 'discovery_team_mailboxes', 'discovery_remove_team_mailbox',
      -- ... and the admin's add and remove of a member (20261019150000_team_mailbox_members.sql), the same contract.
      'discovery_add_team_mailbox_member', 'discovery_remove_team_mailbox_member',
      -- #173 G-03 (20261023100300_team_mailbox_audit_read.sql): the firm's admin and CCO read their own firm
      -- company's team inbox audit rows. Acts on auth.uid() only, refuses 42501 unless the caller is an active,
      -- internal admin or CCO seated in a firm company that holds a team inbox, and returns ids and fixed codes
      -- (supabase/tests/team_mailbox_audit.sql).
      'discovery_team_mailbox_audit',
      -- #320 (20261002100000_work_identity_onboarding.sql): app_caller_live is
      -- the RLS liveness helper (the caller's own profile and auth.sessions row);
      -- the work-identity RPCs read auth.uid(), refuse a caller whose session is
      -- not live, and act only on that caller's own invite and identity.
      'app_caller_live',
      -- 20261017100000_source_items_column_wall.sql: the owner's read of the walled
      -- source_items columns. Acts on auth.uid() only, returns the rows
      -- app_can_see_item admits, and nulls subject and participants unless app_owns_item.
      'discovery_item_metadata',
      -- 20261021141000_discovery_own_mailbox_items.sql: which of the given items came from
      -- the caller's own connected mailbox, and its address. Acts on auth.uid() only
      -- (owner_user_id = auth.uid()), so it names nothing the caller does not own.
      'discovery_own_mailbox_items',
      -- 20261023130400_discovery_current_events.sql (#173 G-07): which of the given items' milestone events are
      -- current, by the rule the stage engine uses. Acts on auth.uid() only, answers only the items
      -- app_can_see_item admits for the caller, and returns ids and a basis, never text.
      'discovery_item_current_events',
      -- 20261023130500_discovery_item_team_access.sql (#173 G-07): which of the given items the caller reads only
      -- through a team inbox they are a member of. Acts on auth.uid() only, answers only the items app_can_see_item
      -- admits for the caller, and returns ids and a flag, never text.
      'discovery_item_team_access',
      'accept_work_identity_invite',
      'begin_work_identity_connect', 'complete_work_identity_connect',
      -- Demo only (#460, 20261014120000_discovery_model_proposals.sql): the RLS
      -- helper of discovery_model_proposals' select policy. Answers only about
      -- the caller (supabase/tests/discovery_model_proposals.sql).
      'app_owns_mailbox_source',
      -- G-01 #173 (20261023110300_discovery_team_proposal_read.sql): the RLS helpers of the same table's select
      -- policy for a team inbox. Caller-bound like app_owns_mailbox_source (service_role, or p_user = auth.uid()), so
      -- each answers only about the caller; app_reads_team_mailbox is the one inbox-keyed reader rule (G-07 calls it too)
      -- and app_reads_proposal_source adds the source-to-inbox lookup and the pass requirement. Both return a boolean.
      'app_reads_team_mailbox', 'app_reads_proposal_source',
      -- #581 audit item 5 (20261019160000_team_mailbox_visibility.sql): the candidates the caller
      -- sees, app_can_see_candidate over the caller's own tenant, for the evidence_links policy.
      'app_visible_candidate_ids',
      -- #670 (20261021160000_member_deal_email_owned_set.sql): the caller's own item ids, app_owns_item
      -- over the caller's owned sources, for the evidence_links policy. No argument; returns only items
      -- the caller already reads.
      'app_owned_item_ids',
      -- G-02a (#173, 20261023120100_model_proposal_dismissals.sql): the source owner dismisses a model
      -- proposal on their own session. Acts on auth.uid() only (no actor argument), and writes only for live
      -- rows the caller reads (app_can_read_model_proposal) on a personal source the caller owns; P0002 otherwise.
      'discovery_dismiss_model_proposal',
      -- G-02b (#173, 20261023140100_model_proposal_accepts.sql): the source owner asks to accept a model-only proposal
      -- on their own session. Acts on auth.uid() only (no actor argument); it needs the tenant bank's deal-create
      -- authority and writes only for live rows the caller reads (app_can_read_model_proposal) on a personal source the
      -- caller owns, no dismissal covering them; P0002 otherwise. It stores a request and an audit row, nothing else.
      'discovery_accept_model_proposal',
      -- G-02b (#173, 20261023140400_discovery_origin_read.sql): where a candidate or a deal came from, read past RLS so a
      -- deal member or overseer who is not the finder still gets the model-origin pop-up. Each acts on auth.uid() only
      -- (no actor argument), answers only for a candidate the caller sees or whose deal they sit on or oversee, and
      -- returns the words 'model_proposal' or 'rules' (the batch also the candidate id asked about), never a cluster key.
      'discovery_candidate_origins', 'discovery_deal_origin'
    ]);
  if v_bad is not null then
    raise exception
      'SECURITY DEFINER functions executable by authenticated but not allowlisted '
      '(add them to 20260929170000 and this probe only if the browser role must call them): %',
      v_bad;
  end if;

  select string_agg(c.oid::regclass::text, ', ' order by 1)
    into v_bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind = 'r'
    and (
      (c.relrowsecurity and not exists (select 1 from pg_policy p where p.polrelid = c.oid))
      or c.oid = 'public.legal_holds'::regclass
    )
    and (
      has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
      or has_table_privilege('authenticated', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
    );
  if v_bad is not null then
    raise exception 'Policy-less tables still granted to anon/authenticated: %', v_bad;
  end if;
end
$$;

-- The extractor's twelve service-role functions (20261002200000, 20261010120000, 20261021190000, 20261023130100). The batch is
-- the one service-role read of stored mail text (ADR-0017 decision 1), so it
-- stays out of the authenticated allowlist above and is granted to service_role
-- alone (as are discovery_assessment_inputs, the narrowed read of milestone events, and discovery_audience_assessment_inputs, its audience-tagged form (#173 G-07), the estimate's pending and stats, which return byte lengths only, the budget's open and state, which return ids and numbers only, its reserve and settle, which return a code or nothing, and its ceiling formula): no anon, no authenticated, and no PUBLIC grant behind either.
do $$
declare
  v_bad text;
  v_found integer;
begin
  select count(*) into v_found
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_extract_batch', 'discovery_record_extraction', 'discovery_record_assessment', 'discovery_assessment_inputs', 'discovery_audience_assessment_inputs', 'discovery_extract_pending', 'discovery_extract_stats', 'discovery_extract_budget_open', 'discovery_extract_budget_state', 'discovery_extract_ceiling_usd', 'discovery_extract_reserve', 'discovery_extract_settle');
  if v_found <> 12 then
    raise exception 'expected the twelve extractor functions, found %', v_found;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_extract_batch', 'discovery_record_extraction', 'discovery_record_assessment', 'discovery_assessment_inputs', 'discovery_audience_assessment_inputs', 'discovery_extract_pending', 'discovery_extract_stats', 'discovery_extract_budget_open', 'discovery_extract_budget_state', 'discovery_extract_ceiling_usd', 'discovery_extract_reserve', 'discovery_extract_settle')
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'extractor functions executable by anon, authenticated or PUBLIC: %', v_bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_extract_batch', 'discovery_record_extraction', 'discovery_record_assessment', 'discovery_assessment_inputs', 'discovery_audience_assessment_inputs', 'discovery_extract_pending', 'discovery_extract_stats', 'discovery_extract_budget_open', 'discovery_extract_budget_state', 'discovery_extract_ceiling_usd', 'discovery_extract_reserve', 'discovery_extract_settle')
    and not has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'extractor functions not executable by service_role: %', v_bad;
  end if;

  -- #173 G-07 slice 1a (20261023130100): the assessment writer takes an audience, so its one identity is the
  -- five-argument one, held to service_role by the three checks above. The four-argument identity is gone: a
  -- leftover overload would be an unlocked writer that ignores the audience.
  if to_regprocedure('public.discovery_record_assessment(uuid, uuid, jsonb, text, uuid)') is null then
    raise exception 'discovery_record_assessment(uuid, uuid, jsonb, text, uuid) is not defined';
  end if;
  if to_regprocedure('public.discovery_record_assessment(uuid, uuid, jsonb, text)') is not null then
    raise exception 'the four-argument discovery_record_assessment is still defined';
  end if;

  -- The budget tables (#261, 20261021190000): ids and numbers, service role only, RLS on, no policy. A
  -- signed-in role may neither read nor write them.
  select string_agg(t, ', ') into v_bad from unnest(array['discovery_extract_budgets', 'discovery_extract_budget_items']) t
   where has_table_privilege('anon', t, 'SELECT') or has_table_privilege('authenticated', t, 'SELECT')
      or has_table_privilege('anon', t, 'INSERT') or has_table_privilege('authenticated', t, 'INSERT')
      or has_table_privilege('anon', t, 'UPDATE') or has_table_privilege('authenticated', t, 'UPDATE')
      or has_table_privilege('anon', t, 'DELETE') or has_table_privilege('authenticated', t, 'DELETE')
      or not (select relrowsecurity from pg_class where oid = t::regclass);
  if v_bad is not null then
    raise exception 'budget tables reachable by signed-in roles or without RLS: %', v_bad;
  end if;
  -- The run sets and clears a cohort row's reservation only through discovery_extract_reserve and
  -- discovery_extract_settle: no update on any column, and no delete.
  if has_table_privilege('service_role', 'discovery_extract_budget_items', 'UPDATE')
     or has_table_privilege('service_role', 'discovery_extract_budget_items', 'DELETE')
     or has_column_privilege('service_role', 'discovery_extract_budget_items', 'inflight_since', 'UPDATE')
     or has_column_privilege('service_role', 'discovery_extract_budget_items', 'ceiling_usd', 'UPDATE') then
    raise exception 'service_role may not update or delete discovery_extract_budget_items';
  end if;
end
$$;

-- The promotion definer (20261002220000): service_role alone, never the signed-in
-- role. The route passes the verified session user as p_actor_id, so a browser that
-- could call it directly could name any actor (#262 review, E3).
do $$
declare
  v_found integer;
  v_bad text;
begin
  select count(*) into v_found
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_promote_candidate';
  if v_found <> 1 then
    raise exception 'expected one discovery_promote_candidate, found %', v_found;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'discovery_promote_candidate'
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'discovery_promote_candidate executable by anon, authenticated or PUBLIC: %', v_bad;
  end if;

  if not exists (select 1 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_promote_candidate'
                   and has_function_privilege('service_role', p.oid, 'EXECUTE')) then
    raise exception 'discovery_promote_candidate not executable by service_role';
  end if;
end
$$;

-- The purge definers (#461, 20261014120500_discovery_purge.sql and
-- 20261014130000_discovery_purge_wiring.sql). They delete stored mail: the
-- collector, the worker's backstop and the group-removal withdrawal are
-- service_role alone; the per-consent purge, the identifier delete it calls and
-- the trigger function run only from the mailbox_consents trigger, so nobody
-- holds EXECUTE on them, the service role included. No anon, no authenticated,
-- no PUBLIC grant.
do $$
declare
  v_found integer;
  v_bad text;
begin
  select count(*) into v_found
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_collect_orphans', 'discovery_purge_identifiers', 'discovery_purge_mailbox',
                      'mailbox_consents_purge', 'discovery_collect_orphans_all',
                      'discovery_withdraw_group_removed');
  if v_found <> 6 then
    raise exception 'expected the six purge functions, found %', v_found;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_collect_orphans', 'discovery_purge_identifiers', 'discovery_purge_mailbox',
                      'mailbox_consents_purge', 'discovery_collect_orphans_all',
                      'discovery_withdraw_group_removed')
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'purge functions not definers, or executable by anon, authenticated or PUBLIC: %', v_bad;
  end if;

  select string_agg(n, ', ' order by n) into v_bad
  from unnest(array['discovery_collect_orphans', 'discovery_collect_orphans_all', 'discovery_withdraw_group_removed']) n
  where not exists (select 1 from pg_proc p
                    where p.pronamespace = 'public'::regnamespace and p.proname = n
                      and has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if v_bad is not null then
    raise exception 'purge functions not executable by service_role: %', v_bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_purge_identifiers', 'discovery_purge_mailbox', 'mailbox_consents_purge')
    and has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_bad is not null then
    raise exception 'trigger-only purge functions executable by service_role: %', v_bad;
  end if;
end
$$;

-- The tenant purge (#461, 20261014140000_discovery_purge_tenant.sql): a definer
-- no role may execute, the service role included: the operator script runs it
-- as its owner. Its site-count helper is not
-- a definer and nobody holds EXECUTE on it, the service role included: only
-- the purge, as its owner, calls it.
do $$
begin
  if not exists (select 1 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_purge_tenant'
                   and p.prosecdef
                   and not has_function_privilege('service_role', p.oid, 'EXECUTE')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'discovery_purge_tenant must be a definer executable by its owner alone';
  end if;
  if not exists (select 1 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_tenant_site_counts'
                   and not has_function_privilege('service_role', p.oid, 'EXECUTE')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not has_function_privilege('authenticated', p.oid, 'EXECUTE')) then
    raise exception 'discovery_tenant_site_counts must be executable by nobody but its owner';
  end if;
end
$$;

-- The message index (#461, 20261014150000_discovery_message_index.sql): its
-- writer and its link refresh are definers the worker runs as service_role alone.
do $$
declare
  v_bad text;
begin
  select string_agg(n, ', ' order by n) into v_bad
  from unnest(array['discovery_message_index_link', 'discovery_message_index_record']) n
  where not exists (select 1 from pg_proc p
                    where p.pronamespace = 'public'::regnamespace and p.proname = n and p.prosecdef
                      and has_function_privilege('service_role', p.oid, 'EXECUTE')
                      and not has_function_privilege('anon', p.oid, 'EXECUTE')
                      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'message index functions must be definers executable by service_role alone: %', v_bad;
  end if;
end
$$;

-- The team inbox RPCs (#581, 20261019100000_team_mailboxes.sql, 20261019120000_team_mailbox_list.sql,
-- 20261019150000_team_mailbox_members.sql): definers that act on auth.uid() and check the firm admin themselves. Each is executable by
-- authenticated (and so listed in the allowlist above) and by neither anon nor PUBLIC. Their
-- trigger functions are never called by a role. The firm's audit read (#173, 20261023100300) holds the same ACL.
do $$
declare
  v_bad text;
begin
  select string_agg(n, ', ' order by n) into v_bad
  from unnest(array['discovery_connect_team_mailbox', 'discovery_team_mailboxes', 'discovery_remove_team_mailbox',
                    'discovery_add_team_mailbox_member', 'discovery_remove_team_mailbox_member',
                    'discovery_team_mailbox_audit']) n
  where not exists (select 1 from pg_proc p
                    where p.pronamespace = 'public'::regnamespace and p.proname = n and p.prosecdef
                      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      and not has_function_privilege('anon', p.oid, 'EXECUTE')
                      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the team inbox RPCs must be definers executable by authenticated and by neither anon nor PUBLIC: %', v_bad;
  end if;
  if exists (select 1 from pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and p.proname in ('team_mailboxes_guard', 'content_sources_team_fixed', 'team_mailbox_members_guard',
                                 'team_mailbox_members_audit', 'team_mailbox_members_close_on_seat_loss',
                                 'team_mailbox_members_refresh_visibility')
               and (has_function_privilege('anon', p.oid, 'EXECUTE')
                 or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) then
    raise exception 'the team mailbox trigger functions must not be executable by anon, authenticated or PUBLIC';
  end if;
end
$$;

-- The current-events rule (#173 G-07 slice 2a, 20261023130400_discovery_current_events.sql): the rule itself and
-- its firm-approval test are definers the inputs and the read call as their owner, so the service role alone may
-- execute them; the signed-in read is in the allowlist above and is closed to anon and PUBLIC.
do $$
declare
  v_bad text;
begin
  select string_agg(n, ', ' order by n) into v_bad
  from unnest(array['discovery_current_event_ids', 'discovery_rule_firm_ok',
                     -- The rule detector's definers (#173 G-07 slice 3b, 20261023130600): the same shape.
                     'discovery_detect_batch', 'discovery_item_approved_teams', 'discovery_record_detection',
                     'discovery_record_team_detection_pass']) n
  where not exists (select 1 from pg_proc p
                    where p.pronamespace = 'public'::regnamespace and p.proname = n and p.prosecdef
                      and has_function_privilege('service_role', p.oid, 'EXECUTE')
                      and not has_function_privilege('anon', p.oid, 'EXECUTE')
                      and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                      where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the current-events rule must be definers executable by service_role alone: %', v_bad;
  end if;
  -- The rule detector's ledger (#173 G-07 slice 3b): RLS on, no policy, nobody signed in reads or writes it, and the
  -- service role only reads it (the writer is a definer).
  if not (select relrowsecurity from pg_class where oid = 'public.milestone_detections'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'milestone_detections')
     or has_table_privilege('anon', 'milestone_detections', 'SELECT') or has_table_privilege('authenticated', 'milestone_detections', 'SELECT')
     or has_table_privilege('service_role', 'milestone_detections', 'INSERT') or has_table_privilege('service_role', 'milestone_detections', 'UPDATE')
     or has_table_privilege('service_role', 'milestone_detections', 'DELETE')
     or not has_table_privilege('service_role', 'milestone_detections', 'SELECT') then
    raise exception 'milestone_detections must have RLS on, no policy, no signed-in access and a read-only service role';
  end if;
  if not exists (select 1 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_item_current_events' and p.prosecdef
                   and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'discovery_item_current_events must be a definer executable by authenticated and by neither anon nor PUBLIC';
  end if;
  -- The team-access read (#173 G-07 slice 2b, 20261023130500): the same shape.
  if not exists (select 1 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_item_team_access' and p.prosecdef
                   and has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   and not has_function_privilege('anon', p.oid, 'EXECUTE')
                   and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'discovery_item_team_access must be a definer executable by authenticated and by neither anon nor PUBLIC';
  end if;
end
$$;

-- The control room's allowlist test (#581, 20261019160000_team_mailbox_visibility.sql): internal to the RLS helpers, which
-- are definers and call it as their owner, so a signed-in role never needs it. Service role alone, like
-- app_item_has_allowed_source: a definer, no anon, no authenticated, no PUBLIC grant behind either.
do $$
declare
  v_bad text;
begin
  if not exists (select 1 from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and p.proname = 'app_item_cco_allowed_source') then
    raise exception 'expected app_item_cco_allowed_source';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'app_item_cco_allowed_source'
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'app_item_cco_allowed_source must be a definer executable by service_role alone: %', v_bad;
  end if;
end
$$;

-- The propose step's barrier test (G-01 #173, 20261023110000_discovery_proposal_own_source.sql): whether one source
-- may name one candidate. Called by the known-deals read and the proposal writer (both service_role, both definers,
-- which call it as their owner), so a signed-in role never needs it: a definer, no anon, no authenticated, no PUBLIC
-- grant behind either, and service_role may run it.
do $$
declare
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_proposal_may_name') <> 1 then
    raise exception 'expected one discovery_proposal_may_name';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'discovery_proposal_may_name'
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'discovery_proposal_may_name must be a definer executable by service_role alone: %', v_bad;
  end if;
end
$$;

-- The shared tenant approvals (G-01 #173, 20261023110100_discovery_tenant_approvals.sql): the one SQL reader is a
-- definer the worker and the later slices run as service_role alone (no anon, no authenticated, no PUBLIC grant behind
-- either); its three trigger functions are never called by a role. The table is RLS-closed with no policy: the worker
-- may read it, and no API role may write it (every write is a reviewed migration).
do $$
declare
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'app_tenant_capability_on') <> 1 then
    raise exception 'expected one app_tenant_capability_on';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'app_tenant_capability_on'
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'app_tenant_capability_on must be a definer executable by service_role alone: %', v_bad;
  end if;

  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('discovery_tenant_approvals_guard', 'discovery_tenant_approvals_audit',
                          'discovery_tenant_approvals_refuse_delete')) <> 3 then
    raise exception 'expected the three tenant approval trigger functions';
  end if;
  if exists (select 1 from pg_proc p
             where p.pronamespace = 'public'::regnamespace
               and p.proname in ('discovery_tenant_approvals_guard', 'discovery_tenant_approvals_audit',
                                 'discovery_tenant_approvals_refuse_delete')
               and (has_function_privilege('anon', p.oid, 'EXECUTE')
                 or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                 or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            where a.grantee = 0 and a.privilege_type = 'EXECUTE'))) then
    raise exception 'the tenant approval trigger functions must not be executable by anon, authenticated or PUBLIC';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.discovery_tenant_approvals'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.discovery_tenant_approvals'::regclass) then
    raise exception 'discovery_tenant_approvals must have RLS on and no policy';
  end if;
  if not has_table_privilege('service_role', 'public.discovery_tenant_approvals', 'SELECT')
     or has_table_privilege('service_role', 'public.discovery_tenant_approvals', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('anon', 'public.discovery_tenant_approvals', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('authenticated', 'public.discovery_tenant_approvals', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 'discovery_tenant_approvals: service_role reads, and no API role writes';
  end if;
end
$$;

-- The team inbox pass (G-01 #173, 20261023110200_discovery_team_proposal_pass.sql): begin, renew, end and the
-- lapsed-pass sweep are definers the worker runs as service_role alone (no anon, no authenticated, no PUBLIC grant behind either). Their
-- two helpers are plain functions nobody can execute, the service role included: the definers call them as their
-- owner. The table is RLS-closed with no policy: the worker may read it, and only the definers write it.
do $$
declare
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('discovery_begin_proposal_source', 'discovery_renew_proposal_source',
                          'discovery_end_proposal_source', 'discovery_close_lapsed_proposal_passes')) <> 4 then
    raise exception 'expected the four team inbox pass functions';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_begin_proposal_source', 'discovery_renew_proposal_source',
                      'discovery_end_proposal_source', 'discovery_close_lapsed_proposal_passes')
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the team inbox pass functions must be definers executable by service_role alone: %', v_bad;
  end if;

  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('discovery_team_pass_gate', 'discovery_team_pass_counts',
                          'discovery_team_pass_close_lapsed')) <> 3 then
    raise exception 'expected the three team inbox pass helpers';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_team_pass_gate', 'discovery_team_pass_counts', 'discovery_team_pass_close_lapsed')
    and (has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the team inbox pass helpers must not be executable by any API role or PUBLIC: %', v_bad;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.discovery_team_proposal_passes'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.discovery_team_proposal_passes'::regclass) then
    raise exception 'discovery_team_proposal_passes must have RLS on and no policy';
  end if;
  if not has_table_privilege('service_role', 'public.discovery_team_proposal_passes', 'SELECT')
     or has_table_privilege('service_role', 'public.discovery_team_proposal_passes', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('anon', 'public.discovery_team_proposal_passes', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('authenticated', 'public.discovery_team_proposal_passes', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 'discovery_team_proposal_passes: service_role reads, and only the definers write';
  end if;
end
$$;

-- The worker's team inbox check (#581, 20261019130000_team_mailbox_check.sql): the due test and the
-- recorder of the Google Directory check's outcome. Service role alone, like the other worker writers:
-- no anon, no authenticated, and no PUBLIC grant behind either. Neither takes an actor, so neither
-- may ever be a signed-in role's (supabase/tests/team_mailboxes.sql).
do $$
declare
  v_found integer;
  v_bad   text;
begin
  select count(*) into v_found
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_team_mailbox_check_due', 'discovery_record_team_mailbox_check');
  if v_found <> 2 then
    raise exception 'expected the two team inbox check functions, found %', v_found;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('discovery_team_mailbox_check_due', 'discovery_record_team_mailbox_check')
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the team inbox check functions must be definers executable by service_role alone: %', v_bad;
  end if;
end
$$;

do $$
declare
  v_bad text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p')
    and (has_table_privilege('anon', c.oid, 'TRUNCATE')
      or has_table_privilege('authenticated', c.oid, 'TRUNCATE'));
  if v_bad is not null then
    raise exception 'TRUNCATE (ignores RLS) still granted to anon/authenticated: %', v_bad;
  end if;
end
$$;

-- #312: every definer pins `search_path = public, pg_temp` (20261016100000).
-- Without pg_temp listed, Postgres searches the caller's temp schema first for
-- tables, views and types. Functions and procedures both count; extension
-- members are not ours to alter. A later `create or replace` that spells the
-- old `= public` resets proconfig, and this block names it.
do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
    and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp'];
  if v_bad is not null then
    raise exception
      'security definer functions without "set search_path = public, pg_temp": %', v_bad;
  end if;
end
$$;

-- A function created after the migration must start closed too: the defaults,
-- not only today's functions (#233 review).
create function public.definer_grants_probe() returns int
  language sql security definer set search_path = public, pg_temp as 'select 1';
do $$
begin
  if has_function_privilege('anon', 'public.definer_grants_probe()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.definer_grants_probe()', 'EXECUTE') then
    raise exception 'A new SECURITY DEFINER function is executable by anon/authenticated: default privileges still open';
  end if;
end
$$;
drop function public.definer_grants_probe();

-- #312: rail_skip_approver is the one SQL rule for who may approve a step skip.
-- It is a security invoker, so the definer checks above never see it: assert here
-- that it exists, is an invoker with the pinned path, and is closed to every
-- browser and service role (only the two definers that record a skip call it,
-- and they run as the owner).
do $$
declare
  v_oid   oid := to_regprocedure('public.rail_skip_approver(uuid,uuid)');
  v_proc  pg_proc;
begin
  if v_oid is null then
    raise exception 'FAIL: rail_skip_approver(uuid, uuid) does not exist';
  end if;
  select * into v_proc from pg_proc where oid = v_oid;
  if v_proc.prosecdef then
    raise exception 'FAIL: rail_skip_approver must be a security invoker';
  end if;
  if not coalesce(v_proc.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp'] then
    raise exception 'FAIL: rail_skip_approver must set search_path = public, pg_temp, got %', v_proc.proconfig;
  end if;
  if has_function_privilege('anon', v_oid, 'EXECUTE')
     or has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or has_function_privilege('service_role', v_oid, 'EXECUTE')
     or exists (select 1 from aclexplode(coalesce(v_proc.proacl, acldefault('f', v_proc.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'FAIL: rail_skip_approver must not be executable by anon, authenticated, service_role or PUBLIC';
  end if;
end
$$;

-- Model proposal dismissal (G-02a #173, 20261023120100_model_proposal_dismissals.sql). The dismiss RPC is a definer
-- executable by authenticated (allowlisted above) and by neither anon nor PUBLIC. The read helper (called by the
-- dismiss RPC as its owner, and by the parity test as service_role) and the operator restore (the runbook step,
-- which records who asked) are definers executable by service_role alone.
do $$
declare
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('discovery_dismiss_model_proposal', 'app_can_read_model_proposal',
                          'discovery_restore_model_proposal_dismissals')) <> 3 then
    raise exception 'expected one each of the three model proposal dismissal functions';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'discovery_dismiss_model_proposal'
    and (not p.prosecdef
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'discovery_dismiss_model_proposal must be a definer executable by authenticated and by neither anon nor PUBLIC: %', v_bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('app_can_read_model_proposal', 'discovery_restore_model_proposal_dismissals')
    and (not p.prosecdef
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the dismissal read helper and restore must be definers executable by service_role alone: %', v_bad;
  end if;

  -- The decision rows: signed-in users read (RLS), never write.
  if has_table_privilege('authenticated', 'discovery_model_proposal_dismissals', 'INSERT')
     or has_table_privilege('authenticated', 'discovery_model_proposal_dismissals', 'UPDATE')
     or has_table_privilege('authenticated', 'discovery_model_proposal_dismissals', 'DELETE')
     or has_table_privilege('anon', 'discovery_model_proposal_dismissals', 'SELECT')
     or not (select relrowsecurity from pg_class where oid = 'public.discovery_model_proposal_dismissals'::regclass) then
    raise exception 'discovery_model_proposal_dismissals must be RLS-on and read-only to signed-in roles';
  end if;
end
$$;

-- Model proposal accept (G-02b #173, 20261023140100_model_proposal_accepts.sql). The request RPC is a definer executable
-- by authenticated (allowlisted above) and by neither anon nor PUBLIC. The request rows are RLS-on and read-only to
-- signed-in roles: only the RPC and the worker's service_role definers (slice 1b, which pins its own grants) write them.
do $$
declare
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname = 'discovery_accept_model_proposal') <> 1 then
    raise exception 'expected one discovery_accept_model_proposal';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = 'discovery_accept_model_proposal'
    and (not p.prosecdef
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'discovery_accept_model_proposal must be a definer executable by authenticated and by neither anon nor PUBLIC: %', v_bad;
  end if;

  -- The request rows: signed-in users read (RLS), never write.
  if has_table_privilege('authenticated', 'discovery_model_proposal_accepts', 'INSERT')
     or has_table_privilege('authenticated', 'discovery_model_proposal_accepts', 'UPDATE')
     or has_table_privilege('authenticated', 'discovery_model_proposal_accepts', 'DELETE')
     or has_table_privilege('anon', 'discovery_model_proposal_accepts', 'SELECT')
     or not (select relrowsecurity from pg_class where oid = 'public.discovery_model_proposal_accepts'::regclass) then
    raise exception 'discovery_model_proposal_accepts must be RLS-on and read-only to signed-in roles';
  end if;
end
$$;

-- Origin reads (G-02b #173, 20261023140400_discovery_origin_read.sql). Both are pinned definers executable by
-- authenticated (allowlisted above) and by neither anon nor PUBLIC, and stable (they write nothing).
do $$
declare
  v_names constant text[] := array['discovery_candidate_origins', 'discovery_deal_origin'];
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any (v_names)) <> cardinality(v_names) then
    raise exception 'expected exactly one each of discovery_candidate_origins and discovery_deal_origin';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = any (v_names)
    and (not p.prosecdef
      or p.provolatile <> 's'
      or not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
      or not has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the origin reads must be stable, pinned definers executable by authenticated and by neither anon nor PUBLIC: %', v_bad;
  end if;
end
$$;

-- Model proposal accept, the worker's side (G-02b #173, 20261023140300_model_proposal_accept_worker.sql). The seven
-- definers (claim, renew, live keys, storing, stored, finish, expire) are executable by service_role alone: they take
-- the claim token of the SYNC job that owns a request, never auth.uid(), so a signed-in role must not reach them (and
-- none is on the authenticated allowlist above).
do $$
declare
  v_names constant text[] := array[
    'discovery_claim_model_proposal_accepts',
    'discovery_renew_model_proposal_accept',
    'discovery_model_proposal_accept_live_keys',
    'discovery_mark_model_proposal_accept_storing',
    'discovery_mark_model_proposal_accept_stored',
    'discovery_finish_model_proposal_accept',
    'discovery_expire_model_proposal_accepts'
  ];
  v_bad text;
begin
  if (select count(*) from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any (v_names)) <> cardinality(v_names) then
    raise exception 'expected exactly one each of the seven model proposal accept worker definers';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname = any (v_names)
    and (not p.prosecdef
      or not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp']
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      or not has_function_privilege('service_role', p.oid, 'EXECUTE')
      or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  if v_bad is not null then
    raise exception 'the model proposal accept worker definers must be pinned definers executable by service_role alone: %', v_bad;
  end if;

  -- mark_storing returns the keys it recorded (the keys the job may persist), not a flag.
  if (select p.prorettype from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = 'discovery_mark_model_proposal_accept_storing')
     <> 'text[]'::regtype then
    raise exception 'discovery_mark_model_proposal_accept_storing must return text[]';
  end if;
end
$$;
