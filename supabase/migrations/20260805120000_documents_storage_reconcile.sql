-- Reconcile the two documents.storage_provider definitions (PR #123 vs #124).
--
-- PR #123 (20260731100000) adds the column NOT NULL DEFAULT 'internal'
-- CHECK ('internal','box'); PR #124 (20260731120000) adds it nullable with no
-- default ('local' | 'box', set only when bytes exist). Because both use
-- `add column if not exists`, the surviving shape depends on replay order.
-- This migration makes the final shape deterministic and permissive across
-- both features: nullable, no default, provider named only when a stored
-- object exists.
alter table documents alter column storage_provider drop default;
alter table documents alter column storage_provider drop not null;
alter table documents drop constraint if exists documents_storage_provider_check;
-- Rows that PR #123's default stamped 'internal' without an actual stored
-- object carry no provider.
update documents set storage_provider = null
  where storage_provider = 'internal' and storage_file_id is null;
alter table documents add constraint documents_storage_provider_check
  check (storage_provider is null or storage_provider in ('internal', 'box', 'local'));
