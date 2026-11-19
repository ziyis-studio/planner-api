-- Immutable raster images. Documents store opaque references, never public URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('planner-attachments', 'planner-attachments', false, 3145728,
  array['application/pdf','text/plain','text/markdown','text/csv','application/zip','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation']);

create policy planner_attachments_owner_guard on storage.objects
as restrictive for all to public
using (bucket_id <> 'planner-attachments' or (
  owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 1
))
with check (bucket_id <> 'planner-attachments' or (
  owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(pdf|txt|md|csv|zip|docx|xlsx|pptx)$'
));

create policy planner_attachments_upload on storage.objects for insert to authenticated
with check (bucket_id = 'planner-attachments' and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy planner_attachments_read on storage.objects for select to authenticated
using (bucket_id = 'planner-attachments' and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy planner_attachments_remove on storage.objects for delete to authenticated
using (bucket_id = 'planner-attachments' and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text);
