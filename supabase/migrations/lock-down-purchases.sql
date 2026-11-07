-- =============================================================================
-- B2C purchases: clients may READ their own rows, never write them.
-- Idempotent; run in the Supabase SQL editor after credit-packs.sql.
--
-- Why: credit-packs.sql let a signed-in user insert and UPDATE their own
-- purchases rows. grantCredits() adds the row's credits_granted once Cashfree
-- confirms payment, so a user could raise credits_granted on a pending ₹15
-- order and receive any number of credits. The server (service role) is the
-- only writer — it creates the row (createPurchase) and flips it to paid
-- (grantCredits), and now also checks the paid amount with Cashfree.
-- =============================================================================

drop policy if exists "Users insert own purchases" on public.purchases;
drop policy if exists "Users update own purchases" on public.purchases;

-- Reading your own purchases stays allowed (Premium screen history).
drop policy if exists "Users read own purchases" on public.purchases;
create policy "Users read own purchases" on public.purchases
  for select using (auth.uid() = user_id);
