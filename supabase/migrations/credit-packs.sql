-- =============================================================================
-- Credit-purchase model (replaces the ₹499 / 30-credit subscription entirely).
--
--   • New account = 3 free credits (one-time, not monthly).
--   • Then buy: ₹15 → +1 credit, ₹350 → +30, ₹700 → +100. Purchases STACK.
--   • 1 credit = 1 new (non-cached) generation.
--
-- Credits are granted ONLY by the server (service role) after Cashfree verifies a
-- payment. This migration is idempotent; run once in the Supabase SQL editor.
-- =============================================================================

-- 1) Drop the old ₹499 subscription artifacts (v16). ------------------------------
drop table if exists public.payment_events cascade;
drop table if exists public.payment_orders cascade;

alter table public.memberships drop column if exists subscription_status;
alter table public.memberships drop column if exists provider;
alter table public.memberships drop column if exists current_order_id;
alter table public.memberships drop column if exists last_txn_id;
alter table public.memberships drop column if exists period_end;

-- `plan` is now informational (last purchase type) and may be null — drop the old
-- free/premium check constraint so it accepts per_generation / pack_30 / pack_100.
alter table public.memberships drop constraint if exists memberships_plan_check;
alter table public.memberships alter column plan drop not null;
alter table public.memberships alter column plan drop default;

-- 2) Credit balance on the membership row. --------------------------------------
alter table public.memberships add column if not exists credits_balance   integer not null default 3 check (credits_balance >= 0);
alter table public.memberships add column if not exists free_credits_used  boolean not null default false;

-- Give every existing account the fresh free allowance under the new model.
update public.memberships set credits_balance = 3 where credits_balance is null;

-- 3) purchases — every verified purchase + the idempotency ledger. ----------------
create table if not exists public.purchases (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  type              text not null check (type in ('per_generation','pack_30','pack_100')),
  amount_inr        numeric not null,
  credits_granted   integer not null,
  cashfree_order_id text not null unique,          -- idempotency key
  status            text not null default 'created' check (status in ('created','paid')),
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);
create index if not exists purchases_user_idx on public.purchases (user_id, created_at desc);

-- 4) RLS — users see only their own rows; the server (service role) writes grants.
alter table public.purchases enable row level security;

drop policy if exists "Users read own purchases" on public.purchases;
create policy "Users read own purchases" on public.purchases
  for select using (auth.uid() = user_id);

drop policy if exists "Users insert own purchases" on public.purchases;
create policy "Users insert own purchases" on public.purchases
  for insert with check (auth.uid() = user_id);

drop policy if exists "Users update own purchases" on public.purchases;
create policy "Users update own purchases" on public.purchases
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- NOTE: credit BALANCE is never changed by clients — only add_credits() (service
-- role, below) does that, and only after Cashfree verification. The insert/update
-- policies above just satisfy RLS for the owner; they cannot mint credits.

-- 5) Spend one credit atomically (replaces the old limit-based logic). ------------
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

  if m.credits_balance > 0 then
    update public.memberships
      set credits_balance = credits_balance - 1,
          free_credits_used = (free_credits_used or (m.plan is null)),
          updated_at = now()
      where user_id = p_user_id
      returning * into m;
    v_allowed := true;
  else
    v_allowed := false;
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'plan', m.plan,
    'credits_balance', m.credits_balance
  );
end;
$$;

-- 6) Refund a reserved credit if generation fails. -------------------------------
create or replace function public.refund_tryon(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.memberships
    set credits_balance = credits_balance + 1, updated_at = now()
    where user_id = p_user_id;
$$;

-- 7) Add purchased credits (the ONLY path that increases a balance). --------------
--    Called by the server (service role) after Cashfree verification.
create or replace function public.add_credits(p_user_id uuid, p_amount integer, p_plan text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.memberships (user_id, credits_balance, plan)
  values (p_user_id, 3 + p_amount, p_plan)
  on conflict (user_id) do update
    set credits_balance = public.memberships.credits_balance + p_amount,
        plan = p_plan,
        updated_at = now();
$$;
