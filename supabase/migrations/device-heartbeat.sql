-- =============================================================================
-- device_heartbeat(): the store app's check-in, every 30 s (frontend/lib/heartbeat.ts).
-- This function was created in the database outside this repo (with the admin
-- panel's store invite/activation work); this file records the live definition
-- as of 2026-11-07 so the repo matches production. Idempotent (create or replace).
--
-- store_status it returns, which the app turns into a lock screen unless 'active':
--   revoked / suspended  from store_effective_status()
--   pending              b2b_stores.activated_at is null (store not activated yet)
--   active               active, or still on its free trial
-- Needs: b2b_devices.device_code / device_key / signed_out_at / app_version,
-- b2b_stores.activated_at, store_effective_status(), store_feature_enabled().
-- =============================================================================

create or replace function public.device_heartbeat(
  p_device_code text,
  p_device_key text,
  p_app_version text default null,
  p_signed_out boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_store_id      text;
  v_device_status text;
  v_activated     timestamptz;
  v_eff           text;
  v_status        text;
begin
  update public.b2b_devices d
     set last_seen     = now(),                                  -- server clock, not the tablet's
         signed_out_at = case when p_signed_out then now() else null end,
         app_version   = coalesce(p_app_version, d.app_version)
   where d.device_code = p_device_code
     and d.device_key is not null
     and d.device_key = p_device_key
  returning d.store_id, d.status into v_store_id, v_device_status;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_device');
  end if;

  select activated_at into v_activated from public.b2b_stores where store_id = v_store_id;
  v_eff := public.store_effective_status(v_store_id);
  v_status := case
    when v_eff in ('revoked', 'suspended') then v_eff
    when v_activated is null               then 'pending'
    when v_eff = 'trial'                   then 'active'
    else v_eff
  end;

  return jsonb_build_object(
    'ok', true,
    'store_status', v_status,
    'device_status', v_device_status,
    'features', jsonb_build_object(
      'tryon', public.store_feature_enabled(v_store_id, 'tryon'),
      'style', public.store_feature_enabled(v_store_id, 'style'),
      'size',  public.store_feature_enabled(v_store_id, 'size')
    ),
    'server_time', now()
  );
end;
$function$;
