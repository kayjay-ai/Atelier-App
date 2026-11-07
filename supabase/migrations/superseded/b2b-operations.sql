-- =============================================================================
-- B2B operations: devices, credit ledger, subscriptions, notifications, events,
-- settings, and the admin functions the dashboard calls. Idempotent; run in the
-- Supabase SQL editor AFTER b2b-companies.sql and usage-events.sql.
--
-- Follows the Admin Dashboard spec §5 and §7. Everything here is written by the
-- service role only (admin dashboard + API server); the iPad app can read a few
-- rows of its own company and nothing else.
--
-- Admin dashboard: prefer the functions in section 9 over raw UPDATEs on
-- clients — they keep credits_balance, the ledger and the subscription log in
-- step. Audit logging (audit_log) stays the dashboard's own responsibility.
-- =============================================================================

-- ── 1. Settings (Super Admin, editable without a code change) ────────────────
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('b2b_low_credit_pct',   '20'),    -- "running low" at ≤ this % of plan credits
  ('b2b_grace_days',       '7'),     -- days after renewal_at before auto-suspend
  ('b2c_low_credit_left',  '1'),     -- B2C "running low" at this many credits
  ('plan_ending_days',     '7'),     -- "plan ending" notice this many days before renewal
  ('notify_auto',          '{"low_credits": true, "out_of_credits": true, "plan_ending": true}'),
  ('notify_cooldown_hours','24'),    -- same template never re-sent within this window
  ('b2c_free_credits',     '3')      -- free credits for a new consumer account
on conflict (key) do nothing;

alter table public.app_settings enable row level security; -- service role only

create or replace function public.setting_int(p_key text, p_default int)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select (value #>> '{}')::int from public.app_settings where key = p_key), p_default)
$$;

-- New consumer accounts get b2c_free_credits (spec §4.3 "Free credit setting").
-- Replaces the trigger function from membership.sql; needs credit-packs.sql.
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

-- ── 2. Devices (iPads) — tracked, never limited ──────────────────────────────
-- device_key is a random id the app generates once per install. The admin can
-- rename a device, assign it to a store, block it, or ask it to sign out.
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  store_id     uuid references public.stores (id) on delete set null,
  device_key   text not null,
  name         text,
  platform     text,
  app_version  text,
  last_user_id uuid references auth.users (id) on delete set null,
  status       text not null default 'active'
                 check (status in ('active', 'blocked', 'sign_out_requested')),
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (client_id, device_key)
);
create index if not exists devices_client_idx on public.devices (client_id, last_seen_at desc);

alter table public.devices enable row level security;
drop policy if exists devices_own on public.devices;
create policy devices_own on public.devices for select to authenticated
  using (client_id = public.current_client_id());

alter table public.customer_folders
  add column if not exists device_id uuid references public.devices (id) on delete set null;

-- ── 3. Company credit ledger ─────────────────────────────────────────────────
-- (public.credit_ledger already belongs to the iframe-partner system, so the
-- B2B pool gets its own table.) Every change to clients.credits_balance made
-- through the functions below writes one row here.
create table if not exists public.client_credit_ledger (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  delta         integer not null,
  balance_after integer not null,
  reason        text not null check (reason in
                  ('plan', 'renewal', 'topup', 'grant', 'refund', 'usage', 'adjustment')),
  feature       text,
  device_id     uuid references public.devices (id) on delete set null,
  admin_id      uuid references auth.users (id) on delete set null,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists client_credit_ledger_client_idx
  on public.client_credit_ledger (client_id, created_at desc);

alter table public.client_credit_ledger enable row level security;
drop policy if exists client_credit_ledger_own on public.client_credit_ledger;
create policy client_credit_ledger_own on public.client_credit_ledger for select to authenticated
  using (client_id = public.current_client_id());

-- ── 4. Subscriptions + subscription log (Plans & Billing) ────────────────────
create table if not exists public.client_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  plan_id         text not null references public.plans (id),
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
create index if not exists client_subscriptions_client_idx
  on public.client_subscriptions (client_id, started_at desc);

create table if not exists public.subscription_log (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  action     text not null check (action in (
               'activated', 'upgraded', 'downgraded', 'renewed', 'cancelled',
               'trial_started', 'trial_ended', 'suspended', 'reactivated', 'revoked', 'expired')),
  plan_id    text references public.plans (id),
  amount_inr integer,
  admin_id   uuid references auth.users (id) on delete set null, -- null = system
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists subscription_log_client_idx on public.subscription_log (client_id, created_at desc);

alter table public.client_subscriptions enable row level security;
alter table public.subscription_log     enable row level security;
-- The store app's Plan page lists its own invoices.
drop policy if exists client_subscriptions_own on public.client_subscriptions;
create policy client_subscriptions_own on public.client_subscriptions for select to authenticated
  using (client_id = public.current_client_id());

-- ── 5. Notifications (credit alerts, plan ending, manual Notify) ─────────────
create table if not exists public.notifications (
  id             uuid primary key default gen_random_uuid(),
  recipient_type text not null check (recipient_type in ('b2c_user', 'b2b_client')),
  recipient_id   uuid not null,                       -- auth user id or client id
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

alter table public.notifications enable row level security;
-- iPads read their company's tablet messages; B2C users read their own in-app ones.
drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select to authenticated
  using (
    (recipient_type = 'b2b_client' and channel = 'tablet' and recipient_id = public.current_client_id())
    or (recipient_type = 'b2c_user' and channel = 'in_app' and recipient_id = auth.uid())
  );

-- ── 6. App events (spec §6 — every dashboard number comes from one) ──────────
-- Feature calls (try-on, style, size …) go to usage_events; lifecycle events
-- (device_session_started, customer_captured, result_saved, …) go here.
create table if not exists public.app_events (
  id         uuid primary key default gen_random_uuid(),
  event      text not null,
  channel    text not null check (channel in ('b2c', 'b2b')),
  user_id    uuid references auth.users (id) on delete set null,
  client_id  uuid references public.clients (id) on delete cascade,
  store_id   uuid references public.stores (id) on delete set null,
  device_id  uuid references public.devices (id) on delete set null,
  folder_id  uuid,                                  -- kept after the folder expires
  metadata   jsonb,
  created_at timestamptz not null default now()
);
create index if not exists app_events_event_idx  on public.app_events (event, created_at desc);
create index if not exists app_events_client_idx on public.app_events (client_id, created_at desc);
alter table public.app_events enable row level security; -- service role only

-- ── 7. usage_events: B2B columns for the Activity pages ──────────────────────
alter table public.usage_events add column if not exists channel      text not null default 'b2c';
alter table public.usage_events add column if not exists client_id    uuid references public.clients (id) on delete cascade;
alter table public.usage_events add column if not exists store_id     uuid references public.stores (id) on delete set null;
alter table public.usage_events add column if not exists device_id    uuid references public.devices (id) on delete set null;
alter table public.usage_events add column if not exists credits_used integer not null default 0;
alter table public.usage_events add column if not exists brand        text;
alter table public.usage_events add column if not exists source       text;   -- link | screenshot | upload | catalog
alter table public.usage_events add column if not exists source_url   text;
alter table public.usage_events add column if not exists domain       text;
create index if not exists usage_events_client_idx on public.usage_events (client_id, created_at desc);
create index if not exists usage_events_domain_idx on public.usage_events (domain, created_at desc);

-- ── 8. Blocked retailer domains (B2C Websites page) ──────────────────────────
create table if not exists public.blocked_domains (
  domain     text primary key,               -- lower-case host, no "www."
  note       text,
  blocked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.blocked_domains enable row level security; -- service role only

-- ── 9. Credit pool functions (service role only) ─────────────────────────────
-- consume: refuses inactive, ended trials and plans past renewal + grace days.
drop function if exists public.consume_client_credit(uuid);
create or replace function public.consume_client_credit(
  p_client_id uuid, p_feature text default 'tryon', p_device_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.clients;
begin
  select * into c from public.clients where id = p_client_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_client', 'credits_balance', 0);
  end if;
  if c.status not in ('active', 'trial') then
    return jsonb_build_object('allowed', false, 'reason', 'inactive', 'credits_balance', c.credits_balance);
  end if;
  if c.status = 'trial' and c.trial_ends_at is not null and c.trial_ends_at < now() then
    return jsonb_build_object('allowed', false, 'reason', 'trial_ended', 'credits_balance', c.credits_balance);
  end if;
  if c.renewal_at is not null
     and c.renewal_at + make_interval(days => public.setting_int('b2b_grace_days', 7)) < now() then
    return jsonb_build_object('allowed', false, 'reason', 'expired', 'credits_balance', c.credits_balance);
  end if;
  if c.credits_balance <= 0 then
    return jsonb_build_object('allowed', false, 'reason', 'no_credits', 'credits_balance', 0);
  end if;
  update public.clients
    set credits_balance = credits_balance - 1, updated_at = now()
    where id = p_client_id
    returning * into c;
  insert into public.client_credit_ledger (client_id, delta, balance_after, reason, feature, device_id)
  values (p_client_id, -1, c.credits_balance, 'usage', p_feature, p_device_id);
  return jsonb_build_object('allowed', true, 'reason', null, 'credits_balance', c.credits_balance);
end;
$$;

drop function if exists public.refund_client_credit(uuid);
create or replace function public.refund_client_credit(
  p_client_id uuid, p_feature text default 'tryon', p_device_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance int;
begin
  update public.clients
    set credits_balance = credits_balance + 1, updated_at = now()
    where id = p_client_id
    returning credits_balance into v_balance;
  if found then
    insert into public.client_credit_ledger (client_id, delta, balance_after, reason, feature, device_id, note)
    values (p_client_id, 1, v_balance, 'refund', p_feature, p_device_id, 'generation failed');
  end if;
end;
$$;

-- Grant, top up or correct credits (dashboard "Grant credits" / "Top up").
-- p_delta may be negative; the balance never goes below 0.
create or replace function public.adjust_client_credits(
  p_client_id uuid, p_delta integer, p_reason text default 'grant',
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
    raise exception 'adjust_client_credits: invalid reason %', p_reason;
  end if;
  update public.clients
    set credits_balance = credits_balance + p_delta, updated_at = now()
    where id = p_client_id and credits_balance + p_delta >= 0
    returning credits_balance into v_balance;
  if not found then
    raise exception 'adjust_client_credits: unknown client or balance would go below 0';
  end if;
  insert into public.client_credit_ledger (client_id, delta, balance_after, reason, admin_id, note)
  values (p_client_id, p_delta, v_balance, p_reason, p_admin_id, p_note);
  return v_balance;
end;
$$;

-- Start or renew a billing period: sets the balance to the plan's credits
-- (or adds them when p_rollover), moves renewal_at on by one cycle, and writes
-- the ledger, a client_subscriptions row and the subscription log.
-- Use p_action 'activated' for a new client's first period.
create or replace function public.renew_client_plan(
  p_client_id uuid, p_admin_id uuid default null, p_action text default 'renewed',
  p_rollover boolean default false, p_amount_inr integer default null,
  p_payment_status text default 'due', p_payment_ref text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.clients;
  p public.plans;
  v_start timestamptz;
  v_end timestamptz;
  v_balance int;
  v_amount int;
begin
  if p_action not in ('activated', 'renewed') then
    raise exception 'renew_client_plan: action must be activated or renewed';
  end if;
  select * into c from public.clients where id = p_client_id for update;
  if not found then raise exception 'renew_client_plan: unknown client'; end if;
  select * into p from public.plans where id = c.plan_id;
  if not found then raise exception 'renew_client_plan: client has no plan'; end if;

  v_start := case when p_action = 'renewed' and c.renewal_at is not null then c.renewal_at else now() end;
  v_end := v_start + case when p.cycle = 'annual' then interval '1 year' else interval '1 month' end;
  v_balance := case when p_rollover then c.credits_balance + p.credits_included else p.credits_included end;
  v_amount := coalesce(p_amount_inr, p.price_inr);

  update public.clients
    set credits_balance = v_balance,
        renewal_at = v_end,
        status = case when status = 'trial' then 'active' else status end,
        updated_at = now()
    where id = p_client_id;

  insert into public.client_credit_ledger (client_id, delta, balance_after, reason, admin_id, note)
  values (p_client_id, v_balance - c.credits_balance, v_balance,
          case when p_action = 'activated' then 'plan' else 'renewal' end, p_admin_id, p.name);
  insert into public.client_subscriptions
    (client_id, plan_id, cycle, started_at, renewal_at, amount_inr, credits_granted, payment_status, payment_ref)
  values (p_client_id, p.id, p.cycle, v_start, v_end, v_amount, p.credits_included, p_payment_status, p_payment_ref);
  insert into public.subscription_log (client_id, action, plan_id, amount_inr, admin_id)
  values (p_client_id, p_action, p.id, v_amount, p_admin_id);

  return jsonb_build_object('credits_balance', v_balance, 'renewal_at', v_end);
end;
$$;

-- Change plan mid-cycle. The dashboard works out the prorated amount and the
-- credit difference to apply (p_credit_delta, may be negative or 0).
-- Feature toggles are not touched (spec §5.4).
create or replace function public.change_client_plan(
  p_client_id uuid, p_plan_id text, p_admin_id uuid default null,
  p_credit_delta integer default 0, p_amount_inr integer default null, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.clients;
  v_old_price int;
  v_new_price int;
  v_balance int;
begin
  select * into c from public.clients where id = p_client_id for update;
  if not found then raise exception 'change_client_plan: unknown client'; end if;
  select price_inr into v_new_price from public.plans where id = p_plan_id;
  if not found then raise exception 'change_client_plan: unknown plan %', p_plan_id; end if;
  select price_inr into v_old_price from public.plans where id = c.plan_id;

  v_balance := greatest(0, c.credits_balance + p_credit_delta);
  update public.clients
    set plan_id = p_plan_id, credits_balance = v_balance, updated_at = now()
    where id = p_client_id;
  if v_balance <> c.credits_balance then
    insert into public.client_credit_ledger (client_id, delta, balance_after, reason, admin_id, note)
    values (p_client_id, v_balance - c.credits_balance, v_balance, 'plan', p_admin_id,
            coalesce(p_note, 'plan change to ' || p_plan_id));
  end if;
  insert into public.subscription_log (client_id, action, plan_id, amount_inr, admin_id, note)
  values (p_client_id,
          case when coalesce(v_old_price, 0) <= v_new_price then 'upgraded' else 'downgraded' end,
          p_plan_id, p_amount_inr, p_admin_id, p_note);
  return v_balance;
end;
$$;

-- Suspend / reactivate / revoke / start a trial, with a log entry.
create or replace function public.set_client_status(
  p_client_id uuid, p_status text, p_admin_id uuid default null,
  p_note text default null, p_trial_ends_at timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  select status into v_old from public.clients where id = p_client_id for update;
  if not found then raise exception 'set_client_status: unknown client'; end if;
  if v_old = 'revoked' then raise exception 'set_client_status: revoked is permanent'; end if;
  update public.clients
    set status = p_status,
        trial_ends_at = case when p_status = 'trial' then coalesce(p_trial_ends_at, trial_ends_at) else trial_ends_at end,
        updated_at = now()
    where id = p_client_id;
  insert into public.subscription_log (client_id, action, plan_id, admin_id, note)
  select p_client_id,
         case p_status
           when 'suspended' then 'suspended'
           when 'revoked'   then 'revoked'
           when 'trial'     then 'trial_started'
           else 'reactivated' end,
         plan_id, p_admin_id, p_note
  from public.clients where id = p_client_id;
end;
$$;

-- Feature toggle (spec §5.3). At least one feature must stay on: turning off the
-- last one raises 'last_feature' so the dashboard can offer "Suspend instead?".
create or replace function public.set_client_feature(
  p_client_id uuid, p_feature text, p_enabled boolean, p_admin_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_on int;
begin
  if p_feature not in ('tryon', 'style', 'size') then
    raise exception 'set_client_feature: unknown feature %', p_feature;
  end if;
  insert into public.client_features (client_id, feature, enabled, changed_by, changed_at)
  values (p_client_id, p_feature, p_enabled, p_admin_id, now())
  on conflict (client_id, feature) do update
    set enabled = excluded.enabled, changed_by = excluded.changed_by, changed_at = now();
  -- A missing row counts as ON.
  select count(*) into v_on
  from unnest(array['tryon', 'style', 'size']) f(name)
  left join public.client_features cf on cf.client_id = p_client_id and cf.feature = f.name
  where coalesce(cf.enabled, true);
  if v_on = 0 then
    raise exception 'last_feature';
  end if;
end;
$$;

-- Daily: suspend companies whose trial ended or whose renewal is past the grace
-- window. Returns how many were suspended. Called by the API server's daily job.
create or replace function public.expire_b2b_clients()
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
    select id, plan_id, status,
           (status = 'trial' and trial_ends_at is not null and trial_ends_at < now()) as trial_over
    from public.clients
    where status in ('active', 'trial')
      and ((status = 'trial' and trial_ends_at is not null and trial_ends_at < now())
        or (renewal_at is not null
            and renewal_at + make_interval(days => public.setting_int('b2b_grace_days', 7)) < now()))
    for update
  loop
    update public.clients set status = 'suspended', updated_at = now() where id = r.id;
    insert into public.subscription_log (client_id, action, plan_id, note)
    values (r.id, case when r.trial_over then 'trial_ended' else 'expired' end, r.plan_id,
            'auto-suspended by daily job');
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke execute on function public.setting_int(text, int) from public, anon, authenticated;
revoke execute on function public.consume_client_credit(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.refund_client_credit(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.adjust_client_credits(uuid, integer, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.renew_client_plan(uuid, uuid, text, boolean, integer, text, text) from public, anon, authenticated;
revoke execute on function public.change_client_plan(uuid, text, uuid, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.set_client_status(uuid, text, uuid, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.set_client_feature(uuid, text, boolean, uuid) from public, anon, authenticated;
revoke execute on function public.expire_b2b_clients() from public, anon, authenticated;

-- ── 10. One row per company for the Clients list (service role reads it) ─────
create or replace view public.b2b_client_summary
with (security_invoker = true) as
select
  c.id, c.company_name, c.logo_url, c.plan_id, p.name as plan_name, p.price_inr,
  p.credits_included, c.credits_balance,
  greatest(0, coalesce(p.credits_included, 0) - c.credits_balance) as credits_used_this_cycle,
  c.status, c.trial_ends_at, c.renewal_at, c.created_at,
  (select count(*) from public.stores s where s.client_id = c.id) as stores,
  (select count(*) from public.devices d where d.client_id = c.id
     and d.last_seen_at > now() - interval '30 days') as active_ipads,
  (select count(*) from public.customer_folders f where f.client_id = c.id
     and f.expires_at > now()) as active_customer_folders,
  (select count(*) from public.usage_events u where u.client_id = c.id and u.feature = 'tryon'
     and u.status = 'success' and u.created_at > date_trunc('month', now())) as tryons_this_month,
  (select max(d.last_seen_at) from public.devices d where d.client_id = c.id) as last_activity_at,
  coalesce((select cf.enabled from public.client_features cf where cf.client_id = c.id and cf.feature = 'tryon'), true) as tryon_on,
  coalesce((select cf.enabled from public.client_features cf where cf.client_id = c.id and cf.feature = 'style'), true) as style_on,
  coalesce((select cf.enabled from public.client_features cf where cf.client_id = c.id and cf.feature = 'size'),  true) as size_on
from public.clients c
left join public.plans p on p.id = c.plan_id;

revoke all on public.b2b_client_summary from anon, authenticated;
