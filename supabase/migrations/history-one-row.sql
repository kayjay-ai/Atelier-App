-- =============================================================================
-- ONE history row per garment — try-on image + size + verdict merge onto a single
-- try_ons row keyed by (user_id, product_id), in ANY order. This migration makes
-- that merge atomic and race-proof. Idempotent; safe to run more than once.
--
-- Fixes: size/verdict recommendations not appearing in History because the try-on
-- save used delete+insert (wiping a size row) and size writes raced / hit the wrong
-- row. The app now upserts on the (user_id, product_id) unique index created here.
-- Run this in the Supabase SQL editor.
-- =============================================================================

-- 1) Result columns (no-ops if cloud-only-history.sql already ran).
alter table public.try_ons add column if not exists size_result          jsonb;
alter table public.try_ons add column if not exists verdict_result       jsonb;
alter table public.try_ons add column if not exists garment_source       text;
alter table public.try_ons add column if not exists garment_name         text;
alter table public.try_ons add column if not exists retailer_product_url text;
alter table public.try_ons add column if not exists updated_at           timestamptz not null default now();

-- 2) A size-only / verdict-only row can exist before any try-on image, so the
--    image path must be nullable (history read already tolerates a null path).
alter table public.try_ons alter column storage_path drop not null;

-- 3) Collapse any pre-existing duplicate rows for the same garment, keeping the
--    newest, so the unique index below can be created.
delete from public.try_ons t
  using (
    select id,
           row_number() over (
             partition by user_id, product_id
             order by created_at desc, id desc
           ) as rn
    from public.try_ons
  ) d
  where t.id = d.id and d.rn > 1;

-- 4) The unique key the app upserts on. Without this, upsert(onConflict) fails and
--    the app falls back to a non-atomic write (works, but can race).
create unique index if not exists try_ons_user_product_uidx
  on public.try_ons (user_id, product_id);

-- 5) RLS must permit UPDATE on the owner's own row (the base schema only granted
--    select/insert/delete). `for all` covers select/insert/update/delete.
alter table public.try_ons enable row level security;
drop policy if exists try_ons_own on public.try_ons;
create policy try_ons_own on public.try_ons
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
