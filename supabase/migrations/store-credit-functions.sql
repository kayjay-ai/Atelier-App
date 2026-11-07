-- =============================================================================
-- One consume_store_credit(): merges the repo version and the request-id version
-- that was added to the live database outside this repo. Idempotent; run in the
-- Supabase SQL editor AFTER b2b-payments.sql and b2b-store-credits.sql.
-- If you ever re-run b2b-integration.sql or b2b-payments.sql, run this file again
-- afterwards: those files recreate the old 3-argument version.
--
-- Why: the database had two overloads,
--   consume_store_credit(text, text, uuid)         (repo: top-up split, plan expiry, grace days)
--   consume_store_credit(text, text, uuid, uuid)   (live only: request_id, activation, feature toggles)
-- A call with three named arguments matched both, so PostgREST refused it
-- ("Could not choose the best candidate function") and every store try-on
-- failed before reaching Gemini. The live 4-argument version also never
-- lowered topup_credits, which breaks b2b_stores_topup_within_total once a
-- store's credits are all top-up credits.
--
-- Now there is ONE function with all of it:
--   • p_request_id (optional): the same request is charged once (returns duplicate: true)
--   • refuses: unknown_store, inactive, not_activated, trial_ended, expired,
--     feature_disabled, no_credits
--   • plan credits are spent before top-up credits; ledger records topup_delta
-- Callers with 3 arguments (the API server) and with 4 (request id) both work.
--
-- refund_store_credit keeps its two forms (no clash: the request-id form has a
-- required p_request_id). The request-id form now also gives a top-up credit
-- back as a top-up credit, like the repo form.
-- Needs the live columns b2b_stores.activated_at, b2b_credit_ledger.request_id
-- and b2b_credit_ledger.topup_delta.
-- =============================================================================

drop function if exists public.consume_store_credit(text, text, uuid);

create or replace function public.consume_store_credit(
  p_store_id   text,
  p_feature    text default 'tryon',
  p_device_id  uuid default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  s           public.b2b_stores;
  v_status    text;
  v_old_topup int;
begin
  perform public.expire_store_plan_credits(p_store_id);
  select * into s from public.b2b_stores where store_id = p_store_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'unknown_store', 'credits_balance', 0);
  end if;

  -- Same request again (a retry): it was already charged.
  if p_request_id is not null and exists (
    select 1 from public.b2b_credit_ledger
     where store_id = p_store_id and request_id = p_request_id and reason = 'usage'
  ) then
    return jsonb_build_object('allowed', true, 'reason', null,
                              'credits_balance', s.credits_balance, 'duplicate', true);
  end if;

  v_status := public.store_effective_status(p_store_id);
  if v_status in ('suspended', 'revoked') then
    return jsonb_build_object('allowed', false, 'reason', 'inactive', 'credits_balance', s.credits_balance);
  end if;
  if s.activated_at is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_activated', 'credits_balance', s.credits_balance);
  end if;
  if v_status = 'trial' and s.trial_ends_at < now() then
    return jsonb_build_object('allowed', false, 'reason', 'trial_ended', 'credits_balance', s.credits_balance);
  end if;
  if s.renewal_at is not null
     and s.renewal_at + make_interval(days => public.setting_int('b2b_grace_days', 7)) < now() then
    return jsonb_build_object('allowed', false, 'reason', 'expired', 'credits_balance', s.credits_balance);
  end if;
  if not public.store_feature_enabled(p_store_id, p_feature) then
    return jsonb_build_object('allowed', false, 'reason', 'feature_disabled', 'credits_balance', s.credits_balance);
  end if;
  if s.credits_balance <= 0 then
    return jsonb_build_object('allowed', false, 'reason', 'no_credits', 'credits_balance', 0);
  end if;

  -- Plan credits first: top-up credits only drop once the balance reaches them.
  v_old_topup := s.topup_credits;
  update public.b2b_stores
     set credits_balance = credits_balance - 1,
         topup_credits   = least(topup_credits, credits_balance - 1),
         updated_at      = now()
   where store_id = p_store_id
  returning * into s;
  insert into public.b2b_credit_ledger
    (store_id, delta, balance_after, reason, feature, device_id, topup_delta, request_id)
  values
    (p_store_id, -1, s.credits_balance, 'usage', p_feature, p_device_id,
     s.topup_credits - v_old_topup, p_request_id);

  return jsonb_build_object('allowed', true, 'reason', null, 'credits_balance', s.credits_balance);
end;
$function$;

revoke execute on function public.consume_store_credit(text, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.consume_store_credit(text, text, uuid, uuid) to service_role;

-- Request-id refund: as live, plus a top-up credit goes back to top-up.
create or replace function public.refund_store_credit(
  p_store_id   text,
  p_request_id uuid,
  p_feature    text default 'tryon',
  p_device_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  s        public.b2b_stores;
  v_charge public.b2b_credit_ledger;
  v_topup  int;
begin
  select * into s from public.b2b_stores where store_id = p_store_id for update;
  if not found then
    return jsonb_build_object('refunded', false, 'reason', 'unknown_store');
  end if;

  select * into v_charge from public.b2b_credit_ledger
   where store_id = p_store_id and request_id = p_request_id and reason = 'usage'
   limit 1;
  if not found then
    return jsonb_build_object('refunded', false, 'reason', 'no_matching_charge');
  end if;
  if v_charge.created_at < now() - interval '1 hour' then
    return jsonb_build_object('refunded', false, 'reason', 'too_old');
  end if;
  if exists (select 1 from public.b2b_credit_ledger
              where store_id = p_store_id and request_id = p_request_id and reason = 'refund') then
    return jsonb_build_object('refunded', false, 'reason', 'already_refunded', 'credits_balance', s.credits_balance);
  end if;

  v_topup := case when coalesce(v_charge.topup_delta, 0) < 0 then 1 else 0 end;
  update public.b2b_stores
     set credits_balance = credits_balance + 1,
         topup_credits   = topup_credits + v_topup,
         updated_at      = now()
   where store_id = p_store_id
  returning * into s;
  insert into public.b2b_credit_ledger
    (store_id, delta, balance_after, reason, feature, device_id, note, request_id, topup_delta)
  values
    (p_store_id, 1, s.credits_balance, 'refund', p_feature,
     coalesce(p_device_id, v_charge.device_id), 'generation failed', p_request_id, v_topup);

  return jsonb_build_object('refunded', true, 'credits_balance', s.credits_balance);
end;
$function$;

revoke execute on function public.refund_store_credit(text, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.refund_store_credit(text, uuid, text, uuid) to service_role;
