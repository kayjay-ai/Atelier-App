-- =============================================================================
-- Cloud-only persistence — history stores the try-on image PLUS the size result
-- and the buy verdict in one row, and RLS restricts every row/object to its owner.
-- Buckets `user-photos` and `try-on-results` already exist (private). Run once.
-- =============================================================================

-- ── history columns (try_ons is the per-generation history table) ────────────
alter table public.try_ons add column if not exists size_result          jsonb;
alter table public.try_ons add column if not exists verdict_result       jsonb;
alter table public.try_ons add column if not exists garment_source       text;   -- 'upload' or a URL
alter table public.try_ons add column if not exists garment_name         text;
alter table public.try_ons add column if not exists retailer_product_url text;
alter table public.try_ons add column if not exists updated_at           timestamptz not null default now();

-- ── Row Level Security — users see/modify only their own rows ────────────────
alter table public.try_ons  enable row level security;
drop policy if exists try_ons_own on public.try_ons;
create policy try_ons_own on public.try_ons
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.profiles enable row level security;
drop policy if exists profiles_own on public.profiles;
create policy profiles_own on public.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ── Storage RLS — a user reads/writes only files under their own uid folder ──
-- (files are stored as `<uid>/<name>.jpg`, so folder[1] must equal the caller uid)
drop policy if exists atelier_storage_select on storage.objects;
create policy atelier_storage_select on storage.objects for select to authenticated
  using (bucket_id in ('user-photos','try-on-results') and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists atelier_storage_insert on storage.objects;
create policy atelier_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('user-photos','try-on-results') and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists atelier_storage_update on storage.objects;
create policy atelier_storage_update on storage.objects for update to authenticated
  using (bucket_id in ('user-photos','try-on-results') and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists atelier_storage_delete on storage.objects;
create policy atelier_storage_delete on storage.objects for delete to authenticated
  using (bucket_id in ('user-photos','try-on-results') and (storage.foldername(name))[1] = auth.uid()::text);

-- Note: credits/premium live in public.memberships (tryon_used / tryon_limit / plan),
-- not on profiles — the app reads them from there, so no duplicate columns added.
