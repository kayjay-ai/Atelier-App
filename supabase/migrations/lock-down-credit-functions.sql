-- =============================================================================
-- Security fix: the B2C credit functions were callable by any signed-in user
-- (Postgres grants EXECUTE to PUBLIC by default), so anyone could call
-- add_credits / refund_tryon from the browser and mint credits. Only the API
-- server (service role) calls them. Idempotent; skips functions that don't exist.
-- =============================================================================

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.add_credits(uuid, integer, text)',
    'public.consume_tryon(uuid)',
    'public.refund_tryon(uuid)'
  ] loop
    begin
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    exception when undefined_function then
      raise notice 'skipped % (not created yet)', fn;
    end;
  end loop;
end;
$$;
