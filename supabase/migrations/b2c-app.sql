-- =============================================================================
-- B2C consumer app (Front-End spec §3). Idempotent; run in the Supabase SQL
-- editor after schema.sql, cloud-only-history.sql and credit-packs.sql.
--   • profiles: date of birth (18+ check for "Should I Buy It?"), notification
--     settings (spec §3.2 / §5); the style report reuses the existing
--     style_profile column.
--   • try_ons: the garment image and brand, so History can show the garment
--     next to the try-on and "brand / website or Screenshot".
--   • premium_plans: names, prices and credits of the three Premium plans,
--     editable by the admin without a code change. Ids stay the purchase types
--     the checkout already uses.
-- =============================================================================

alter table public.profiles add column if not exists date_of_birth date;
alter table public.profiles add column if not exists notify_email  boolean not null default true;
alter table public.profiles add column if not exists notify_push   boolean not null default true;

alter table public.try_ons add column if not exists garment_path  text;  -- try-on-results/<user>/<id>-garment.jpg
alter table public.try_ons add column if not exists garment_brand text;

create table if not exists public.premium_plans (
  id           text primary key check (id in ('per_generation', 'pack_30', 'pack_100')),
  name         text not null,
  blurb        text,
  price_inr    integer not null check (price_inr > 0),
  credits      integer not null check (credits > 0),
  recommended  boolean not null default false,
  active       boolean not null default true,
  sort         integer not null default 0,
  updated_at   timestamptz not null default now()
);

-- Values match backend/lib/pricing.mjs, which is the fallback.
insert into public.premium_plans (id, name, blurb, price_inr, credits, recommended, sort) values
  ('per_generation', 'Starter', 'One try-on, on demand', 15, 1, false, 1),
  ('pack_30',        'Plus',    '30 try-ons',            350, 30, true,  2),
  ('pack_100',       'Pro',     '100 try-ons',           700, 100, false, 3)
on conflict (id) do nothing;

-- The first names were placeholders ("Plan 1/2/3"). Rename only those, so a
-- name the admin chose later is kept.
update public.premium_plans set name = 'Starter', updated_at = now() where id = 'per_generation' and name = 'Plan 1';
update public.premium_plans set name = 'Plus',    updated_at = now() where id = 'pack_30'        and name = 'Plan 2';
update public.premium_plans set name = 'Pro',     updated_at = now() where id = 'pack_100'       and name = 'Plan 3';

-- Read by the API server (service role) only; the app gets plans from
-- GET /api/payments/pricing so prices can't be tampered with client-side.
alter table public.premium_plans enable row level security;
