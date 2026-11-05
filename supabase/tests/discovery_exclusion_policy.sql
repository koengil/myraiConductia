-- supabase/tests/discovery_exclusion_policy.sql
-- The exclusion policy's storage (20261003110000_discovery_exclusion_policy.sql, #263):
--
--   - discovery_exclusion_policies is append-only, behind RLS with no policy, and
--     service_role holds SELECT and nothing else; the only writer is
--     discovery_exclusion_policy_set, which only service_role may execute
--   - every version writes one chained discovery.exclusion_policy_changed audit row
--     naming the tenant, the version, the previous version, the rule ids, a hash and
--     the requester (never the domains)
--   - a stale expected version is refused (stale_version); a rule id that changes its
--     condition against ANY earlier version is refused (rule_condition_changed), while
--     its scope and category may change; duplicate ids and a missing requester are refused
--   - a policy skip on routing_ledger always carries its version, rule and a non-empty
--     thread id, and nothing else carries all three
--   - discovery_ledger_record_policy_skips never replaces a row that records a read or a
--     fetch (routed, unrouted, id_collision, policy_excluded_after_fetch); it refreshes
--     only a never-fetched policy skip
--   - discovery_thread_taints (phase 3) is insert-only: service_role holds SELECT and
--     INSERT and nothing else, no browser role reaches it, an update is refused (P0001),
--     the first provenance of a (source, thread, rule) wins under insert ... on conflict
--     do nothing, an empty thread id or a version below 1 is refused, and a row goes
--     with its source
--
-- Run after migrations with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_exclusion_policy.sql
-- Everything rolls back.

begin;

do $$
declare
  v_t       uuid := gen_random_uuid();
  v_other   uuid := gen_random_uuid();
  v_src     uuid := gen_random_uuid();
  v_run     uuid := gen_random_uuid();
  v_rules1  jsonb := '[
    {"id":"outside-counsel","category":"never_read","scope":"message","kind":"participant_domain","domains":["counsel.example"]},
    {"id":"private-marker","category":"confidential","scope":"message","kind":"header_marker","header":"sensitivity","contains":"private"}
  ]';
  v_rules2  jsonb := '[
    {"id":"outside-counsel","category":"privileged","scope":"message","kind":"participant_domain","domains":["counsel.example"]},
    {"id":"hr-alias","category":"hr","scope":"message","kind":"participant_address","addresses":["hr@bank.example"]}
  ]';
  v_src2    uuid := gen_random_uuid();
  v_got     integer;
  v_taint   discovery_thread_taints%rowtype;
  v_row     audit_log%rowtype;
  v_prev    audit_log%rowtype;
  v_ledger  routing_ledger%rowtype;
  v_blocked text;
  v_err     text;
begin
  -- ── 1. The table: RLS on, no policy, service_role may read and nothing else ──
  if not (select relrowsecurity from pg_class where oid = 'public.discovery_exclusion_policies'::regclass) then
    raise exception 'FAIL: discovery_exclusion_policies has no row level security';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.discovery_exclusion_policies'::regclass) then
    raise exception 'FAIL: discovery_exclusion_policies has a policy: no browser role may read it';
  end if;
  if has_table_privilege('anon', 'public.discovery_exclusion_policies', 'select, insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.discovery_exclusion_policies', 'select, insert, update, delete, truncate') then
    raise exception 'FAIL: a browser role holds a privilege on discovery_exclusion_policies';
  end if;
  if not has_table_privilege('service_role', 'public.discovery_exclusion_policies', 'select') then
    raise exception 'FAIL: service_role cannot read the policy versions';
  end if;
  if has_table_privilege('service_role', 'public.discovery_exclusion_policies', 'insert')
     or has_table_privilege('service_role', 'public.discovery_exclusion_policies', 'update')
     or has_table_privilege('service_role', 'public.discovery_exclusion_policies', 'delete')
     or has_table_privilege('service_role', 'public.discovery_exclusion_policies', 'truncate') then
    raise exception 'FAIL: service_role writes the policy table directly: its only writer is the RPC';
  end if;

  -- ── 2. The functions: service_role executes them, nobody else ───────────────
  if not has_function_privilege('service_role', 'public.discovery_exclusion_policy_set(uuid, jsonb, integer, text)', 'execute')
     or not has_function_privilege('service_role', 'public.discovery_ledger_record_policy_skips(jsonb, jsonb)', 'execute') then
    raise exception 'FAIL: service_role cannot execute the policy writers';
  end if;
  if has_function_privilege('anon', 'public.discovery_exclusion_policy_set(uuid, jsonb, integer, text)', 'execute')
     or has_function_privilege('authenticated', 'public.discovery_exclusion_policy_set(uuid, jsonb, integer, text)', 'execute')
     or has_function_privilege('anon', 'public.discovery_ledger_record_policy_skips(jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.discovery_ledger_record_policy_skips(jsonb, jsonb)', 'execute') then
    raise exception 'FAIL: a browser role can execute a policy writer';
  end if;
  -- The definers run with a pinned search_path; the ledger writer is no definer (it writes as service_role).
  if exists (
    select 1 from pg_proc p
     where p.oid in ('public.discovery_exclusion_policy_set(uuid, jsonb, integer, text)'::regprocedure,
                     'public.discovery_exclusion_policies_audit()'::regprocedure,
                     'public.discovery_ingestion_health()'::regprocedure)
       and (not p.prosecdef or not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=public, pg_temp'])
  ) then
    raise exception 'FAIL: a #263 security definer function is not a definer with search_path=public, pg_temp';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.discovery_ledger_record_policy_skips(jsonb, jsonb)'::regprocedure)
     or not (select coalesce(proconfig, '{}'::text[]) @> array['search_path=public'] from pg_proc
              where oid = 'public.discovery_ledger_record_policy_skips(jsonb, jsonb)'::regprocedure) then
    raise exception 'FAIL: discovery_ledger_record_policy_skips is a definer or has no pinned search_path';
  end if;

  -- ── 3. The first version: written through the RPC, as service_role ──────────
  set local role service_role;
  v_got := discovery_exclusion_policy_set(v_t, v_rules1, 0, 'Jordan Ames, CCO');
  reset role;
  if v_got <> 1 then raise exception 'FAIL: the first version is %, expected 1', v_got; end if;
  if not exists (
    select 1 from discovery_exclusion_policies
     where tenant_id = v_t and version = 1 and rules = v_rules1 and requested_by = 'Jordan Ames, CCO'
       and rules_sha256 = encode(sha256(convert_to(v_rules1::text, 'UTF8')), 'hex')
  ) then
    raise exception 'FAIL: version 1 was not stored as written';
  end if;

  select * into v_row from audit_log where tenant_id = v_t and action = 'discovery.exclusion_policy_changed';
  if not found then raise exception 'FAIL: version 1 wrote no discovery.exclusion_policy_changed audit row'; end if;
  if v_row.actor_type <> 'service' or v_row.service_identity <> 'exclusion-policy' or v_row.actor_id is not null then
    raise exception 'FAIL: the audit row is %/%/%', v_row.actor_type, v_row.service_identity, v_row.actor_id;
  end if;
  if (v_row.detail ->> 'version')::int <> 1 or (v_row.detail -> 'previousVersion') <> 'null'::jsonb
     or v_row.detail -> 'ruleIds' <> '["outside-counsel", "private-marker"]'::jsonb
     or v_row.detail ->> 'requestedBy' <> 'Jordan Ames, CCO'
     or v_row.detail ->> 'rulesSha256' <> encode(sha256(convert_to(v_rules1::text, 'UTF8')), 'hex') then
    raise exception 'FAIL: the audit detail is wrong: %', v_row.detail;
  end if;
  -- The detail names rules by id, never by their domains.
  if v_row.detail::text like '%counsel.example%' then
    raise exception 'FAIL: the audit detail carries a domain';
  end if;
  -- It is chained like every audit row: chain_seq set, and its hash recomputes.
  if v_row.chain_seq is null
     or v_row.hash is distinct from sha256(coalesce(v_row.prev_hash, ''::bytea) || convert_to(audit_canonical_row(v_row), 'UTF8')) then
    raise exception 'FAIL: the policy audit row is not chained';
  end if;

  -- ── 4. The second version: previousVersion, and the chain continues ─────────
  set local role service_role;
  v_got := discovery_exclusion_policy_set(v_t, v_rules2, 1, 'Jordan Ames, CCO');
  reset role;
  if v_got <> 2 then raise exception 'FAIL: the second version is %, expected 2', v_got; end if;
  v_prev := v_row;
  select * into v_row from audit_log
   where tenant_id = v_t and action = 'discovery.exclusion_policy_changed' and (detail ->> 'version')::int = 2;
  if (v_row.detail ->> 'previousVersion')::int <> 1 then raise exception 'FAIL: version 2 does not name version 1 as previous'; end if;
  if v_row.chain_seq <> v_prev.chain_seq + 1 or v_row.prev_hash is distinct from v_prev.hash then
    raise exception 'FAIL: version 2''s audit row does not link to version 1''s';
  end if;
  -- Scope and category may change under the same id (outside-counsel went never_read -> privileged).

  -- ── 5. A stale expected version is refused ──────────────────────────────────
  v_blocked := null;
  begin
    perform discovery_exclusion_policy_set(v_t, v_rules2, 1, 'someone');
  exception when others then v_blocked := sqlerrm;
  end;
  if v_blocked is distinct from 'stale_version' then raise exception 'FAIL: a stale version answered %', v_blocked; end if;
  v_blocked := null;
  begin
    perform discovery_exclusion_policy_set(v_other, '[]'::jsonb, 3, 'someone');
  exception when others then v_blocked := sqlerrm;
  end;
  if v_blocked is distinct from 'stale_version' then raise exception 'FAIL: a new tenant accepted expected version 3 (%)', v_blocked; end if;
  -- Another tenant counts its own versions, and an empty policy is a deliberate version.
  if discovery_exclusion_policy_set(v_other, '[]'::jsonb, 0, 'Jordan Ames, CCO') <> 1 then
    raise exception 'FAIL: another tenant did not start at version 1';
  end if;

  -- ── 6. A rule id names one condition forever ────────────────────────────────
  v_blocked := null;
  begin
    perform discovery_exclusion_policy_set(v_t, '[
      {"id":"hr-alias","category":"hr","scope":"message","kind":"participant_address","addresses":["someone-else@bank.example"]}
    ]', 2, 'someone');
  exception when others then v_blocked := sqlerrm;
  end;
  if v_blocked is distinct from 'rule_condition_changed' then
    raise exception 'FAIL: a changed condition under the same id answered %', v_blocked;
  end if;
  -- Against an EARLIER version, not only the current one: private-marker left in version 2.
  v_blocked := null;
  begin
    perform discovery_exclusion_policy_set(v_t, '[
      {"id":"private-marker","category":"confidential","scope":"message","kind":"header_marker","header":"sensitivity","contains":"company-confidential"}
    ]', 2, 'someone');
  exception when others then v_blocked := sqlerrm;
  end;
  if v_blocked is distinct from 'rule_condition_changed' then
    raise exception 'FAIL: a rule re-added with a changed condition answered %', v_blocked;
  end if;
  -- The same condition re-added is fine, and so is a new id for a new condition.
  if discovery_exclusion_policy_set(v_t, '[
      {"id":"private-marker","category":"confidential","scope":"message","kind":"header_marker","header":"sensitivity","contains":"private"},
      {"id":"private-marker-2","category":"confidential","scope":"message","kind":"header_marker","header":"sensitivity","contains":"company-confidential"}
    ]', 2, 'Jordan Ames, CCO') <> 3 then
    raise exception 'FAIL: a valid version 3 was refused';
  end if;

  -- ── 7. Malformed input is refused ───────────────────────────────────────────
  foreach v_blocked in array array[
    $j$[{"id":"a","kind":"participant_domain"},{"id":"a","kind":"participant_domain"}]$j$,
    $j$[{"kind":"participant_domain"}]$j$,
    $j$[{"id":"  ","kind":"participant_domain"}]$j$,
    $j$[1]$j$,
    $j$"not a list"$j$
  ] loop
    v_err := null;
    begin
      perform discovery_exclusion_policy_set(v_other, v_blocked::jsonb, 1, 'someone');
    exception when others then v_err := sqlerrm;
    end;
    if v_err is null then raise exception 'FAIL: malformed rules % were accepted', v_blocked; end if;
  end loop;
  begin
    perform discovery_exclusion_policy_set(v_other, '[]'::jsonb, 1, '   ');
    raise exception 'FAIL: a blank requester was accepted';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- ── 8. Append-only: no update, no delete, whoever asks ──────────────────────
  v_blocked := null;
  begin
    update discovery_exclusion_policies set requested_by = 'forged' where tenant_id = v_t and version = 1;
  exception when sqlstate 'P0001' then v_blocked := sqlerrm;
  end;
  if v_blocked is null then raise exception 'FAIL: a policy version was updated'; end if;
  v_blocked := null;
  begin
    delete from discovery_exclusion_policies where tenant_id = v_t and version = 1;
  exception when sqlstate 'P0001' then v_blocked := sqlerrm;
  end;
  if v_blocked is null then raise exception 'FAIL: a policy version was deleted'; end if;

  -- ── 9. The ledger: a policy skip carries version, rule and a thread id ──────
  insert into graph_reader_registrations (tenant_id, ms_tenant_id, client_id, status)
    values (v_t, gen_random_uuid()::text, gen_random_uuid()::text, 'pending');
  insert into content_sources (id, tenant_id, kind, address) values (v_src, v_t, 'mailbox', 'ledger-test@bank.example');

  foreach v_blocked in array array[
    -- a policy reason with no thread id, no version, no rule
    $q$insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, run_id) values ('$SRC', 'bad-1', 'h', 'skipped', 'policy_excluded', '$RUN')$q$,
    $q$insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, provider_thread_id, policy_version, exclusion_rule, run_id) values ('$SRC', 'bad-2', 'h', 'skipped', 'policy_unevaluable', '', 1, 'r', '$RUN')$q$,
    $q$insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, provider_thread_id, policy_version, run_id) values ('$SRC', 'bad-3', 'h', 'skipped', 'policy_thread_excluded', 't1', 1, '$RUN')$q$,
    -- a non-policy row that carries all three
    $q$insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, provider_thread_id, policy_version, exclusion_rule, run_id) values ('$SRC', 'bad-4', 'h', 'routed', 'codename', 0.9, 't1', 1, 'r', '$RUN')$q$
  ] loop
    v_err := null;
    begin
      execute replace(replace(v_blocked, '$SRC', v_src::text), '$RUN', v_run::text);
    exception when check_violation then v_err := sqlerrm;
    end;
    if v_err is null then raise exception 'FAIL: the ledger accepted %', v_blocked; end if;
  end loop;
  -- A routed row may carry only a thread id (Phase 3 stores it on every Gmail row).
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, provider_thread_id, run_id)
    values (v_src, 'ok-thread', 'h', 'routed', 'codename', 0.9, 't1', v_run);

  -- ── 10. record_policy_skips never replaces a fetched row ────────────────────
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, method, confidence, provider_thread_id, run_id)
    values (v_src, 'm-routed', 'h-routed', 'routed', 'codename', 0.95, 't-routed', v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, conversation_id, internet_message_id, provider_thread_id, run_id)
    values (v_src, 'm-unrouted', 'h-unrouted', 'unrouted', 'conv-1', '<u@x>', 't-unrouted', v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, collision_similarity, collision_length_ratio, run_id)
    values (v_src, 'm-collision', 'h-collision', 'skipped', 'id_collision', 0.42, 0.8, v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, provider_thread_id, policy_version, exclusion_rule, run_id)
    values (v_src, 'm-after-fetch', 'h-after', 'skipped', 'policy_excluded_after_fetch', 't-after', 1, 'privileged-label', v_run);
  insert into routing_ledger (source_id, provider_item_id, item_hash, decision, skip_reason, provider_thread_id, policy_version, exclusion_rule, run_id)
    values (v_src, 'm-never', 'h-never', 'skipped', 'policy_excluded', 't-never', 1, 'old-rule', v_run);

  set local role service_role;
  v_got := discovery_ledger_record_policy_skips(jsonb_build_array(
    jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-routed', 'item_hash', 'new', 'skip_reason', 'policy_excluded',
                       'provider_thread_id', 'tx', 'policy_version', 2, 'exclusion_rule', 'new-rule', 'run_id', v_run),
    jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-unrouted', 'item_hash', 'new', 'skip_reason', 'policy_excluded',
                       'provider_thread_id', 'tx', 'policy_version', 2, 'exclusion_rule', 'new-rule', 'run_id', v_run),
    jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-collision', 'item_hash', 'new', 'skip_reason', 'policy_unevaluable',
                       'provider_thread_id', 'tx', 'policy_version', 2, 'exclusion_rule', 'new-rule', 'run_id', v_run),
    jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-after-fetch', 'item_hash', 'new', 'skip_reason', 'policy_thread_excluded',
                       'provider_thread_id', 'tx', 'policy_version', 2, 'exclusion_rule', 'new-rule', 'run_id', v_run),
    -- the only refresh: an earlier never-fetched skip, now under version 2 and another rule
    jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-never', 'item_hash', 'h-never', 'skip_reason', 'policy_thread_excluded',
                       'provider_thread_id', 't-never', 'policy_version', 2, 'exclusion_rule', 'new-rule', 'run_id', v_run),
    -- and a message the ledger has not seen
    jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-new', 'item_hash', 'h-new', 'skip_reason', 'policy_unevaluable',
                       'provider_thread_id', 't-new', 'policy_version', 2, 'exclusion_rule', 'new-rule', 'run_id', v_run)
  ));
  reset role;
  if v_got <> 2 then raise exception 'FAIL: record_policy_skips wrote % rows, expected 2 (the refresh and the new one)', v_got; end if;

  select * into v_ledger from routing_ledger where source_id = v_src and provider_item_id = 'm-routed';
  if v_ledger.decision <> 'routed' or v_ledger.item_hash <> 'h-routed' or v_ledger.method <> 'codename'
     or v_ledger.skip_reason is not null or v_ledger.provider_thread_id <> 't-routed' or v_ledger.policy_version is not null then
    raise exception 'FAIL: a policy skip replaced a routed row';
  end if;
  select * into v_ledger from routing_ledger where source_id = v_src and provider_item_id = 'm-unrouted';
  if v_ledger.decision <> 'unrouted' or v_ledger.item_hash <> 'h-unrouted' or v_ledger.conversation_id <> 'conv-1'
     or v_ledger.policy_version is not null then
    raise exception 'FAIL: a policy skip replaced an unrouted row';
  end if;
  select * into v_ledger from routing_ledger where source_id = v_src and provider_item_id = 'm-collision';
  if v_ledger.skip_reason <> 'id_collision' or v_ledger.collision_similarity <> 0.42::real or v_ledger.collision_length_ratio <> 0.8::real
     or v_ledger.policy_version is not null then
    raise exception 'FAIL: a policy skip replaced an id_collision row (reason or distances changed)';
  end if;
  select * into v_ledger from routing_ledger where source_id = v_src and provider_item_id = 'm-after-fetch';
  if v_ledger.skip_reason <> 'policy_excluded_after_fetch' or v_ledger.policy_version <> 1 or v_ledger.exclusion_rule <> 'privileged-label'
     or v_ledger.provider_thread_id <> 't-after' then
    raise exception 'FAIL: a never-fetched skip replaced a policy_excluded_after_fetch row';
  end if;
  select * into v_ledger from routing_ledger where source_id = v_src and provider_item_id = 'm-never';
  if v_ledger.skip_reason <> 'policy_thread_excluded' or v_ledger.policy_version <> 2 or v_ledger.exclusion_rule <> 'new-rule' then
    raise exception 'FAIL: a never-fetched policy skip was not refreshed to the current version and rule';
  end if;
  if not exists (select 1 from routing_ledger where source_id = v_src and provider_item_id = 'm-new' and policy_version = 2) then
    raise exception 'FAIL: record_policy_skips did not insert a new policy skip';
  end if;

  -- Malformed input is refused.
  v_blocked := null;
  begin
    perform discovery_ledger_record_policy_skips('{}'::jsonb);
  exception when others then v_blocked := sqlerrm;
  end;
  if v_blocked is null then raise exception 'FAIL: record_policy_skips accepted a non-array'; end if;
  v_blocked := null;
  begin
    perform discovery_ledger_record_policy_skips('[]'::jsonb, '{}'::jsonb);
  exception when others then v_blocked := sqlerrm;
  end;
  if v_blocked is null then raise exception 'FAIL: record_policy_skips accepted non-array taints'; end if;

  -- ── 11. Thread taints: insert-only, service role only, first provenance wins ──
  if not (select relrowsecurity from pg_class where oid = 'public.discovery_thread_taints'::regclass) then
    raise exception 'FAIL: discovery_thread_taints has no row level security';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.discovery_thread_taints'::regclass) then
    raise exception 'FAIL: discovery_thread_taints has a policy: no browser role may read it';
  end if;
  if has_table_privilege('anon', 'public.discovery_thread_taints', 'select, insert, update, delete, truncate')
     or has_table_privilege('authenticated', 'public.discovery_thread_taints', 'select, insert, update, delete, truncate') then
    raise exception 'FAIL: a browser role holds a privilege on discovery_thread_taints';
  end if;
  if not has_table_privilege('service_role', 'public.discovery_thread_taints', 'select')
     or not has_table_privilege('service_role', 'public.discovery_thread_taints', 'insert') then
    raise exception 'FAIL: service_role cannot read and insert thread taints';
  end if;
  if has_table_privilege('service_role', 'public.discovery_thread_taints', 'update')
     or has_table_privilege('service_role', 'public.discovery_thread_taints', 'delete')
     or has_table_privilege('service_role', 'public.discovery_thread_taints', 'truncate') then
    raise exception 'FAIL: service_role can change or remove a thread taint';
  end if;

  -- The worker's write: insert ... on conflict do nothing, as service_role. The first provenance stays.
  set local role service_role;
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
    values (v_src, 'thread-a', 'privileged-label', 2, 'first-message', v_run)
    on conflict (source_id, provider_thread_id, rule_id) do nothing;
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
    values (v_src, 'thread-a', 'privileged-label', 3, 'second-message', gen_random_uuid())
    on conflict (source_id, provider_thread_id, rule_id) do nothing;
  -- Another rule on the same thread, and the same thread id in another mailbox, are separate taints.
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
    values (v_src, 'thread-a', 'private-marker', 3, 'second-message', v_run)
    on conflict (source_id, provider_thread_id, rule_id) do nothing;
  reset role;
  select * into v_taint from discovery_thread_taints
   where source_id = v_src and provider_thread_id = 'thread-a' and rule_id = 'privileged-label';
  if v_taint.policy_version <> 2 or v_taint.provider_item_id <> 'first-message' or v_taint.run_id <> v_run then
    raise exception 'FAIL: a second insert replaced the first provenance of a taint';
  end if;
  if (select count(*) from discovery_thread_taints where source_id = v_src and provider_thread_id = 'thread-a') <> 2 then
    raise exception 'FAIL: the same thread under two rules is not two taints';
  end if;
  if v_taint.recorded_at is null then raise exception 'FAIL: a taint carries no time'; end if;

  -- No update, whoever asks (the table owner included).
  v_blocked := null;
  begin
    update discovery_thread_taints set provider_item_id = 'forged' where source_id = v_src;
  exception when sqlstate 'P0001' then v_blocked := sqlerrm;
  end;
  if v_blocked is null then raise exception 'FAIL: a thread taint was updated'; end if;
  v_blocked := null;
  begin
    update discovery_thread_taints set rule_id = 'other' where source_id = v_src and rule_id = 'private-marker';
  exception when sqlstate 'P0001' then v_blocked := sqlerrm;
  end;
  if v_blocked is null then raise exception 'FAIL: a thread taint was re-pointed at another rule'; end if;

  -- Shape: a thread id, rule id and item id are never empty, and a version is at least 1.
  foreach v_blocked in array array[
    $q$insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id) values ('$SRC', '', 'r', 1, 'm', '$RUN')$q$,
    $q$insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id) values ('$SRC', 't', '', 1, 'm', '$RUN')$q$,
    $q$insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id) values ('$SRC', 't', 'r', 0, 'm', '$RUN')$q$,
    $q$insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id) values ('$SRC', 't', 'r', 1, '', '$RUN')$q$
  ] loop
    v_err := null;
    begin
      execute replace(replace(v_blocked, '$SRC', v_src::text), '$RUN', v_run::text);
    exception when check_violation then v_err := sqlerrm;
    end;
    if v_err is null then raise exception 'FAIL: thread taints accepted %', v_blocked; end if;
  end loop;
  -- A taint names a real source.
  v_err := null;
  begin
    insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
      values (gen_random_uuid(), 't', 'r', 1, 'm', v_run);
  exception when foreign_key_violation then v_err := sqlerrm;
  end;
  if v_err is null then raise exception 'FAIL: a taint named a source that does not exist'; end if;

  -- A page's taints and policy skips are one call and one transaction (audit C3): when a skip fails the shape
  -- check after the taint was inserted, neither commits.
  v_err := null;
  begin
    set local role service_role;
    perform discovery_ledger_record_policy_skips(
      jsonb_build_array(jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-c3', 'item_hash', 'h', 'skip_reason', 'policy_excluded',
                                           'provider_thread_id', '', 'policy_version', 2, 'exclusion_rule', 'r', 'run_id', v_run)),
      jsonb_build_array(jsonb_build_object('source_id', v_src, 'provider_thread_id', 'thread-c3', 'rule_id', 'r', 'policy_version', 2,
                                           'provider_item_id', 'm-c3', 'run_id', v_run)));
  exception when check_violation then v_err := sqlerrm;
  end;
  reset role;
  if v_err is null then raise exception 'FAIL: a policy skip without a thread id was accepted'; end if;
  if exists (select 1 from discovery_thread_taints where source_id = v_src and provider_thread_id = 'thread-c3') then
    raise exception 'FAIL: a taint committed although its policy skip failed';
  end if;
  -- And the same call, well formed, writes both; a taint already held keeps its first provenance.
  set local role service_role;
  perform discovery_ledger_record_policy_skips(
    jsonb_build_array(jsonb_build_object('source_id', v_src, 'provider_item_id', 'm-c3', 'item_hash', 'h', 'skip_reason', 'policy_excluded',
                                         'provider_thread_id', 'thread-c3', 'policy_version', 2, 'exclusion_rule', 'r', 'run_id', v_run)),
    jsonb_build_array(jsonb_build_object('source_id', v_src, 'provider_thread_id', 'thread-c3', 'rule_id', 'r', 'policy_version', 2,
                                         'provider_item_id', 'm-c3', 'run_id', v_run),
                      jsonb_build_object('source_id', v_src, 'provider_thread_id', 'thread-a', 'rule_id', 'privileged-label', 'policy_version', 3,
                                         'provider_item_id', 'later', 'run_id', v_run)));
  reset role;
  if not exists (select 1 from discovery_thread_taints where source_id = v_src and provider_thread_id = 'thread-c3' and rule_id = 'r')
     or not exists (select 1 from routing_ledger where source_id = v_src and provider_item_id = 'm-c3' and skip_reason = 'policy_excluded') then
    raise exception 'FAIL: record_policy_skips did not write the taint and the skip together';
  end if;
  if (select provider_item_id from discovery_thread_taints
       where source_id = v_src and provider_thread_id = 'thread-a' and rule_id = 'privileged-label') <> 'first-message' then
    raise exception 'FAIL: record_policy_skips replaced the first provenance of a taint';
  end if;

  -- A taint goes with its source (the cascade is not an update).
  insert into content_sources (id, tenant_id, kind, address) values (v_src2, v_t, 'mailbox', 'taint-cascade@bank.example');
  insert into discovery_thread_taints (source_id, provider_thread_id, rule_id, policy_version, provider_item_id, run_id)
    values (v_src2, 'thread-z', 'privileged-label', 1, 'm', v_run);
  delete from content_sources where id = v_src2;
  if exists (select 1 from discovery_thread_taints where source_id = v_src2) then
    raise exception 'FAIL: a taint outlived its source';
  end if;

  raise notice 'PASS: the exclusion policy storage holds';
end
$$;

rollback;
