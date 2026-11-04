-- =============================================================================
-- B2B (in-store iPad) companies. Idempotent; run once in the Supabase SQL editor
-- AFTER schema.sql and membership.sql.
--
-- Table names follow the Admin Dashboard spec §7 (plans, clients, client_features,
-- stores, customer_folders) so the admin portal reads the same tables.
--
-- Account type: a login is a COMPANY account (account_type = b2b_company) iff it
-- has a row in client_users. Users can only READ their own row, never write it,
-- so nobody can promote themselves to a company. Every other login is B2C.
--
-- Credits: a company's credits_balance is a shared pool for all its iPads. Only
-- the service role changes it, via the functions in b2b-operations.sql.
-- =============================================================================

-- ── Plan slabs (prices/credits are placeholders until the founder decides) ────
create table if not exists public.plans (
  id               text primary key,                  -- 'basic' | 'pro' | 'ultra'
  name             text not null,
  price_inr        integer not null,
  cycle            text not null default 'monthly' check (cycle in ('monthly', 'annual')),
  credits_included integer not null default 0,
  topup_price_inr  integer,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- PLACEHOLDER credit allowances — edit in the admin portal once decided.
insert into public.plans (id, name, price_inr, credits_included) values
  ('basic', 'Basic', 18000, 1000),
  ('pro',   'Pro',   22000, 1500),
  ('ultra', 'Ultra', 26000, 2000)
on conflict (id) do nothing;

-- ── Companies ────────────────────────────────────────────────────────────────
create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  company_name    text not null,
  logo_url        text,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  gstin           text,
  billing_address text,
  plan_id         text references public.plans (id),
  credits_balance integer not null default 0 check (credits_balance >= 0),
  status          text not null default 'active'
                    check (status in ('active', 'trial', 'suspended', 'revoked')),
  trial_ends_at   timestamptz,
  renewal_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Company logins. One auth user = one company login (created by the Atelier admin).
create table if not exists public.client_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  client_id  uuid not null references public.clients (id) on delete cascade,
  role       text not null default 'admin' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now()
);
create index if not exists client_users_client_idx on public.client_users (client_id);

-- Per-company feature toggles. A MISSING row means the feature is ON (default).
create table if not exists public.client_features (
  client_id  uuid not null references public.clients (id) on delete cascade,
  feature    text not null check (feature in ('tryon', 'style', 'size')),
  enabled    boolean not null default true,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (client_id, feature)
);

-- Stores — tracked only, never limited.
create table if not exists public.stores (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  name       text not null,
  city       text,
  address    text,
  created_at timestamptz not null default now()
);
create index if not exists stores_client_idx on public.stores (client_id);

-- ── Walk-in customer folders (15-day lifetime) ───────────────────────────────
create table if not exists public.customer_folders (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  store_id      uuid references public.stores (id) on delete set null,
  customer_name text not null,          -- includes the " (2)" suffix for duplicates
  phone         text,
  consent       boolean not null check (consent),
  consent_at    timestamptz not null default now(),
  measurements  jsonb,
  photo_path    text,                   -- customer-photos/<client_id>/<folder_id>/...
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '15 days')
);
create index if not exists customer_folders_client_idx
  on public.customer_folders (client_id, created_at desc);

create table if not exists public.customer_tryons (
  id           uuid primary key default gen_random_uuid(),
  folder_id    uuid not null references public.customer_folders (id) on delete cascade,
  client_id    uuid not null references public.clients (id) on delete cascade,
  garment_name text,
  garment_path text,
  result_path  text,
  size_result  jsonb,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists customer_tryons_folder_idx
  on public.customer_tryons (folder_id, created_at desc);

-- Same-name folders get a suffix: "Priya Sharma" → "Priya Sharma (2)".
create or replace function public.customer_folder_unique_name()
returns trigger
language plpgsql
as $$
declare
  base      text := btrim(new.customer_name);
  candidate text := btrim(new.customer_name);
  n         int  := 1;
begin
  while exists (
    select 1 from public.customer_folders
    where client_id = new.client_id
      and customer_name = candidate
      and expires_at > now()
  ) loop
    n := n + 1;
    candidate := base || ' (' || n || ')';
  end loop;
  new.customer_name := candidate;
  return new;
end;
$$;

drop trigger if exists customer_folders_unique_name on public.customer_folders;
create trigger customer_folders_unique_name
  before insert on public.customer_folders
  for each row execute function public.customer_folder_unique_name();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- The caller's company (null for B2C users). SECURITY DEFINER so policies can
-- read client_users without recursing through its own RLS.
create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select client_id from public.client_users where user_id = auth.uid()
$$;

alter table public.plans            enable row level security;
alter table public.clients          enable row level security;
alter table public.client_users     enable row level security;
alter table public.client_features  enable row level security;
alter table public.stores           enable row level security;
alter table public.customer_folders enable row level security;
alter table public.customer_tryons  enable row level security;

drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to authenticated using (active);

drop policy if exists client_users_own on public.client_users;
create policy client_users_own on public.client_users for select to authenticated
  using (user_id = auth.uid());

drop policy if exists clients_own on public.clients;
create policy clients_own on public.clients for select to authenticated
  using (id = public.current_client_id());

drop policy if exists client_features_own on public.client_features;
create policy client_features_own on public.client_features for select to authenticated
  using (client_id = public.current_client_id());

drop policy if exists stores_own on public.stores;
create policy stores_own on public.stores for select to authenticated
  using (client_id = public.current_client_id());

-- Expired folders are invisible to the app even before the cleanup job removes them.
drop policy if exists customer_folders_read on public.customer_folders;
create policy customer_folders_read on public.customer_folders for select to authenticated
  using (client_id = public.current_client_id() and expires_at > now());

drop policy if exists customer_folders_write on public.customer_folders;
create policy customer_folders_write on public.customer_folders for insert to authenticated
  with check (client_id = public.current_client_id());

drop policy if exists customer_folders_update on public.customer_folders;
create policy customer_folders_update on public.customer_folders for update to authenticated
  using (client_id = public.current_client_id() and expires_at > now())
  with check (client_id = public.current_client_id());

-- Staff can delete a customer early (e.g. on request); results cascade.
drop policy if exists customer_folders_delete on public.customer_folders;
create policy customer_folders_delete on public.customer_folders for delete to authenticated
  using (client_id = public.current_client_id());

drop policy if exists customer_tryons_own on public.customer_tryons;
create policy customer_tryons_own on public.customer_tryons for all to authenticated
  using (client_id = public.current_client_id())
  with check (client_id = public.current_client_id());

-- Company credits/features/plan are written only by the service role (admin
-- portal + API server): no insert/update policies on clients, client_features,
-- client_users or plans.

-- ── Storage: private bucket, one folder per company ──────────────────────────
-- Paths: <client_id>/<folder_id>/<file>.jpg
insert into storage.buckets (id, name, public)
values ('customer-photos', 'customer-photos', false)
on conflict (id) do nothing;

drop policy if exists customer_photos_rw on storage.objects;
create policy customer_photos_rw on storage.objects for all to authenticated
  using (
    bucket_id = 'customer-photos'
    and (storage.foldername(name))[1] = public.current_client_id()::text
  )
  with check (
    bucket_id = 'customer-photos'
    and (storage.foldername(name))[1] = public.current_client_id()::text
  );

-- ── Company credit pool ──────────────────────────────────────────────────────
-- consume_client_credit / refund_client_credit and the admin functions live in
-- b2b-operations.sql (run it next).

-- =============================================================================
-- Onboarding a company by hand (until the admin portal's Add-client wizard ships).
-- Run b2b-operations.sql first.
--
--   1. Supabase → Authentication → Users → Add user (email + password,
--      "Auto confirm" on). Copy the new user's id.
--   2. Run:
--
--   with c as (
--     insert into public.clients (company_name, contact_email, plan_id)
--     values ('Westside Retail', 'store@westside.example', 'basic')
--     returning id
--   )
--   insert into public.client_users (user_id, client_id, role)
--   select '<auth-user-id>', id, 'admin' from c;
--
--   3. Start the first billing period (sets credits + renewal date, logs it):
--   select public.renew_client_plan('<client-id>', null, 'activated');
--
--   Optional — switch a feature off:
--   select public.set_client_feature('<client-id>', 'size', false);
-- =============================================================================
