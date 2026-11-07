-- Atelier profile + try-on storage
-- Run in Supabase SQL Editor after creating a project.
--
-- DISABLE EMAIL VERIFICATION (recommended for local dev):
--   Dashboard → Authentication → Providers → Email → turn OFF "Confirm email"
--   Dashboard → Authentication → URL Configuration:
--     Site URL: http://localhost:5173
--     Redirect URLs: http://localhost:5173/**
--
-- Then create Storage buckets — easiest fix for "Bucket not found" on photo upload:
--   Run supabase/storage-buckets.sql in Dashboard → SQL Editor (or `npm run setup:supabase`
--   with SUPABASE_SERVICE_ROLE_KEY in .env, then run storage-buckets.sql for RLS policies).

-- ---------------------------------------------------------------------------
-- Profiles (structured user data — prefer this over auth.user_metadata)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text not null,
  measurements jsonb,
  style_profile jsonb,
  color_analysis jsonb,
  photo_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile row on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email, 'user'), '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Try-on history (metadata in Postgres, images in Storage)
-- ---------------------------------------------------------------------------
create table if not exists public.try_ons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  product_id text not null,
  product_name text not null,
  garment_color text,
  storage_path text not null,
  demo boolean not null default false,
  retailer_product_url text,
  created_at timestamptz not null default now()
);

create index if not exists try_ons_user_created_idx
  on public.try_ons (user_id, created_at desc);

alter table public.try_ons enable row level security;

create policy "Users read own try-ons"
  on public.try_ons for select
  using (auth.uid() = user_id);

create policy "Users insert own try-ons"
  on public.try_ons for insert
  with check (auth.uid() = user_id);

create policy "Users delete own try-ons"
  on public.try_ons for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Storage RLS (private buckets: user-photos, try-on-results)
-- Paths: {user_id}/reference.jpg  and  {user_id}/{try_on_id}.jpg
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('user-photos', 'user-photos', false),
  ('try-on-results', 'try-on-results', false)
on conflict (id) do nothing;

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
