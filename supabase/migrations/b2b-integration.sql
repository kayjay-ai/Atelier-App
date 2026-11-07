-- =============================================================================
-- B2B integration on the ADMIN schema: b2b_companies → b2b_stores → b2b_devices.
-- Idempotent; run once in the Supabase SQL editor (after b2c-app.sql). This
-- REPLACES b2b-companies.sql + b2b-operations.sql (never run on this project —
-- they used separate clients / client_users / devices tables).
--
-- Model
--   • A STORE is what signs in to the iPad app: a Supabase Auth user whose
--     (confirmed) email equals b2b_stores.store_email. No link table — the
--     admin creates the store row and an Auth user with the same email.
--   • Credits, plan, renewal and trial live on the store (each store has its
--     own subscription_plan). All iPads of a store share its credits.
--   • A company (b2b_companies) groups stores; status 'inactive' pauses all of
--     its stores.
--
-- Security
--   • RLS ON for b2b_companies / b2b_stores / b2b_devices (they were
--     UNRESTRICTED: the public key could read and write them).
--   • A store login reads its own store, its company and its own data only.
--   • Admins (public.is_admin()) keep full access to every table here.
--   • Credits, plans, features and devices are written by the service role
--     (API server) or an admin — never by the iPad app.
-- =============================================================================

-- ── 0. Who is signed in ──────────────────────────────────────────────────────
-- The store for an Auth user: matched on the CONFIRMED email, so nobody can
-- claim a store by signing up with its address without owning the inbox.
create or replace function public.store_for_user(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.store_id
  from auth.users u
  join public.b2b_stores s on lower(s.store_email) = lower(u.email)
  where u.id = p_user_id and u.email_confirmed_at is not null
  limit 1
$$;

create or replace function public.current_store_id()
returns text
language sql
stable
security definer
set search_path = public
as $$ select public.store_for_user(auth.uid()) $$;

create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select company_id from public.b2b_stores where store_id = public.current_store_id() $$;

revoke execute on function public.store_for_user(uuid) from public, anon, authenticated;
grant execute on function public.store_for_user(uuid) to service_role;

-- Sign-in page: 'company' for a store login email, else 'personal' (also for
-- unknown emails). Replaces the version in signin-dob.sql.
create or replace function public.account_type_for_email(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1 from public.b2b_stores where lower(store_email) = lower(trim(p_email))
  ) then 'company' else 'personal' end
$$;
revoke execute on function public.account_type_for_email(text) from public, anon, authenticated;
grant execute on function public.account_type_for_email(text) to service_role;

-- ── 1. Settings ──────────────────────────────────────────────────────────────
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values
  ('b2b_low_credit_pct',   '20'),
  ('b2b_grace_days',       '7'),
  ('b2c_low_credit_left',  '1'),
  ('plan_ending_days',     '7'),
  ('notify_auto',          '{"low_credits": true, "out_of_credits": true, "plan_ending": true}'),
  ('notify_cooldown_hours','24'),
  ('b2c_free_credits',     '3')
on conflict (key) do nothing;

create or replace function public.setting_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::int from public.app_settings where key = p_key), p_default)
$$;

-- New consumer accounts get b2c_free_credits.
create or replace function public.handle_new_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.memberships (user_id, credits_balance)
  values (new.id, public.setting_int('b2c_free_credits', 3))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ── 2. Plans (names match b2b_stores.subscription_plan) ──────────────────────
-- PLACEHOLDER prices / credits — edit here or from the admin dashboard.
create table if not exists public.b2b_plans (
  id               text primary key check (id in ('Basic', 'Pro', 'Ultra')),
  name             text not null,
  price_inr        integer not null check (price_inr >= 0),
  cycle            text not null default 'monthly' check (cycle in ('monthly', 'annual')),
  credits_included integer not null default 0 check (credits_included >= 0),
  topup_price_inr  integer,
  active           boolean not null default true,
  updated_at       timestamptz not null default now()
);
insert into public.b2b_plans (id, name, price_inr, credits_included) values
  ('Basic', 'Basic', 18000, 1000),
  ('Pro',   'Pro',   22000, 1500),
  ('Ultra', 'Ultra', 26000, 2000)
on conflict (id) do nothing;

-- ── 3. Stores: credit pool + billing state ───────────────────────────────────
alter table public.b2b_stores add column if not exists credits_balance integer not null default 0;
alter table public.b2b_stores add column if not exists trial_ends_at  timestamptz;
alter table public.b2b_stores add column if not exists renewal_at     timestamptz;
do $$ begin
  alter table public.b2b_stores add constraint b2b_stores_credits_nonneg check (credits_balance >= 0);
exception when duplicate_object then null; end $$;
-- Lets PostgREST join a store to its plan (b2b_stores → b2b_plans).
do $$ begin
  alter table public.b2b_stores add constraint b2b_stores_plan_fk
    foreign key (subscription_plan) references public.b2b_plans (id);
exception when duplicate_object then null; end $$;
create index if not exists b2b_stores_company_idx on public.b2b_stores (company_id);
create index if not exists b2b_stores_email_lower_idx on public.b2b_stores (lower(store_email));

-- What the app shows: active | trial | suspended | revoked (= paused).
create or replace function public.store_effective_status(p_store_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when c.status = 'inactive' or s.status = 'inactive' then 'revoked'
    when s.status = 'suspended' then 'suspended'
    when s.trial_ends_at is not null and s.renewal_at is null then 'trial'
    else 'active'
  end
  from public.b2b_stores s
  left join public.b2b_companies c on c.company_id = s.company_id
  where s.store_id = p_store_id
$$;

-- Per-store feature toggles. A MISSING row means ON.
create table if not exists public.b2b_store_features (
  store_id   text not null references public.b2b_stores (store_id) on delete cascade,
  feature    text not null check (feature in ('tryon', 'style', 'size')),
  enabled    boolean not null default true,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  primary key (store_id, feature)
);

-- ── 4. Devices (iPads) — the app registers itself with a per-install key ─────
alter table public.b2b_devices add column if not exists device_key    text;
alter table public.b2b_devices add column if not exists platform      text;
alter table public.b2b_devices add column if not exists app_version   text;
alter table public.b2b_devices add column if not exists last_user_id  uuid references auth.users (id) on delete set null;
alter table public.b2b_devices add column if not exists first_seen_at timestamptz default now();
create unique index if not exists b2b_devices_store_key_idx on public.b2b_devices (store_id, device_key);
-- 'inactive' = blocked by the admin; 'sign_out_requested' = remote sign-out.
alter table public.b2b_devices drop constraint if exists b2b_devices_status_check;
alter table public.b2b_devices add constraint b2b_devices_status_check
  check (status in ('active', 'inactive', 'sign_out_requested'));

-- ── 5. Walk-in customer folders (15-day lifetime) ────────────────────────────
create table if not exists public.customer_folders (
  id            uuid primary key default gen_random_uuid(),
  store_id      text not null references public.b2b_stores (store_id) on delete cascade,
  device_id     uuid references public.b2b_devices (device_id) on delete set null,
  customer_name text not null,          -- includes the " (2)" suffix for duplicates
  phone         text,
  consent       boolean not null check (consent),
  consent_at    timestamptz not null default now(),
  measurements  jsonb,
  photo_path    text,                   -- customer-photos/<store_id>/<folder_id>/...
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '15 days')
);
create index if not exists customer_folders_store_idx on public.customer_folders (store_id, created_at desc);

create table if not exists public.customer_tryons (
  id           uuid primary key default gen_random_uuid(),
  folder_id    uuid not null references public.customer_folders (id) on delete cascade,
  store_id     text not null references public.b2b_stores (store_id) on delete cascade,
  garment_name text,
  garment_path text,
  result_path  text,
  size_result  jsonb,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists customer_tryons_folder_idx on public.customer_tryons (folder_id, created_at desc);

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
    where store_id = new.store_id and customer_name = candidate and expires_at > now()
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

-- ── 6. Credit ledger, subscriptions, subscription log ────────────────────────
-- (public.credit_ledger belongs to the website-embed partners — separate table.)
create table if not exists public.b2b_credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  store_id      text not null references public.b2b_stores (store_id) on delete cascade,
  delta         integer not null,
  balance_after integer not null,
  reason        text not null check (reason in ('plan', 'renewal', 'topup', 'grant', 'refund', 'usage', 'adjustment')),
  feature       text,
  device_id     uuid references public.b2b_devices (device_id) on delete set null,
  admin_id      uuid references auth.users (id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists b2b_credit_ledger_store_idx on public.b2b_credit_ledger (store_id, created_at desc);

create table if not exists public.b2b_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  store_id        text not null references public.b2b_stores (store_id) on delete cascade,
  plan_id         text not null references public.b2b_plans (id),
  cycle           text not null check (cycle in ('monthly', 'annual')),
  started_at      timestamptz not null,
  renewal_at      timestamptz not null,
  amount_inr      integer not null,
  credits_granted integer not null,
  payment_status  text not null default 'due' check (payment_status in ('paid', 'due', 'overdue', 'waived')),
  payment_ref     text,
  invoice_url     text,
  created_at      timestamptz not null default now()
);
create index if not exists b2b_subscriptions_store_idx on public.b2b_subscriptions (store_id, started_at desc);

create table if not exists public.b2b_subscription_log (
  id         uuid primary key default gen_random_uuid(),
  store_id   text not null references public.b2b_stores (store_id) on delete cascade,
  action     text not null check (action in (
               'activated', 'upgraded', 'downgraded', 'renewed', 'cancelled',
               'trial_started', 'trial_ended', 'suspended', 'reactivated', 'deactivated', 'expired')),
  plan_id    text references public.b2b_plans (id),
  amount_inr integer,
  admin_id   uuid references auth.users (id) on delete set null,
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists b2b_subscription_log_store_idx on public.b2b_subscription_log (store_id, created_at desc);

-- ── 7. Notifications, events, usage, blocked domains ─────────────────────────
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  recipient_type text not null check (recipient_type in ('b2c_user', 'b2b_store')),
  recipient_id   text not null,                       -- auth user id or store_id
  channel        text not null check (channel in ('email', 'in_app', 'tablet')),
  template       text not null check (template in ('low_credits', 'out_of_credits', 'plan_ending', 'upgrade_offer', 'custom')),
  trigger        text not null default 'auto' check (trigger in ('auto', 'manual')),
  subject        text,
  body           text,
  link_url       text,
  status         text not null default 'sent' check (status in ('sent', 'failed', 'skipped')),
  error          text,
  sent_by        uuid references auth.users (id) on delete set null,
  sent_at        timestamptz not null default now(),
  opened_at      timestamptz,
  clicked_at     timestamptz,
  dismissed_at   timestamptz
);
create index if not exists notifications_recipient_idx
  on public.notifications (recipient_type, recipient_id, template, sent_at desc);

create table if not exists public.app_events (
  id         uuid primary key default gen_random_uuid(),
  event      text not null,
  channel    text not null check (channel in ('b2c', 'b2b')),
  user_id    uuid references auth.users (id) on delete set null,
  company_id uuid references public.b2b_companies (company_id) on delete cascade,
  store_id   text references public.b2b_stores (store_id) on delete cascade,
  device_id  uuid references public.b2b_devices (device_id) on delete set null,
  folder_id  uuid,                                    -- kept after the folder expires
  metadata   jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_events_event_idx on public.app_events (event, created_at desc);
create index if not exists app_events_store_idx on public.app_events (store_id, created_at desc);

-- Every AI feature call (B2C + B2B) for the admin Activity pages.
create table if not exists public.usage_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles (id) on delete cascade,
  feature      text not null check (feature in ('style', 'size', 'color', 'verdict', 'tryon', 'garment_from_url')),
  status       text not null default 'success' check (status in ('success', 'fallback', 'error', 'blocked', 'paywall', 'denied')),
  product_name text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);
alter table public.usage_events add column if not exists channel      text not null default 'b2c';
alter table public.usage_events add column if not exists company_id   uuid references public.b2b_companies (company_id) on delete cascade;
alter table public.usage_events add column if not exists store_id     text references public.b2b_stores (store_id) on delete cascade;
alter table public.usage_events add column if not exists device_id    uuid references public.b2b_devices (device_id) on delete set null;
alter table public.usage_events add column if not exists credits_used integer not null default 0;
alter table public.usage_events add column if not exists brand        text;
alter table public.usage_events add column if not exists source       text;
alter table public.usage_events add column if not exists source_url   text;
alter table public.usage_events add column if not exists domain       text;
create index if not exists usage_events_created_idx on public.usage_events (created_at desc);
create index if not exists usage_events_user_idx    on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_store_idx   on public.usage_events (store_id, created_at desc);
create index if not exists usage_events_domain_idx  on public.usage_events (domain, created_at desc);

create table if not exists public.blocked_domains (
  domain     text primary key,               -- lower-case host, no "www."
  note       text,
  blocked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- ── 8. Row level security ────────────────────────────────────────────────────
alter table public.b2b_companies        enable row level security;
alter table public.b2b_stores           enable row level security;
alter table public.b2b_devices          enable row level security;
alter table public.b2b_plans            enable row level security;
alter table public.b2b_store_features   enable row level security;
alter table public.customer_folders     enable row level security;
alter table public.customer_tryons      enable row level security;
alter table public.b2b_credit_ledger    enable row level security;
alter table public.b2b_subscriptions    enable row level security;
alter table public.b2b_subscription_log enable row level security;
alter table public.notifications        enable row level security;
alter table public.app_events           enable row level security;
alter table public.usage_events         enable row level security;
alter table public.app_settings         enable row level security;
alter table public.blocked_domains      enable row level security;

-- Admins: full access everywhere (the dashboard signs in as an admin).
do $$
declare t text;
begin
  foreach t in array array['b2b_companies', 'b2b_stores', 'b2b_devices', 'b2b_plans', 'b2b_store_features',
    'customer_folders', 'customer_tryons', 'b2b_credit_ledger', 'b2b_subscriptions', 'b2b_subscription_log',
    'notifications', 'app_events', 'usage_events', 'app_settings', 'blocked_domains']
  loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- A store login: its own store, its company, its own rows. Read-only except
-- customer folders / results, which the iPad writes directly.
drop policy if exists store_own on public.b2b_stores;
create policy store_own on public.b2b_stores for select to authenticated
  using (store_id = public.current_store_id());

drop policy if exists company_own on public.b2b_companies;
create policy company_own on public.b2b_companies for select to authenticated
  using (company_id = public.current_company_id());

drop policy if exists devices_own on public.b2b_devices;
create policy devices_own on public.b2b_devices for select to authenticated
  using (store_id = public.current_store_id());

drop policy if exists plans_read on public.b2b_plans;
create policy plans_read on public.b2b_plans for select to authenticated using (active);

drop policy if exists features_own on public.b2b_store_features;
create policy features_own on public.b2b_store_features for select to authenticated
  using (store_id = public.current_store_id());

drop policy if exists folders_read on public.customer_folders;
create policy folders_read on public.customer_folders for select to authenticated
  using (store_id = public.current_store_id() and expires_at > now());
drop policy if exists folders_insert on public.customer_folders;
create policy folders_insert on public.customer_folders for insert to authenticated
  with check (store_id = public.current_store_id());
drop policy if exists folders_update on public.customer_folders;
create policy folders_update on public.customer_folders for update to authenticated
  using (store_id = public.current_store_id() and expires_at > now())
  with check (store_id = public.current_store_id());
drop policy if exists folders_delete on public.customer_folders;
create policy folders_delete on public.customer_folders for delete to authenticated
  using (store_id = public.current_store_id());

drop policy if exists tryons_own on public.customer_tryons;
create policy tryons_own on public.customer_tryons for all to authenticated
  using (store_id = public.current_store_id())
  with check (store_id = public.current_store_id());

drop policy if exists ledger_own on public.b2b_credit_ledger;
create policy ledger_own on public.b2b_credit_ledger for select to authenticated
  using (store_id = public.current_store_id());

drop policy if exists subscriptions_own on public.b2b_subscriptions;
create policy subscriptions_own on public.b2b_subscriptions for select to authenticated
  using (store_id = public.current_store_id());

drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select to authenticated
  using (
    (recipient_type = 'b2b_store' and channel = 'tablet' and recipient_id = public.current_store_id())
    or (recipient_type = 'b2c_user' and channel = 'in_app' and recipient_id = auth.uid()::text)
  );

drop policy if exists usage_own on public.usage_events;
create policy usage_own on public.usage_events for select to authenticated using (user_id = auth.uid());

-- The Company page lists the other stores of the same company — names and
-- addresses only (never emails or password hashes).
create or replace function public.my_company_stores()
returns table (store_id text, store_name text, city text, store_address text)
language sql
stable
security definer
set search_path = public
as $$
  select s.store_id, s.store_name, s.city, s.store_address
  from public.b2b_stores s
  where s.company_id = public.current_company_id()
  order by s.created_at
$$;
revoke execute on function public.my_company_stores() from public, anon;
grant execute on function public.my_company_stores() to authenticated;

-- ── 9. Storage: private bucket, one folder per store ─────────────────────────
-- Paths: <store_id>/<folder_id>/<file>.jpg
insert into storage.buckets (id, name, public)
values ('customer-photos', 'customer-photos', false)
on conflict (id) do nothing;

drop policy if exists customer_photos_rw on storage.objects;
create policy customer_photos_rw on storage.objects for all to authenticated
  using (bucket_id = 'customer-photos' and (storage.foldername(name))[1] = public.current_store_id())
  with check (bucket_id = 'customer-photos' and (storage.foldername(name))[1] = public.current_store_id());

-- ── 10. Credit functions (service role / admin only) ─────────────────────────
-- consume: refuses paused stores, ended trials and plans past renewal + grace.
create or replace function public.consume_store_credit(
  p_store_id text, p_feature text default 'tryon', p_device_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.b2b_stores;
  v_status text := public.store_effective_status(p_store_id);
begin
  select * into s from public.b2b_stores where store_id = p_store_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_store', 'credits_balance', 0);
  end if;
  if v_status in ('suspended', 'revoked') then
    return jsonb_build_object('allowed', false, 'reason', 'inactive', 'credits_balance', s.credits_balance);
  end if;
  if v_status = 'trial' and s.trial_ends_at < now() then
    return jsonb_build_object('allowed', false, 'reason', 'trial_ended', 'credits_balance', s.credits_balance);
  end if;
  if s.renewal_at is not null
     and s.renewal_at + make_interval(days => public.setting_int('b2b_grace_days', 7)) < now() then
    return jsonb_build_object('allowed', false, 'reason', 'expired', 'credits_balance', s.credits_balance);
  end if;
  if s.credits_balance <= 0 then
    return jsonb_build_object('allowed', false, 'reason', 'no_credits', 'credits_balance', 0);
  end if;
  update public.b2b_stores set credits_balance = credits_balance - 1, updated_at = now()
    where store_id = p_store_id returning * into s;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, feature, device_id)
  values (p_store_id, -1, s.credits_balance, 'usage', p_feature, p_device_id);
  return jsonb_build_object('allowed', true, 'reason', null, 'credits_balance', s.credits_balance);
end;
$$;

create or replace function public.refund_store_credit(
  p_store_id text, p_feature text default 'tryon', p_device_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance int;
begin
  update public.b2b_stores set credits_balance = credits_balance + 1, updated_at = now()
    where store_id = p_store_id returning credits_balance into v_balance;
  if found then
    insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, feature, device_id, note)
    values (p_store_id, 1, v_balance, 'refund', p_feature, p_device_id, 'generation failed');
  end if;
end;
$$;

-- Dashboard "Grant credits" / "Top up" / correction. p_delta may be negative.
create or replace function public.adjust_store_credits(
  p_store_id text, p_delta integer, p_reason text default 'grant',
  p_admin_id uuid default null, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance int;
begin
  if p_reason not in ('grant', 'topup', 'adjustment', 'refund') then
    raise exception 'adjust_store_credits: invalid reason %', p_reason;
  end if;
  update public.b2b_stores set credits_balance = credits_balance + p_delta, updated_at = now()
    where store_id = p_store_id and credits_balance + p_delta >= 0
    returning credits_balance into v_balance;
  if not found then raise exception 'adjust_store_credits: unknown store or balance would go below 0'; end if;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, admin_id, note)
  values (p_store_id, p_delta, v_balance, p_reason, p_admin_id, p_note);
  return v_balance;
end;
$$;

-- Start ('activated') or renew a billing period from the store's plan: sets the
-- credits, moves renewal_at on one cycle, writes ledger + subscription + log.
create or replace function public.renew_store_plan(
  p_store_id text, p_admin_id uuid default null, p_action text default 'renewed',
  p_rollover boolean default false, p_amount_inr integer default null,
  p_payment_status text default 'due', p_payment_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.b2b_stores;
  p public.b2b_plans;
  v_start timestamptz;
  v_end timestamptz;
  v_balance int;
  v_amount int;
begin
  if p_action not in ('activated', 'renewed') then
    raise exception 'renew_store_plan: action must be activated or renewed';
  end if;
  select * into s from public.b2b_stores where store_id = p_store_id for update;
  if not found then raise exception 'renew_store_plan: unknown store'; end if;
  select * into p from public.b2b_plans where id = s.subscription_plan;
  if not found then raise exception 'renew_store_plan: unknown plan %', s.subscription_plan; end if;

  v_start := case when p_action = 'renewed' and s.renewal_at is not null then s.renewal_at else now() end;
  v_end := v_start + case when p.cycle = 'annual' then interval '1 year' else interval '1 month' end;
  v_balance := case when p_rollover then s.credits_balance + p.credits_included else p.credits_included end;
  v_amount := coalesce(p_amount_inr, p.price_inr);

  update public.b2b_stores
    set credits_balance = v_balance, renewal_at = v_end, trial_ends_at = null, updated_at = now()
    where store_id = p_store_id;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, admin_id, note)
  values (p_store_id, v_balance - s.credits_balance, v_balance,
          case when p_action = 'activated' then 'plan' else 'renewal' end, p_admin_id, p.name);
  insert into public.b2b_subscriptions
    (store_id, plan_id, cycle, started_at, renewal_at, amount_inr, credits_granted, payment_status, payment_ref)
  values (p_store_id, p.id, p.cycle, v_start, v_end, v_amount, p.credits_included, p_payment_status, p_payment_ref);
  insert into public.b2b_subscription_log (store_id, action, plan_id, amount_inr, admin_id)
  values (p_store_id, p_action, p.id, v_amount, p_admin_id);
  return jsonb_build_object('credits_balance', v_balance, 'renewal_at', v_end);
end;
$$;

-- Change plan mid-cycle; the dashboard decides the credit difference.
create or replace function public.change_store_plan(
  p_store_id text, p_plan_id text, p_admin_id uuid default null,
  p_credit_delta integer default 0, p_amount_inr integer default null, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.b2b_stores;
  v_old_price int;
  v_new_price int;
  v_balance int;
begin
  select * into s from public.b2b_stores where store_id = p_store_id for update;
  if not found then raise exception 'change_store_plan: unknown store'; end if;
  select price_inr into v_new_price from public.b2b_plans where id = p_plan_id;
  if not found then raise exception 'change_store_plan: unknown plan %', p_plan_id; end if;
  select price_inr into v_old_price from public.b2b_plans where id = s.subscription_plan;

  v_balance := greatest(0, s.credits_balance + p_credit_delta);
  update public.b2b_stores set subscription_plan = p_plan_id, credits_balance = v_balance, updated_at = now()
    where store_id = p_store_id;
  if v_balance <> s.credits_balance then
    insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, admin_id, note)
    values (p_store_id, v_balance - s.credits_balance, v_balance, 'plan', p_admin_id,
            coalesce(p_note, 'plan change to ' || p_plan_id));
  end if;
  insert into public.b2b_subscription_log (store_id, action, plan_id, amount_inr, admin_id, note)
  values (p_store_id, case when coalesce(v_old_price, 0) <= v_new_price then 'upgraded' else 'downgraded' end,
          p_plan_id, p_amount_inr, p_admin_id, p_note);
  return v_balance;
end;
$$;

-- Activate / suspend / deactivate a store, or start a trial, with a log entry.
create or replace function public.set_store_status(
  p_store_id text, p_status text, p_admin_id uuid default null,
  p_note text default null, p_trial_ends_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('active', 'inactive', 'suspended') then
    raise exception 'set_store_status: status must be active, inactive or suspended';
  end if;
  update public.b2b_stores
    set status = p_status,
        trial_ends_at = coalesce(p_trial_ends_at, trial_ends_at),
        updated_at = now()
    where store_id = p_store_id;
  if not found then raise exception 'set_store_status: unknown store'; end if;
  insert into public.b2b_subscription_log (store_id, action, plan_id, admin_id, note)
  select p_store_id,
         case when p_trial_ends_at is not null then 'trial_started'
              when p_status = 'suspended' then 'suspended'
              when p_status = 'inactive' then 'deactivated'
              else 'reactivated' end,
         subscription_plan, p_admin_id, p_note
  from public.b2b_stores where store_id = p_store_id;
end;
$$;

-- Feature toggle. At least one feature must stay on ('last_feature' error).
create or replace function public.set_store_feature(
  p_store_id text, p_feature text, p_enabled boolean, p_admin_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_on int;
begin
  if p_feature not in ('tryon', 'style', 'size') then
    raise exception 'set_store_feature: unknown feature %', p_feature;
  end if;
  insert into public.b2b_store_features (store_id, feature, enabled, changed_by, changed_at)
  values (p_store_id, p_feature, p_enabled, p_admin_id, now())
  on conflict (store_id, feature) do update
    set enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = now();
  select count(*) into v_on
  from unnest(array['tryon', 'style', 'size']) f(name)
  left join public.b2b_store_features sf on sf.store_id = p_store_id and sf.feature = f.name
  where coalesce(sf.enabled, true);
  if v_on = 0 then raise exception 'last_feature'; end if;
end;
$$;

-- Daily: suspend stores whose trial ended or renewal is past the grace window.
create or replace function public.expire_b2b_stores()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select store_id, subscription_plan,
           (trial_ends_at is not null and renewal_at is null and trial_ends_at < now()) as trial_over
    from public.b2b_stores
    where status = 'active'
      and ((trial_ends_at is not null and renewal_at is null and trial_ends_at < now())
        or (renewal_at is not null
            and renewal_at + make_interval(days => public.setting_int('b2b_grace_days', 7)) < now()))
    for update
  loop
    update public.b2b_stores set status = 'suspended', updated_at = now() where store_id = r.store_id;
    insert into public.b2b_subscription_log (store_id, action, plan_id, note)
    values (r.store_id, case when r.trial_over then 'trial_ended' else 'expired' end,
            r.subscription_plan, 'auto-suspended by daily job');
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function public.setting_int(text, int) from public, anon, authenticated;
revoke execute on function public.store_effective_status(text) from public, anon;
grant execute on function public.store_effective_status(text) to authenticated; -- used by b2b_store_summary
revoke execute on function public.consume_store_credit(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.refund_store_credit(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.adjust_store_credits(text, integer, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.renew_store_plan(text, uuid, text, boolean, integer, text, text) from public, anon, authenticated;
revoke execute on function public.change_store_plan(text, text, uuid, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.set_store_status(text, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.set_store_feature(text, text, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.expire_b2b_stores() from public, anon, authenticated;

-- ── 11. One row per store for the dashboard's Stores list ────────────────────
create or replace view public.b2b_store_summary
with (security_invoker = true) as
select
  s.store_id, s.store_name, s.store_email, s.city, s.company_id,
  c.company_name, c.brand_name, c.logo_url, c.status as company_status,
  s.subscription_plan, p.price_inr, p.credits_included, s.credits_balance,
  greatest(0, coalesce(p.credits_included, 0) - s.credits_balance) as credits_used_this_cycle,
  s.status, public.store_effective_status(s.store_id) as effective_status,
  s.trial_ends_at, s.renewal_at, s.created_at,
  (select count(*) from public.b2b_devices d where d.store_id = s.store_id
     and d.last_seen > now() - interval '30 days') as active_ipads,
  (select count(*) from public.customer_folders f where f.store_id = s.store_id
     and f.expires_at > now()) as active_customer_folders,
  (select count(*) from public.usage_events u where u.store_id = s.store_id and u.feature = 'tryon'
     and u.status = 'success' and u.created_at > date_trunc('month', now())) as tryons_this_month,
  (select max(d.last_seen) from public.b2b_devices d where d.store_id = s.store_id) as last_activity_at
from public.b2b_stores s
left join public.b2b_companies c on c.company_id = s.company_id
left join public.b2b_plans p on p.id = s.subscription_plan;

revoke all on public.b2b_store_summary from anon;

-- =============================================================================
-- Onboarding a store (until the dashboard does it):
--   1. Add the company + store rows (dashboard, or SQL) with store_email set.
--   2. Supabase → Authentication → Users → Add user with the SAME email and a
--      password ("Auto confirm" on). That login now opens the store app.
--   3. Start the first billing period (credits + renewal date):
--        select public.renew_store_plan('<store_id>', null, 'activated');
--   Optional: select public.set_store_feature('<store_id>', 'size', false);
-- =============================================================================
