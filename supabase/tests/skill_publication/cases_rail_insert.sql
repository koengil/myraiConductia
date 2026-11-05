do $$
declare
  v_deal uuid := 'e5000000-0000-4000-8000-000000000001';
  v_a uuid := 'e5000000-0000-4000-8000-0000000000a1';
  v_b uuid := 'e5000000-0000-4000-8000-0000000000a2';
  v_first uuid;
  v_second uuid;
  v_order uuid[];
begin
  perform probe_seed_deal(v_deal);
  perform probe_deal_step(v_a, v_deal);
  perform probe_deal_step(v_b, v_deal);
  update deal_steps set phase_index = 1, display_order = 1 where id = v_a;
  update deal_steps set phase_index = 1, display_order = 2 where id = v_b;
  update deals set current_deal_step_id = v_a where id = v_deal;

  v_first := (rail_insert_step(v_deal, probe_author_a(), 1, 'after', v_a,
    jsonb_build_object('title', 'First custom', 'description', 'd'), null, 'req-1') ->> 'stepId')::uuid;
  v_second := (rail_insert_step(v_deal, probe_author_a(), 1, 'after', v_a,
    jsonb_build_object('title', 'Second custom', 'description', 'd'), null, 'req-2') ->> 'stepId')::uuid;

  select array_agg(id order by display_order) into v_order
    from deal_steps where deal_id = v_deal and removed_at is null;
  perform probe_assert(v_order = array[v_a, v_first, v_second, v_b],
    'inserts after the same anchor were not kept in save order');
  perform probe_assert((select status from deal_steps where id = v_first) = 'pending',
    'an inserted step did not start pending');
  perform probe_assert((select current_deal_step_id from deals where id = v_deal) = v_a,
    'an insert moved the current position');
end;
$$;
\echo ok: rail_insert_step keeps anchor inserts in save order without moving the current position

do $$
declare
  v_deal uuid := 'e5000000-0000-4000-8000-000000000002';
  v_first jsonb;
  v_repeat jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_first := rail_insert_step(v_deal, probe_author_a(), 1, 'phase_end', null,
    jsonb_build_object('title', 'Once', 'description', 'd'), null, 'req-once');
  v_repeat := rail_insert_step(v_deal, probe_author_a(), 1, 'phase_end', null,
    jsonb_build_object('title', 'Once', 'description', 'd'), null, 'req-once');
  perform probe_assert((v_first ->> 'created')::boolean, 'the first insert was not a fresh create');
  perform probe_assert(v_repeat ->> 'stepId' = v_first ->> 'stepId' and not (v_repeat ->> 'created')::boolean,
    'a repeated request id did not return the existing step');
  perform probe_assert((select count(*) from deal_steps where deal_id = v_deal and request_id = 'req-once') = 1,
    'a repeated request id created another step');
end;
$$;
\echo ok: rail_insert_step is idempotent on its request id

do $$
declare
  v_deal uuid := 'e5000000-0000-4000-8000-000000000003';
  v_last uuid := 'e5000000-0000-4000-8000-0000000000b2';
  v_new uuid;
begin
  perform probe_seed_deal(v_deal);
  perform probe_deal_step('e5000000-0000-4000-8000-0000000000b1', v_deal);
  perform probe_deal_step(v_last, v_deal);
  update deal_steps set phase_index = 1, display_order = 1 where id = 'e5000000-0000-4000-8000-0000000000b1';
  update deal_steps set phase_index = 1, display_order = 2 where id = v_last;

  v_new := (rail_insert_step(v_deal, probe_author_a(), 2, 'phase_start', null,
    jsonb_build_object('title', 'Phase 2 opener', 'description', 'd'), null, 'req-empty-phase') ->> 'stepId')::uuid;

  perform probe_assert((select display_order from deal_steps where id = v_new) = 3,
    'phase_start on an empty phase did not land after every prior phase');
  perform probe_assert((select display_order from deal_steps where id = v_last) = 2,
    'phase_start on an empty later phase renumbered the prior phase');
end;
$$;
\echo ok: rail_insert_step phase_start on an empty phase lands after the prior phases

do $$
declare
  v_deal uuid := 'e5000000-0000-4000-8000-000000000004';
  v_step uuid;
  v_detail jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_step := (rail_insert_step(v_deal, probe_author_a(), 1, 'phase_end', null,
    jsonb_build_object('title', 'Audited', 'description', 'd'), 'custom:audited', 'req-audit') ->> 'stepId')::uuid;
  select detail into v_detail from audit_log
    where deal_id = v_deal and action = 'update' and detail ->> 'rail' = 'insert';
  perform probe_assert(v_detail ->> 'stepId' = v_step::text
    and v_detail ->> 'stepKey' = 'custom:audited'
    and v_detail ->> 'title' = 'Audited',
    'the insert audit row did not name the step');
end;
$$;
\echo ok: rail_insert_step audits the inserted step by key and title
