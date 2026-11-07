-- Atelier membership / free-tier try-on limit (run after schema.sql)
--
-- Free tier: 3 total virtual try-ons (tryon_limit). Premium: unlimited.
--
-- Security model: users may READ their own membership row, but only the
-- backend (service role) may WRITE it. The row therefore has a SELECT policy
-- but no INSERT/UPDATE/DELETE policies — this prevents a client from flipping
-- itself to premium or resetting its own counter with the anon key.

create table if not exists public.memberships (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'premium')),
  tryon_used integer not null default 0 check (tryon_used >= 0),
  tryon_limit integer not null default 3 check (tryon_limit >= 0),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.memberships enable row level security;

-- Users can read their own membership (no write policies → service role only).
drop policy if exists "Users read own membership" on public.memberships;
create policy "Users read own membership"
  on public.memberships for select
  using (auth.uid() = user_id);

-- Auto-create a membership row on signup.
create or replace function public.handle_new_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.memberships (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_membership on auth.users;
create trigger on_auth_user_created_membership
  after insert on auth.users
  for each row execute function public.handle_new_membership();

-- Backfill any existing users.
insert into public.memberships (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- Atomic "spend one try-on". Returns the resulting state + whether it was
-- allowed. Premium is never blocked and does not count against the limit.
-- ---------------------------------------------------------------------------
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

  if m.plan = 'premium' then
    update public.memberships
      set tryon_used = tryon_used + 1, updated_at = now()
      where user_id = p_user_id
      returning * into m;
    v_allowed := true;
  elsif m.tryon_used < m.tryon_limit then
    update public.memberships
      set tryon_used = tryon_used + 1, updated_at = now()
      where user_id = p_user_id
      returning * into m;
    v_allowed := true;
  else
    v_allowed := false;
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'plan', m.plan,
    'tryon_used', m.tryon_used,
    'tryon_limit', m.tryon_limit
  );
end;
$$;

-- Give a try-on back (e.g. when generation fails). Never goes below 0 and
-- never touches premium members (their counter is informational only).
create or replace function public.refund_tryon(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.memberships
    set tryon_used = greatest(0, tryon_used - 1), updated_at = now()
    where user_id = p_user_id and plan <> 'premium';
$$;
