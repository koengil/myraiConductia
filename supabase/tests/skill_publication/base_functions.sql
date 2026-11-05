alter table deal_steps
  add column if not exists definition           jsonb,
  add column if not exists removed_at           timestamptz,
  add column if not exists phase_index          int,
  add column if not exists work                 jsonb,
  add column if not exists bench_run_started_at timestamptz;

create table documents (id uuid primary key);

create function app_is_deal_member(p_deal_id uuid, p_user_id uuid) returns boolean
language sql stable as $$ select false $$;

create function app_is_overseer(p_user_id uuid) returns boolean
language sql stable as $$ select false $$;

do $$
begin
  if to_regprocedure('auth.uid()') is null then
    create function auth.uid() returns uuid language sql stable as $uid$ select null::uuid $uid$;
  end if;
end;
$$;
