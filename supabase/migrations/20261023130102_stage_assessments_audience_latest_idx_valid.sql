-- G-07 slice 1a (#173): 20261023130101 builds stage_assessments_audience_latest_idx concurrently; a
-- failed build leaves an invalid index that `if not exists` would skip on a retry. Stop here, loudly,
-- before 20261023130103 drops the old index: drop stage_assessments_audience_latest_idx and re-run
-- 20261023130101.
do $$
begin
  if to_regclass('public.stage_assessments_audience_latest_idx') is null
     or not exists (select 1 from pg_index
                     where indexrelid = 'public.stage_assessments_audience_latest_idx'::regclass and indisvalid) then
    raise exception 'stage_assessments_audience_latest_idx is missing or invalid: drop it and re-run 20261023130101_stage_assessments_audience_latest_idx.sql';
  end if;
end;
$$;
