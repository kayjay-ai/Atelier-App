-- =============================================================================
-- Sign-in: personal vs company detection + date of birth (Front-End spec §3.1).
-- Idempotent; run in the Supabase SQL editor after schema.sql, b2b-integration.sql
-- and b2c-app.sql.
--   • account_type_for_email(): 'company' when the email is a company login
--     (b2b_stores.store_email), otherwise 'personal' — also for unknown emails, so the
--     sign-in page can't be used to discover who has a personal account.
--     Service role only: the app asks through POST /api/auth/account-type.
--   • handle_new_user(): a new personal account's date of birth (sent as
--     signup metadata) lands in profiles.date_of_birth straight away, even if
--     the user confirms their email on another device.
-- =============================================================================

-- A store login (b2b_stores.store_email) is 'company'. Same definition as in
-- b2b-integration.sql, so running either file last gives the same result.
create or replace function public.account_type_for_email(p_email text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (
    select 1 from public.b2b_stores where lower(store_email) = lower(trim(p_email))
  ) then 'company' else 'personal' end
$$;

revoke execute on function public.account_type_for_email(text) from public, anon, authenticated;
grant execute on function public.account_type_for_email(text) to service_role;

-- Only a real past date between 1900 and today is accepted from signup metadata.
create or replace function public.dob_from_metadata(meta jsonb)
returns date
language plpgsql
immutable
as $$
declare
  raw text := meta->>'date_of_birth';
  d   date;
begin
  if raw is null or raw !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  begin
    d := raw::date;
  exception when others then
    return null;
  end;
  if d < date '1900-01-01' then return null; end if;
  return d;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dob date := public.dob_from_metadata(new.raw_user_meta_data);
begin
  insert into public.profiles (id, email, name, date_of_birth)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'name', split_part(coalesce(new.email, 'user'), '@', 1)),
    case when dob <= current_date then dob end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
