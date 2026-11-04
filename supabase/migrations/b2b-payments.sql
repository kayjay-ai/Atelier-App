-- =============================================================================
-- B2B in-app payments (Cashfree): plans + credit top-ups, paid by the store.
-- Idempotent; run in the Supabase SQL editor AFTER b2b-integration.sql.
--
-- Billing rules (business decision, Nov 2026):
--   1. Plan credits expire at the end of each billing cycle — they never carry over.
--   2. Upgrades are charged the new plan's full price — no proration.
--   3. Any plan payment starts a new cycle that day with the plan's full credits.
--   4. Top-up credits never expire; they survive renewals and upgrades and are
--      spent only after the cycle's plan credits.
--   5. Every payment records the store's acceptance of the current Terms.
-- Plan and pack prices are EXCLUSIVE of GST: the store is charged price + 18% GST
-- (computed by the server; b2b_payments keeps base, GST and total).
--
-- Credit model: b2b_stores.credits_balance stays the TOTAL (so the admin
-- dashboard and the try-on path keep working); the new topup_credits column is
-- the never-expiring part. Plan credits = credits_balance - topup_credits.
-- Usage always takes plan credits first: after a debit, topup_credits is capped
-- at the new total.
-- =============================================================================

-- ── 1. Plans: Starter / Pro / Business / Scale (monthly, prices excl. GST) ───
-- Basic and Ultra are retired (kept, inactive, for stores still on them and for
-- billing history).
alter table public.b2b_plans drop constraint if exists b2b_plans_id_check;
alter table public.b2b_plans add constraint b2b_plans_id_check
  check (id in ('Starter', 'Pro', 'Business', 'Scale', 'Basic', 'Ultra'));

insert into public.b2b_plans (id, name, price_inr, cycle, credits_included, active) values
  ('Starter',  'Starter',   8000, 'monthly', 1000, true),
  ('Pro',      'Pro',      14000, 'monthly', 2000, true),
  ('Business', 'Business', 18000, 'monthly', 3000, true),
  ('Scale',    'Scale',    25000, 'monthly', 5000, true)
on conflict (id) do update
  set name = excluded.name, price_inr = excluded.price_inr, cycle = excluded.cycle,
      credits_included = excluded.credits_included, active = true, updated_at = now();

update public.b2b_plans set active = false, updated_at = now() where id in ('Basic', 'Ultra');
-- New stores were defaulting to the retired Basic plan.
alter table public.b2b_stores alter column subscription_plan set default 'Starter';

-- A store can still read its own (possibly retired) plan, so the app can name it.
drop policy if exists plans_read on public.b2b_plans;
create policy plans_read on public.b2b_plans for select to authenticated
  using (active or id = (select subscription_plan from public.b2b_stores where store_id = public.current_store_id()));

-- ── 2. Top-up packs (never expire) ───────────────────────────────────────────
create table if not exists public.b2b_topup_packs (
  id         text primary key,
  credits    integer not null check (credits > 0),
  price_inr  integer not null check (price_inr > 0),
  active     boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.b2b_topup_packs (id, credits, price_inr) values
  ('topup_100',   100,   900),
  ('topup_500',   500,  4500),
  ('topup_1000', 1000,  9000),
  ('topup_1200', 1200, 10800)
on conflict (id) do update
  set credits = excluded.credits, price_inr = excluded.price_inr, active = true, updated_at = now();

alter table public.b2b_topup_packs enable row level security;
drop policy if exists topup_packs_read on public.b2b_topup_packs;
create policy topup_packs_read on public.b2b_topup_packs for select to authenticated using (active);

-- ── 3. Never-expiring part of the balance ────────────────────────────────────
alter table public.b2b_stores add column if not exists topup_credits integer not null default 0;
do $$ begin
  alter table public.b2b_stores add constraint b2b_stores_topup_within_total
    check (topup_credits >= 0 and topup_credits <= credits_balance);
exception when duplicate_object then null; end $$;

-- How much of a ledger row's delta hit topup_credits (usage: 0 or -1), so a
-- refund can put a failed generation's credit back where it came from.
alter table public.b2b_credit_ledger add column if not exists topup_delta integer not null default 0;

alter table public.b2b_credit_ledger drop constraint if exists b2b_credit_ledger_reason_check;
alter table public.b2b_credit_ledger add constraint b2b_credit_ledger_reason_check
  check (reason in ('plan', 'renewal', 'topup', 'grant', 'refund', 'usage', 'adjustment', 'expiry'));

-- ── 4. Payments (written ONLY by the service role — no client policies) ──────
create table if not exists public.b2b_payments (
  order_id      text primary key,
  store_id      text not null references public.b2b_stores (store_id) on delete restrict,
  company_id    uuid references public.b2b_companies (company_id) on delete set null,
  user_id       uuid references auth.users (id) on delete set null,
  kind          text not null check (kind in ('plan', 'topup')),
  item_id       text not null,          -- plan id or top-up pack id
  item_name     text not null,
  amount_inr    numeric(12,2) not null check (amount_inr > 0),   -- total charged, incl. GST
  base_amount_inr numeric(12,2) not null default 0,              -- plan / pack price (excl. GST)
  gst_inr       numeric(12,2) not null default 0,                -- GST charged on top
  credits       integer not null check (credits > 0),
  -- review = money received but NOT applied (amount mismatch, or a plan payment
  -- that would restart a cycle just paid for) — Atelier refunds or applies by hand.
  status        text not null default 'created' check (status in ('created', 'paid', 'failed', 'review')),
  cf_order_id   text,
  terms_version text not null,
  result        jsonb,
  created_at    timestamptz not null default now(),
  paid_at       timestamptz
);
create index if not exists b2b_payments_store_idx on public.b2b_payments (store_id, created_at desc);
-- (re-run safety if an earlier version of this file created the table)
alter table public.b2b_payments add column if not exists base_amount_inr numeric(12,2) not null default 0;
alter table public.b2b_payments add column if not exists gst_inr numeric(12,2) not null default 0;
alter table public.b2b_payments alter column amount_inr type numeric(12,2);
alter table public.b2b_payments drop constraint if exists b2b_payments_status_check;
alter table public.b2b_payments add constraint b2b_payments_status_check
  check (status in ('created', 'paid', 'failed', 'review'));

alter table public.b2b_payments enable row level security;
drop policy if exists payments_own on public.b2b_payments;
create policy payments_own on public.b2b_payments for select to authenticated
  using (store_id = public.current_store_id());

-- ── 5. Terms & Conditions acceptance (evidence, one row per checkout) ────────
create table if not exists public.b2b_terms_acceptances (
  id            uuid primary key default gen_random_uuid(),
  store_id      text not null references public.b2b_stores (store_id) on delete restrict,
  user_id       uuid references auth.users (id) on delete set null,
  terms_version text not null,
  terms_url     text not null,
  order_id      text references public.b2b_payments (order_id) on delete set null,
  ip            text,
  user_agent    text,
  accepted_at   timestamptz not null default now()
);
create index if not exists b2b_terms_store_idx on public.b2b_terms_acceptances (store_id, accepted_at desc);

alter table public.b2b_terms_acceptances enable row level security;
drop policy if exists terms_own on public.b2b_terms_acceptances;
create policy terms_own on public.b2b_terms_acceptances for select to authenticated
  using (store_id = public.current_store_id());

-- ── 6. Plan-credit expiry (rule 1) ───────────────────────────────────────────
-- Drops the plan part of a store's balance once its cycle has ended. Called
-- before every debit and by the daily job; returns the (possibly new) total.
create or replace function public.expire_store_plan_credits(p_store_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.b2b_stores;
begin
  select * into s from public.b2b_stores where store_id = p_store_id for update;
  if not found then return 0; end if;
  if s.renewal_at is null or s.renewal_at > now() or s.credits_balance <= s.topup_credits then
    return s.credits_balance;
  end if;
  update public.b2b_stores set credits_balance = topup_credits, updated_at = now()
    where store_id = p_store_id;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, note)
  values (p_store_id, s.topup_credits - s.credits_balance, s.topup_credits, 'expiry',
          'plan credits expired at end of cycle');
  return s.topup_credits;
end;
$$;

-- ── 7. Credit functions, top-up aware ────────────────────────────────────────
-- consume: same gates as before; expires ended-cycle plan credits first, then
-- spends plan credits before top-up credits.
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
  v_old_topup int;
begin
  perform public.expire_store_plan_credits(p_store_id);
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
  v_old_topup := s.topup_credits;
  update public.b2b_stores
    set credits_balance = credits_balance - 1,
        topup_credits = least(topup_credits, credits_balance - 1),
        updated_at = now()
    where store_id = p_store_id returning * into s;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, feature, device_id, topup_delta)
  values (p_store_id, -1, s.credits_balance, 'usage', p_feature, p_device_id, s.topup_credits - v_old_topup);
  return jsonb_build_object('allowed', true, 'reason', null, 'credits_balance', s.credits_balance);
end;
$$;

-- Refund a failed generation into the bucket it was spent from: the latest
-- unrefunded usage row of this store / feature / device says whether that was a
-- top-up credit (otherwise a refunded top-up credit would become a plan credit
-- and expire with the cycle).
create or replace function public.refund_store_credit(
  p_store_id text, p_feature text default 'tryon', p_device_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance int;
  v_to_topup boolean;
begin
  perform 1 from public.b2b_stores where store_id = p_store_id for update;
  if not found then return; end if;
  select u.topup_delta < 0 into v_to_topup
  from public.b2b_credit_ledger u
  where u.store_id = p_store_id and u.reason = 'usage'
    and u.feature is not distinct from p_feature
    and u.device_id is not distinct from p_device_id
    and u.created_at > now() - interval '1 hour'
    and not exists (
      select 1 from public.b2b_credit_ledger r
      where r.store_id = u.store_id and r.reason = 'refund'
        and r.feature is not distinct from u.feature
        and r.device_id is not distinct from u.device_id
        and r.created_at >= u.created_at)
  order by u.created_at desc
  limit 1;
  v_to_topup := coalesce(v_to_topup, false);

  update public.b2b_stores
    set credits_balance = credits_balance + 1,
        topup_credits = topup_credits + case when v_to_topup then 1 else 0 end,
        updated_at = now()
    where store_id = p_store_id returning credits_balance into v_balance;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, feature, device_id, note, topup_delta)
  values (p_store_id, 1, v_balance, 'refund', p_feature, p_device_id, 'generation failed',
          case when v_to_topup then 1 else 0 end);
end;
$$;

-- Admin "Top up" now lands in the never-expiring part; other reasons touch the
-- plan part. topup_credits is kept within the total on negative corrections.
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
  update public.b2b_stores
    set credits_balance = credits_balance + p_delta,
        topup_credits = least(credits_balance + p_delta,
                              greatest(0, topup_credits + case when p_reason = 'topup' then p_delta else 0 end)),
        updated_at = now()
    where store_id = p_store_id and credits_balance + p_delta >= 0
    returning credits_balance into v_balance;
  if not found then raise exception 'adjust_store_credits: unknown store or balance would go below 0'; end if;
  insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, admin_id, note)
  values (p_store_id, p_delta, v_balance, p_reason, p_admin_id, p_note);
  return v_balance;
end;
$$;

-- Admin renew (unchanged signature): plan credits are replaced by the plan's
-- allotment; top-up credits are always kept. p_rollover keeps the old plan
-- credits too (manual override only — the paid flow never rolls over).
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
  v_balance := case when p_rollover then s.credits_balance else s.topup_credits end + p.credits_included;
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

-- Admin plan change mid-cycle (unchanged signature). The credit delta lands on
-- the plan part: a negative delta never eats top-up credits, and topup_credits
-- stays within the total (b2b_stores_topup_within_total).
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

  -- Plan part = total - topup; it can't go below 0, so the floor is topup_credits.
  v_balance := greatest(s.topup_credits, s.credits_balance + p_credit_delta);
  update public.b2b_stores
    set subscription_plan = p_plan_id, credits_balance = v_balance,
        topup_credits = least(topup_credits, v_balance), updated_at = now()
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

-- Daily job: expire ended-cycle plan credits, then suspend as before.
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
    select store_id from public.b2b_stores
    where renewal_at is not null and renewal_at <= now() and credits_balance > topup_credits
  loop
    perform public.expire_store_plan_credits(r.store_id);
  end loop;

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

-- ── 8. Paying ────────────────────────────────────────────────────────────────
-- True when a suspended store was suspended by the daily job (trial ended or
-- plan lapsed) rather than by an Atelier admin — only those may pay to reactivate.
create or replace function public.store_suspended_by_expiry(p_store_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select l.action in ('expired', 'trial_ended')
    from public.b2b_subscription_log l
    where l.store_id = p_store_id
      and l.action in ('suspended', 'expired', 'trial_ended', 'reactivated', 'deactivated', 'activated', 'renewed', 'upgraded', 'downgraded')
    order by l.created_at desc
    limit 1
  ), false)
$$;

-- Apply a VERIFIED Cashfree payment exactly once (the created→paid flip is the
-- idempotency guard). Amount and credits come from the payment row, which only
-- the service role can write.
create or replace function public.apply_b2b_payment(p_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pay public.b2b_payments;
  s public.b2b_stores;
  p public.b2b_plans;
  old_p public.b2b_plans;
  v_balance int;
  v_end timestamptz;
  v_action text;
  v_had_cycle boolean;
  v_result jsonb;
  v_base int;
begin
  select * into pay from public.b2b_payments where order_id = p_order_id for update;
  if not found then raise exception 'apply_b2b_payment: unknown order %', p_order_id; end if;
  if pay.status = 'paid' then
    return jsonb_build_object('applied', false, 'already_paid', true, 'result', pay.result);
  end if;
  if pay.status = 'review' then
    return jsonb_build_object('applied', false, 'held', true, 'result', pay.result);
  end if;

  select * into s from public.b2b_stores where store_id = pay.store_id for update;
  if not found then raise exception 'apply_b2b_payment: unknown store %', pay.store_id; end if;

  if pay.kind = 'topup' then
    update public.b2b_stores
      set credits_balance = credits_balance + pay.credits,
          topup_credits = topup_credits + pay.credits,
          updated_at = now()
      where store_id = s.store_id returning credits_balance into v_balance;
    insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, note)
    values (s.store_id, pay.credits, v_balance, 'topup', pay.item_name || ' · ' || pay.order_id);
    v_result := jsonb_build_object('kind', 'topup', 'credits_added', pay.credits, 'credits_balance', v_balance);
  else
    select * into p from public.b2b_plans where id = pay.item_id;
    if not found then raise exception 'apply_b2b_payment: unknown plan %', pay.item_id; end if;
    select * into old_p from public.b2b_plans where id = s.subscription_plan;
    v_had_cycle := s.subscription_plan is not null and s.renewal_at is not null and s.renewal_at > now();
    v_action := case
      when not v_had_cycle then 'activated'
      when p.id = s.subscription_plan then 'renewed'
      when p.price_inr > coalesce(old_p.price_inr, 0) then 'upgraded'
      else 'downgraded' end;

    -- Re-check eligibility at pay time (the order was checked when created, but
    -- two orders can both be paid, or an old one paid late). A renewal or
    -- downgrade outside the renew window would restart a cycle the store just
    -- paid for — hold the money for Atelier to refund instead of applying it.
    -- Keep b2b_renew_window_days in step with RENEW_WINDOW_DAYS (server/lib/b2bBilling.mjs).
    if v_action in ('renewed', 'downgraded')
       and s.renewal_at - make_interval(days => public.setting_int('b2b_renew_window_days', 3)) > now() then
      v_result := jsonb_build_object('kind', 'plan', 'held', true, 'error', 'cycle_already_active',
                                     'plan_id', p.id, 'renewal_at', s.renewal_at);
      update public.b2b_payments set status = 'review', result = v_result where order_id = p_order_id;
      return jsonb_build_object('applied', false, 'held', true, 'result', v_result);
    end if;

    -- Invoices (b2b_subscriptions) are GST-exclusive, like admin renewals.
    v_base := coalesce(nullif(round(pay.base_amount_inr), 0), p.price_inr)::int;

    -- Rules 1–4: new cycle today, plan credits replaced, top-ups kept.
    v_end := now() + case when p.cycle = 'annual' then interval '1 year' else interval '1 month' end;
    v_balance := s.topup_credits + p.credits_included;
    update public.b2b_stores
      set subscription_plan = p.id, credits_balance = v_balance, renewal_at = v_end, trial_ends_at = null,
          status = case when status = 'suspended' and public.store_suspended_by_expiry(s.store_id)
                        then 'active' else status end,
          updated_at = now()
      where store_id = s.store_id;
    insert into public.b2b_credit_ledger (store_id, delta, balance_after, reason, note)
    values (s.store_id, v_balance - s.credits_balance, v_balance,
            case when v_action = 'renewed' then 'renewal' else 'plan' end,
            p.name || ' · ' || pay.order_id);
    insert into public.b2b_subscriptions
      (store_id, plan_id, cycle, started_at, renewal_at, amount_inr, credits_granted, payment_status, payment_ref)
    values (s.store_id, p.id, p.cycle, now(), v_end, v_base, p.credits_included, 'paid', pay.order_id);
    insert into public.b2b_subscription_log (store_id, action, plan_id, amount_inr, note)
    values (s.store_id, v_action, p.id, v_base,
            'paid via Cashfree · ' || pay.order_id || ' · ₹' || pay.amount_inr || ' incl. GST');
    v_result := jsonb_build_object('kind', 'plan', 'action', v_action, 'plan_id', p.id,
                                   'credits_balance', v_balance, 'renewal_at', v_end);
  end if;

  update public.b2b_payments set status = 'paid', paid_at = now(), result = v_result where order_id = p_order_id;
  return jsonb_build_object('applied', true, 'result', v_result);
end;
$$;

revoke execute on function public.expire_store_plan_credits(text) from public, anon, authenticated;
revoke execute on function public.consume_store_credit(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.refund_store_credit(text, text, uuid) from public, anon, authenticated;
revoke execute on function public.change_store_plan(text, text, uuid, integer, integer, text) from public, anon, authenticated;
revoke execute on function public.adjust_store_credits(text, integer, text, uuid, text) from public, anon, authenticated;
revoke execute on function public.renew_store_plan(text, uuid, text, boolean, integer, text, text) from public, anon, authenticated;
revoke execute on function public.expire_b2b_stores() from public, anon, authenticated;
revoke execute on function public.store_suspended_by_expiry(text) from public, anon, authenticated;
revoke execute on function public.apply_b2b_payment(text) from public, anon, authenticated;
grant execute on function public.apply_b2b_payment(text) to service_role;

-- Earlier versions of apply_b2b_payment wrote the GST-inclusive total into
-- b2b_subscriptions; bring those rows in line with the GST-exclusive basis.
update public.b2b_subscriptions sub
  set amount_inr = round(pay.base_amount_inr)::int
  from public.b2b_payments pay
  where sub.payment_ref = pay.order_id and pay.base_amount_inr > 0
    and sub.amount_inr <> round(pay.base_amount_inr)::int;

-- ── 9. Dashboard summary: "used this cycle" counts plan credits only ─────────
create or replace view public.b2b_store_summary
with (security_invoker = true) as
select
  s.store_id, s.store_name, s.store_email, s.city, s.company_id,
  c.company_name, c.brand_name, c.logo_url, c.status as company_status,
  s.subscription_plan, p.price_inr, p.credits_included, s.credits_balance,
  greatest(0, coalesce(p.credits_included, 0) - (s.credits_balance - s.topup_credits)) as credits_used_this_cycle,
  s.status, public.store_effective_status(s.store_id) as effective_status,
  s.trial_ends_at, s.renewal_at, s.created_at,
  (select count(*) from public.b2b_devices d where d.store_id = s.store_id
     and d.last_seen > now() - interval '30 days') as active_ipads,
  (select count(*) from public.customer_folders f where f.store_id = s.store_id
     and f.expires_at > now()) as active_customer_folders,
  (select count(*) from public.usage_events u where u.store_id = s.store_id and u.feature = 'tryon'
     and u.status = 'success' and u.created_at > date_trunc('month', now())) as tryons_this_month,
  (select max(d.last_seen) from public.b2b_devices d where d.store_id = s.store_id) as last_activity_at,
  s.topup_credits
from public.b2b_stores s
left join public.b2b_companies c on c.company_id = s.company_id
left join public.b2b_plans p on p.id = s.subscription_plan;

revoke all on public.b2b_store_summary from anon;
