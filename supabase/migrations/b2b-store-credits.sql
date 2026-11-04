-- =============================================================================
-- What a store can spend right now, and what state it is in: one place for
-- both rules. The app (row-level security: its own store only) and the API
-- (service role) read this view instead of each re-deriving them.
-- Idempotent; run in the Supabase SQL editor AFTER b2b-payments.sql.
--
--   plan_credits     this cycle's plan credits; 0 once renewal_at has passed
--                    (expire_store_plan_credits() drops them lazily on the next
--                    debit or the daily job, so the raw balance can still hold them)
--   topup_credits    the never-expiring part
--   usable_credits   plan + top-up: what a try-on can spend now
--   effective_status active | trial | suspended | revoked (store_effective_status)
-- =============================================================================

create or replace view public.b2b_store_credits
with (security_invoker = true) as
select
  s.store_id,
  c.plan_credits,
  c.topup_credits,
  c.plan_credits + c.topup_credits as usable_credits,
  public.store_effective_status(s.store_id) as effective_status
from public.b2b_stores s
cross join lateral (
  select
    least(s.topup_credits, s.credits_balance) as topup_credits,
    case
      when s.renewal_at is not null and s.renewal_at <= now() then 0
      else s.credits_balance - least(s.topup_credits, s.credits_balance)
    end as plan_credits
) c;

revoke all on public.b2b_store_credits from anon;
grant select on public.b2b_store_credits to authenticated, service_role;
