-- =============================================================================
-- Customer folders: the phone number is OPTIONAL.
-- Idempotent; run in the Supabase SQL editor.
--
-- The live database (changed outside this repo, recorded here 2026-11-07) has
-- customer_folders.phone_key / name_key (both NOT NULL), filled by the trigger
-- customer_folders_keys → customer_folders_set_keys(). get_or_create_customer_folder()
-- and b2b_get_or_create_customer_folder() find a returning customer by
-- (store_id, phone_key, name_key). The old trigger rejected every folder without
-- a 10-digit phone, so the store app could not save a customer with no phone.
--
-- Now:
--   • no phone at all        → allowed; phone stored as NULL and phone_key set to
--                              'nophone:<folder id>', unique per folder, so the
--                              phone+name lookup never matches it
--   • 1–9 digits             → still rejected with 'invalid_phone'
--   • 10+ digits             → unchanged: phone_key = last 10 digits
--   • empty name             → still rejected with 'invalid_name'
-- The get_or_create functions above still require a phone; they are unchanged.
-- =============================================================================

create or replace function public.customer_folders_set_keys()
returns trigger
language plpgsql
as $function$
declare
  v_digits text;
begin
  v_digits := regexp_replace(coalesce(new.phone, ''), '\D', '', 'g');
  if v_digits = '' then
    new.phone := null;
    -- Keep an existing no-phone key on update; a new folder gets its own.
    if tg_op = 'UPDATE' and old.phone_key like 'nophone:%' then
      new.phone_key := old.phone_key;
    else
      new.phone_key := 'nophone:' || new.id::text;
    end if;
  elsif length(v_digits) < 10 then
    raise exception 'invalid_phone' using errcode = '22023';
  else
    new.phone_key := right(v_digits, 10);
  end if;
  new.name_key := lower(regexp_replace(btrim(coalesce(new.customer_name, '')), '\s+', ' ', 'g'));
  if new.name_key = '' then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  return new;
end;
$function$;

-- The trigger itself is unchanged; (re)create it so this file also works on a
-- database where it is missing.
drop trigger if exists customer_folders_keys on public.customer_folders;
create trigger customer_folders_keys
  before insert or update of customer_name, phone on public.customer_folders
  for each row execute function public.customer_folders_set_keys();
