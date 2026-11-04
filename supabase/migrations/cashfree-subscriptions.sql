-- =============================================================================
-- Cashfree premium subscriptions (₹499 / month → 30 credits). Run once in the
-- Supabase SQL editor. Idempotent.
--
-- Model: monthly ONE-TIME orders. Credits are granted only by the SERVER
-- (service role) after Cashfree verification (webhook signature or status check).
-- Premium becomes METERED at 30 credits/period (previously unlimited).
-- =============================================================================

-- 1) Subscription state on the membership row (server-written only; RLS unchanged
--    — memberships already has SELECT-own and no client write policies).
alter table public.memberships add column if not exists subscription_status text;   -- active | cancelled | null
alter table public.memberships add column if not exists provider            text;    -- 'cashfree'
alter table public.memberships add column if not exists current_order_id     text;
alter table public.memberships add column if not exists last_txn_id          text;
alter table public.memberships add column if not exists period_end           timestamptz;

-- 2) Premium is now metered at 30. Backfill existing premium rows so they aren't
--    suddenly capped at the free default (3), and reset their period counter.
update public.memberships
  set tryon_limit = 30
  where plan = 'premium' and (tryon_limit is null or tryon_limit < 30);

-- 3) payment_orders — our order_id ↔ user_id map (source of truth for who a
--    Cashfree order belongs to). Service role writes; users may read their own.
create table if not exists public.payment_orders (
  order_id   text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  plan       text not null default 'premium',
  amount     numeric not null,
  currency   text not null default 'INR',
  cf_order_id text,
  status     text not null default 'created',   -- created | paid
  created_at timestamptz not null default now()
);
alter table public.payment_orders enable row level security;
drop policy if exists "Users read own orders" on public.payment_orders;
create policy "Users read own orders" on public.payment_orders
  for select using (auth.uid() = user_id);

-- 4) payment_events — idempotency ledger. One row per processed payment (keyed by
--    order_id). A duplicate insert (unique PK) means "already granted" → no
--    double-grant. Service role only (no policies → clients can't read/write).
create table if not exists public.payment_events (
  id         text primary key,          -- orderId (stable key; webhook + status share it)
  order_id   text,
  user_id    uuid references auth.users (id) on delete cascade,
  event_type text not null default 'payment_success',
  created_at timestamptz not null default now()
);
alter table public.payment_events enable row level security;
-- no policies: only the service role (server) may touch this table.

-- 5) Meter premium in the atomic spend RPC. Previously premium was never blocked;
--    now BOTH plans are capped by tryon_limit (premium = 30, free = 3).
create or replace function public.consume_tryon(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.memberships;
  v_allowed boolean;
begin
  insert into public.memberships (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  select * into m from public.memberships where user_id = p_user_id for update;

  if m.tryon_used < m.tryon_limit then
    update public.memberships
      set tryon_used = tryon_used + 1, updated_at = now()
      where user_id = p_user_id
      returning * into m;
    v_allowed := true;
  else
    v_allowed := false;
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'plan', m.plan,
    'tryon_used', m.tryon_used,
    'tryon_limit', m.tryon_limit
  );
end;
$$;

-- 6) Refund now applies to premium too (premium is metered, so its counter is real).
create or replace function public.refund_tryon(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.memberships
    set tryon_used = greatest(0, tryon_used - 1), updated_at = now()
    where user_id = p_user_id;
$$;
