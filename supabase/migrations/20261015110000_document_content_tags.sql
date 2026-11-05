-- Content tags at upload (E5b): when the server holds a document's bytes at
-- upload, its text is read once and the deterministic rules (rule layer and
-- lexicon, no model call) tag it, so documents are searchable by content
-- category and a later send can reuse the tags by content digest.
--
-- Shape (src/lib/compliance/documentTags.ts): { contentDigest, textStatus,
-- rulesVersion, taggedAt, tags? }. Categories only, never text or matched
-- phrases (D80). `tags` is present only when all of the text was read.
-- NULL = never tagged (uploads before this migration, or tagging failed).
--
-- Idempotent: safe to re-run.
alter table public.documents add column if not exists content_tags jsonb;
create index if not exists documents_content_tags_idx
  on public.documents using gin (content_tags jsonb_path_ops)
  where content_tags is not null;
