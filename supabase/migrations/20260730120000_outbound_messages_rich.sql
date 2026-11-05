-- supabase/migrations/20260730120000_outbound_messages_rich.sql
-- Outlook-style mail client (2026-07-30): the outbound record grows the fields
-- a real email carries — Cc/Bcc, a rich (HTML) body alongside the screened
-- plain text, and attachment METADATA (name, size, sha256, mime). Attachment
-- bytes are NOT stored; they go to the provider only. The plain-text body
-- remains the screening target and the canonical retained content.
--
-- Additive + idempotent; safe to re-run.

alter table outbound_messages
  add column if not exists cc_emails   text[] not null default '{}',
  add column if not exists bcc_emails  text[] not null default '{}',
  add column if not exists body_html   text,
  add column if not exists attachments jsonb not null default '[]';
