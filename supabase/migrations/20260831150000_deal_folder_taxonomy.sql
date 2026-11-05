-- Deal Folder taxonomy: a document names one of the eight closed top-level
-- folders (Ignatious / Sample-ignatious-Project) and an optional subpath.
-- Files stay where they are filed — there is no move column and no move RPC.
-- Existing rows land in received-from-client so nothing vanishes.

alter table public.documents
  add column if not exists folder text,
  add column if not exists folder_subpath text[] not null default '{}';

update public.documents
  set folder = 'received-from-client'
  where folder is null;

alter table public.documents
  alter column folder set default 'received-from-client',
  alter column folder set not null;

alter table public.documents drop constraint if exists documents_folder_check;
alter table public.documents add constraint documents_folder_check
  check (folder in (
    'received-from-client',
    'admin',
    'client-presentations',
    'marketing-materials',
    'buyers',
    'data-room-index',
    'due-diligence',
    'closing'
  ));

comment on column public.documents.folder is
  'Deal Folder top-level id (closed enum). Display labels live in the app, not here.';
comment on column public.documents.folder_subpath is
  'Segments under folder, max depth 3. Empty = filed at the folder itself. Not a move target.';

-- Recreate the upload RPC with the new columns. CREATE OR REPLACE cannot change
-- the argument list, so the 10-arg form is dropped first. Added parameters have
-- defaults so existing named callers keep working.
drop function if exists public.create_document_with_audit(uuid, text, text, int, int, uuid, text, text, bigint, text);

create function public.create_document_with_audit(
  p_deal_id uuid,
  p_name text,
  p_room text,
  p_classification int,
  p_min_phase int,
  p_uploaded_by uuid,
  p_storage_provider text,
  p_storage_file_id text,
  p_size_bytes bigint,
  p_content_type text,
  p_folder text default 'received-from-client',
  p_folder_subpath text[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc documents%rowtype;
begin
  insert into documents (
    deal_id, name, room, classification, min_phase, uploaded_by,
    storage_provider, storage_file_id, size_bytes, content_type,
    folder, folder_subpath
  ) values (
    p_deal_id, p_name, p_room, p_classification, p_min_phase, p_uploaded_by,
    p_storage_provider, p_storage_file_id, p_size_bytes, p_content_type,
    p_folder, p_folder_subpath
  ) returning * into v_doc;

  insert into audit_log (actor_id, action, deal_id, document_id, detail)
  values (
    p_uploaded_by, 'upload', p_deal_id, v_doc.id,
    jsonb_build_object(
      'name', p_name,
      'room', p_room,
      'classification', p_classification,
      'provider', p_storage_provider,
      'folder', p_folder,
      'folder_subpath', to_jsonb(p_folder_subpath)
    )
  );

  return jsonb_build_object(
    'id', v_doc.id,
    'name', v_doc.name,
    'room', v_doc.room,
    'classification', v_doc.classification,
    'min_phase', v_doc.min_phase,
    'folder', v_doc.folder,
    'folder_subpath', to_jsonb(v_doc.folder_subpath),
    'created_at', v_doc.created_at
  );
end;
$$;

revoke all on function public.create_document_with_audit(uuid, text, text, int, int, uuid, text, text, bigint, text, text, text[]) from public;
grant execute on function public.create_document_with_audit(uuid, text, text, int, int, uuid, text, text, bigint, text, text, text[]) to service_role;
