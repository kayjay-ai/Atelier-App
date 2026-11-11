-- =============================================================================
-- Owner portal (docs: "Atelier — Owner Portal User Flow", Nov 2026).
-- Idempotent; run in the Supabase SQL editor AFTER b2b-integration.sql,
-- b2b-payments.sql and b2b-store-credits.sql.
--
-- Model (mapped onto the existing B2B schema):
--   • Organization  = b2b_companies. Its company_code is the "Store code" Atelier
--     gives the owner; its manager_email is the owner's registered email.
--   • Owner         = b2b_owners: one per company (v1). A Supabase Auth user once
--     activated (code + email → email OTP → password).
--   • Store         = b2b_stores. An owner-invited store's login (store_email) is
--     its manager's email; activated_at is set when the manager accepts.
--   • Store invite  = b2b_store_invites: single-use link, 7 days. The link's
--     secret is an HMAC the API derives from token_nonce with a server key —
--     the database never holds a usable token.
--   • OTP codes, owner sessions, audit log and the owner's notification feed.
-- Every new table is written ONLY by the API (service role): RLS is on with no
-- client policies. The API checks the organization on every owner call.
-- =============================================================================

-- ── 0. Columns the admin panel added outside the repo (no-ops when present) ──
alter table public.b2b_companies add column if not exists company_code text;
alter table public.b2b_companies add column if not exists manager_email text;
alter table public.b2b_stores add column if not exists manager_name text;
alter table public.b2b_stores add column if not exists manager_phone text;
alter table public.b2b_stores add column if not exists invited_at timestamptz;
alter table public.b2b_stores add column if not exists activated_at timestamptz;
alter table public.b2b_stores add column if not exists deactivated_at timestamptz;
create index if not exists b2b_companies_code_upper_idx on public.b2b_companies (upper(company_code));
create index if not exists b2b_companies_manager_email_lower_idx on public.b2b_companies (lower(manager_email));

-- Card payments: what the Cashfree webhook reports (last 4 digits only).
alter table public.b2b_payments add column if not exists payment_method text;
alter table public.b2b_payments add column if not exists method_last4 text;

-- ── 1. Owners ────────────────────────────────────────────────────────────────
create table if not exists public.b2b_owners (
  owner_id           uuid primary key default gen_random_uuid(),
  company_id         uuid not null unique references public.b2b_companies (company_id) on delete cascade,
  user_id            uuid unique references auth.users (id) on delete set null,
  email              text not null,
  name               text,
  phone              text,
  activated_at       timestamptz,
  failed_login_count integer not null default 0,
  failed_login_since timestamptz,
  locked_until       timestamptz,
  notify_prefs       jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists b2b_owners_email_lower_idx on public.b2b_owners (lower(email));

-- ── 2. One-time codes (activation / password reset) ──────────────────────────
-- code_hash and token_hash are HMACs keyed by the API; never plain text.
create table if not exists public.b2b_owner_otps (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.b2b_companies (company_id) on delete cascade,
  email            text not null,
  purpose          text not null check (purpose in ('activation', 'reset')),
  code_hash        text not null,
  expires_at       timestamptz not null,
  attempts         integer not null default 0,
  consumed_at      timestamptz,             -- used, replaced by a newer code, or too many tries
  token_hash       text,                    -- short-lived activation / reset token after a correct code
  token_expires_at timestamptz,
  token_used_at    timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists b2b_owner_otps_email_idx on public.b2b_owner_otps (lower(email), purpose, created_at desc);

-- ── 3. Owner sessions (one row per Supabase session the API signed in) ───────
create table if not exists public.b2b_owner_sessions (
  session_id   uuid primary key,             -- the Supabase session id (JWT session_id)
  owner_id     uuid not null references public.b2b_owners (owner_id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  remember     boolean not null default false, -- "Keep me signed in": 30 days, else 24 hours
  expires_at   timestamptz not null,
  user_agent   text,
  ip           text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz
);
create index if not exists b2b_owner_sessions_owner_idx on public.b2b_owner_sessions (owner_id, last_seen_at desc);

-- ── 4. Store invites ─────────────────────────────────────────────────────────
create table if not exists public.b2b_store_invites (
  id            uuid primary key default gen_random_uuid(),
  store_id      text not null references public.b2b_stores (store_id) on delete cascade,
  company_id    uuid not null references public.b2b_companies (company_id) on delete cascade,
  manager_name  text not null,
  manager_email text not null,
  manager_phone text,
  note          text,
  token_nonce   text not null,
  status        text not null default 'sent' check (status in ('sent', 'accepted', 'revoked', 'expired')),
  email_status  text not null default 'sent' check (email_status in ('sent', 'failed', 'skipped')),
  email_error   text,
  sent_at       timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '7 days'),
  accepted_at   timestamptz,
  created_by    uuid references public.b2b_owners (owner_id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists b2b_store_invites_store_idx on public.b2b_store_invites (store_id, created_at desc);
create index if not exists b2b_store_invites_email_idx on public.b2b_store_invites (lower(manager_email), status);

-- ── 5. Audit log of owner actions ────────────────────────────────────────────
create table if not exists public.b2b_owner_audit (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid references public.b2b_owners (owner_id) on delete set null,
  company_id      uuid references public.b2b_companies (company_id) on delete cascade,
  action          text not null,   -- invite_sent, invite_resent, invite_revoked, invite_email_changed,
                                   -- store_deleted, store_deactivated, password_changed, password_reset,
                                   -- account_activated, sessions_revoked, profile_updated
  target_store_id text,            -- no FK: the row outlives a deleted store
  metadata        jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists b2b_owner_audit_company_idx on public.b2b_owner_audit (company_id, created_at desc);

-- ── 6. The owner's notification feed (kept 90 days) ──────────────────────────
create table if not exists public.b2b_owner_notifications (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.b2b_companies (company_id) on delete cascade,
  owner_id    uuid references public.b2b_owners (owner_id) on delete cascade,
  category    text not null check (category in ('purchases', 'payments', 'store_activity', 'deals', 'gift_cards', 'account')),
  title       text not null,
  body        text not null,
  store_id    text,
  store_name  text,                    -- shown in bold; kept if the store is deleted
  link        jsonb,                   -- where tapping it goes: { screen, storeId?, section? }
  data        jsonb,                   -- offers / gift cards: { expiresAt, cta, code, amountInr }
  dedupe_key  text,                    -- the daily job never posts the same event twice
  is_read     boolean not null default false,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '90 days')
);
create index if not exists b2b_owner_notifications_feed_idx
  on public.b2b_owner_notifications (company_id, created_at desc, id desc);
create unique index if not exists b2b_owner_notifications_dedupe_idx
  on public.b2b_owner_notifications (company_id, dedupe_key) where dedupe_key is not null;

alter table public.b2b_owners              enable row level security;
alter table public.b2b_owner_otps          enable row level security;
alter table public.b2b_owner_sessions      enable row level security;
alter table public.b2b_store_invites       enable row level security;
alter table public.b2b_owner_audit         enable row level security;
alter table public.b2b_owner_notifications enable row level security;

-- Admins (dashboard) see everything, like the other B2B tables.
do $$
declare t text;
begin
  foreach t in array array['b2b_owners', 'b2b_owner_otps', 'b2b_owner_sessions', 'b2b_store_invites',
    'b2b_owner_audit', 'b2b_owner_notifications']
  loop
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- ── 7. One row per store for the owner's dashboard ───────────────────────────
-- owner_status (what the owner sees), derived at read time so it never goes stale:
--   deactivated     the store row is inactive (owner or Atelier turned it off)
--   invited         no manager yet; invite still valid
--   invite_expired  no manager yet; invite unused for 7 days (or none on file)
--   pending         manager set up their login; no credit package bought yet
--   expired         package period ended, credits at zero, or paused for billing
--   low_credits     active, under 10% of the package's credits left
--   active          paid package with credits remaining
create or replace view public.b2b_owner_stores
with (security_invoker = true) as
select
  s.store_id, s.company_id, s.store_name, s.city, s.state, s.store_address, s.pincode,
  s.store_email as manager_email, s.manager_name, s.manager_phone,
  s.created_at, s.invited_at, s.activated_at, s.deactivated_at,
  s.subscription_plan, p.name as plan_name, coalesce(p.credits_included, 0) as package_credits,
  s.renewal_at, s.trial_ends_at,
  coalesce(c.usable_credits, 0) as usable_credits,
  coalesce(c.plan_credits, 0) as plan_credits,
  coalesce(c.topup_credits, 0) as topup_credits,
  c.effective_status,
  greatest(0, coalesce(p.credits_included, 0) - coalesce(c.plan_credits, 0)) as credits_used,
  inv.id as invite_id, inv.status as invite_status, inv.sent_at as invite_sent_at,
  inv.expires_at as invite_expires_at, inv.email_status as invite_email_status,
  (select count(*) from public.b2b_devices d
     where d.store_id = s.store_id and d.status <> 'inactive')::int as devices_connected,
  (select max(pay.paid_at) from public.b2b_payments pay
     where pay.store_id = s.store_id and pay.status = 'paid') as last_payment_at,
  case
    when s.status = 'inactive' then 'deactivated'
    when s.activated_at is null then
      case when inv.id is null and s.invited_at is not null and s.invited_at > now() - interval '7 days' then 'invited'
           when inv.id is not null and inv.status = 'sent' and inv.expires_at > now() then 'invited'
           else 'invite_expired' end
    when s.renewal_at is null and (s.trial_ends_at is null) then 'pending'
    when c.effective_status in ('suspended', 'revoked')
      or (s.renewal_at is not null and s.renewal_at <= now())
      or (s.renewal_at is null and s.trial_ends_at is not null and s.trial_ends_at <= now())
      or coalesce(c.usable_credits, 0) <= 0 then 'expired'
    when coalesce(p.credits_included, 0) > 0 and coalesce(c.usable_credits, 0) < 0.1 * p.credits_included then 'low_credits'
    else 'active'
  end as owner_status
from public.b2b_stores s
left join public.b2b_plans p on p.id = s.subscription_plan
left join public.b2b_store_credits c on c.store_id = s.store_id
left join lateral (
  select i.* from public.b2b_store_invites i
  where i.store_id = s.store_id and i.status <> 'revoked'
  order by i.created_at desc limit 1
) inv on true;

revoke all on public.b2b_owner_stores from anon, authenticated;
grant select on public.b2b_owner_stores to service_role;

-- ── 8. Helpers for the API (service role only) ───────────────────────────────
-- A new store id in the live format ^[A-Z]{4}[0-9]{2}[A-Z]{3}$: company code +
-- running number + the city's first three letters (TEST01MUM).
create or replace function public.owner_new_store_id(p_company_id uuid, p_city text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_city text := upper(left(regexp_replace(coalesce(p_city, ''), '[^A-Za-z]', '', 'g') || 'XXX', 3));
  v_id   text;
begin
  select upper(company_code) into v_code from public.b2b_companies where company_id = p_company_id;
  if v_code is null or v_code !~ '^[A-Z]{4}$' then
    raise exception 'owner_new_store_id: company has no 4-letter company_code';
  end if;
  for n in 1..99 loop
    v_id := v_code || lpad(n::text, 2, '0') || v_city;
    if not exists (select 1 from public.b2b_stores where store_id = v_id) then
      return v_id;
    end if;
  end loop;
  raise exception 'owner_new_store_id: no free store id for % in %', v_code, v_city;
end;
$$;

-- The auth user for an email, if any (activation must not make a second one).
create or replace function public.owner_auth_user_for_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select id from auth.users where lower(email) = lower(trim(p_email)) order by created_at limit 1
$$;

-- End Supabase sessions of a user: all except p_keep, or only p_only.
-- Their refresh tokens go with them, so those devices can't stay signed in.
create or replace function public.owner_revoke_auth_sessions(p_user_id uuid, p_keep uuid default null, p_only uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  n int;
begin
  delete from auth.sessions
  where user_id = p_user_id
    and (p_keep is null or id <> p_keep)
    and (p_only is null or id = p_only);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Net credits spent per store per day (usage minus refunds) since p_since.
create or replace function public.owner_credit_usage(p_company_id uuid, p_since timestamptz, p_store_id text default null)
returns table (store_id text, day date, used integer)
language sql
stable
security definer
set search_path = public
as $$
  select l.store_id, (l.created_at at time zone 'Asia/Kolkata')::date as day, (-sum(l.delta))::int as used
  from public.b2b_credit_ledger l
  join public.b2b_stores s on s.store_id = l.store_id
  where s.company_id = p_company_id
    and (p_store_id is null or l.store_id = p_store_id)
    and l.reason in ('usage', 'refund')
    and l.created_at >= p_since
  group by l.store_id, 2
$$;

revoke execute on function public.owner_new_store_id(uuid, text) from public, anon, authenticated;
revoke execute on function public.owner_auth_user_for_email(text) from public, anon, authenticated;
revoke execute on function public.owner_revoke_auth_sessions(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.owner_credit_usage(uuid, timestamptz, text) from public, anon, authenticated;
grant execute on function public.owner_new_store_id(uuid, text) to service_role;
grant execute on function public.owner_auth_user_for_email(text) to service_role;
grant execute on function public.owner_revoke_auth_sessions(uuid, uuid, uuid) to service_role;
grant execute on function public.owner_credit_usage(uuid, timestamptz, text) to service_role;

-- =============================================================================
-- Setting up an owner (until the admin dashboard does it):
--   1. The company row needs company_code (4 letters, the "Store code") and
--      manager_email (the owner's email). Send the owner both.
--   2. The owner opens the app → Company → Owner → "First time here? Activate
--      your account", enters the code + email, the emailed 6-digit code, and a
--      password. The b2b_owners row is created then.
-- =============================================================================
