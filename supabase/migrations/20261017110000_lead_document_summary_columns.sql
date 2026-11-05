alter table public.lead_documents
  add column if not exists content_hash text,
  add column if not exists text_length integer;

create or replace function public.lead_documents_summarize_text()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.text_content is null then
    new.content_hash := null;
    new.text_length := null;
  else
    new.content_hash := 'sha256:' || encode(sha256(convert_to(new.text_content, 'UTF8')), 'hex');
    new.text_length := char_length(new.text_content)
      + char_length(regexp_replace(new.text_content, '[^\U00010000-\U0010FFFF]', '', 'g'));
  end if;
  return new;
end;
$$;

create or replace trigger lead_documents_summarize_text
  before insert or update on public.lead_documents
  for each row execute function public.lead_documents_summarize_text();

update public.lead_documents set text_content = text_content where text_content is not null;
