-- Transactional document upload: metadata row + upload audit commit or roll
-- back together (cr-prr-124 3.1, plan-v5 M5 "bytes → row+audit transaction →
-- compensating delete"). The route uploads bytes first, calls this RPC, and
-- deletes the stored object if the RPC fails — so no document row, audit row,
-- or unaudited partial state can survive a mid-flight failure.
create or replace function public.create_document_with_audit(
  p_deal_id uuid,
  p_name text,
  p_room text,
  p_classification int,
  p_min_phase int,
  p_uploaded_by uuid,
  p_storage_provider text,
  p_storage_file_id text,
  p_size_bytes bigint,
  p_content_type text
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
    storage_provider, storage_file_id, size_bytes, content_type
  ) values (
    p_deal_id, p_name, p_room, p_classification, p_min_phase, p_uploaded_by,
    p_storage_provider, p_storage_file_id, p_size_bytes, p_content_type
  ) returning * into v_doc;

  insert into audit_log (actor_id, action, deal_id, document_id, detail)
  values (
    p_uploaded_by, 'upload', p_deal_id, v_doc.id,
    jsonb_build_object(
      'name', p_name,
      'room', p_room,
      'classification', p_classification,
      'provider', p_storage_provider
    )
  );

  return jsonb_build_object(
    'id', v_doc.id,
    'name', v_doc.name,
    'room', v_doc.room,
    'classification', v_doc.classification,
    'min_phase', v_doc.min_phase,
    'created_at', v_doc.created_at
  );
end;
$$;

revoke all on function public.create_document_with_audit(uuid, text, text, int, int, uuid, text, text, bigint, text) from public;
grant execute on function public.create_document_with_audit(uuid, text, text, int, int, uuid, text, text, bigint, text) to service_role;
