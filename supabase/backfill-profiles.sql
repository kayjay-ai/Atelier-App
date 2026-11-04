-- Run AFTER supabase/schema.sql if you already had auth users before the schema existed.
-- Creates a profiles row for every auth.users entry that is missing one.

insert into public.profiles (id, email, name)
select
  u.id,
  coalesce(u.email, ''),
  coalesce(
    u.raw_user_meta_data->>'name',
    split_part(coalesce(u.email, 'user'), '@', 1)
  )
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict (id) do nothing;
