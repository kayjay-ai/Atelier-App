-- =============================================================================
-- Owner portal fix (2026-11-11): the live database already had b2b_owners from
-- the admin panel, so owner-portal.sql's "create table if not exists" kept that
-- table and its columns. This adds the columns the owner portal needs. Only
-- adds; nothing the admin panel uses is changed. Idempotent — safe to re-run.
-- (owner-portal.sql now includes these lines too.)
-- =============================================================================

alter table public.b2b_owners add column if not exists user_id uuid unique references auth.users (id) on delete set null;
alter table public.b2b_owners add column if not exists phone text;
alter table public.b2b_owners add column if not exists activated_at timestamptz;
alter table public.b2b_owners add column if not exists failed_login_since timestamptz;
alter table public.b2b_owners add column if not exists notify_prefs jsonb not null default '{}'::jsonb;
create index if not exists b2b_owners_email_lower_idx on public.b2b_owners (lower(email));

-- Make the API see the new columns straight away.
notify pgrst, 'reload schema';
