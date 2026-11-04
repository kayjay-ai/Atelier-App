-- Run this in Supabase Dashboard → SQL Editor if photo upload fails with "Bucket not found".
-- Creates private buckets + RLS so signed-in users can upload their own photos and try-ons.

insert into storage.buckets (id, name, public)
values
  ('user-photos', 'user-photos', false),
  ('try-on-results', 'try-on-results', false)
on conflict (id) do nothing;

drop policy if exists "Users manage own photos" on storage.objects;
create policy "Users manage own photos"
  on storage.objects for all
  using (
    bucket_id = 'user-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'user-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users manage own try-on images" on storage.objects;
create policy "Users manage own try-on images"
  on storage.objects for all
  using (
    bucket_id = 'try-on-results'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'try-on-results'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
