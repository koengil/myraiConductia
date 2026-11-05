-- Bench run identity per step (bugs 8/9). The skill bench answers over SSE and
-- emits a conversation id and a run id; without these columns both are lost the
-- moment the runner unmounts, so a returning MD has nothing to resume from.
--
-- Platform state, not deal content: it lives beside `work` rather than inside
-- it, so clearing a run really deletes the identity and does not leave a null
-- tombstone (or a step_work audit row) inside the MD's authored payload.

alter table deal_steps
  add column if not exists bench_conversation_id text,
  add column if not exists bench_run_id text,
  add column if not exists bench_run_status text,
  add column if not exists bench_run_started_at timestamptz;

alter table deal_steps drop constraint if exists deal_steps_bench_run_status_check;
alter table deal_steps add constraint deal_steps_bench_run_status_check
  check (bench_run_status is null or bench_run_status in ('running','complete','failed'));
