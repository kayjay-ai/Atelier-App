-- =============================================================================
-- Embed SSO storage — Atelier users and generations scoped to a partner client's
-- own user, keyed by (client_id, external_user_id). Idempotent; run once.
--
-- The client REGISTRY (client_id, signing secret, allowed_origins, api_key) lives
-- server-side in config (backend/lib/embedClients.mjs) so secrets never touch the
-- browser. These tables only hold the scoped user mapping + generations.
--
-- RLS: writes/reads happen ONLY through the Atelier server (service role, which
-- bypasses RLS). No anon/authenticated policies are granted → the tables are
-- default-deny to clients, so scoping can never come from a client-supplied value.
-- =============================================================================

-- Maps a partner user (client_id, external_user_id) → a stable Atelier user id.
create table if not exists public.embed_users (
  atelier_user_id  uuid primary key,
  client_id        text not null,
  external_user_id text not null,
  name             text,
  email            text,
  created_at       timestamptz not null default now(),
  unique (client_id, external_user_id)
);

-- Every generation (try-on image, size, verdict) scoped to the partner user.
create table if not exists public.embed_generations (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null,
  external_user_id text not null,
  atelier_user_id  uuid not null,
  kind             text not null check (kind in ('tryon','size','verdict')),
  image_url        text,
  result           jsonb,
  product_name     text,
  created_at       timestamptz not null default now()
);
create index if not exists embed_generations_scope_idx
  on public.embed_generations (client_id, external_user_id, created_at desc);

-- Lock both tables down: enable RLS, grant NO policies. Only the service-role
-- server can touch them; the anon/authenticated keys cannot read or write.
alter table public.embed_users        enable row level security;
alter table public.embed_generations  enable row level security;

-- (Optional) if you later prefer a DB-backed client registry instead of config:
-- create table if not exists public.embed_clients (
--   client_id text primary key, secret text not null, api_key text,
--   allowed_origins text[] not null default '{}', name text, active boolean not null default true
-- );
-- alter table public.embed_clients enable row level security; -- service-role only
