-- Immutable raster images. Documents store opaque references, never public URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('planner-images', 'planner-images', false, 5242880,
  array['image/png','image/jpeg','image/webp','image/gif']);

create policy planner_images_owner_guard on storage.objects
as restrictive for all to public
using (bucket_id <> 'planner-images' or (
  owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 1
))
with check (bucket_id <> 'planner-images' or (
  owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and array_length(storage.foldername(name), 1) = 1
  and storage.filename(name) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp|gif)$'
));

create policy planner_images_upload on storage.objects for insert to authenticated
with check (bucket_id = 'planner-images' and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy planner_images_read on storage.objects for select to authenticated
using (bucket_id = 'planner-images' and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy planner_images_remove on storage.objects for delete to authenticated
using (bucket_id = 'planner-images' and owner_id = (select auth.uid())::text
  and (storage.foldername(name))[1] = (select auth.uid())::text);
