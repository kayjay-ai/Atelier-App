-- =============================================================================
-- Partner client registry in Supabase (so the admin portal can register/edit
-- clients) + per-client AI feature toggles. Idempotent; run once.
--
-- enabled_features: which AI features are ON for this client. Each defaults to
-- TRUE, so existing/new clients behave exactly as today unless a feature is
-- turned off. The client's embedded Atelier reads this and the server enforces it.
--
-- RLS: service-role only (admin server + Atelier server). No anon/authenticated
-- policies → secrets and toggles are never exposed to or set by the browser.
-- =============================================================================

create table if not exists public.embed_clients (
  client_id        text primary key,
  name             text not null,
  secret           text not null,                  -- shared HMAC secret (verifies the client's SSO tokens)
  api_key          text,                            -- server-to-server partner API key
  allowed_origins  text[] not null default '{}',    -- origins allowed to frame Atelier
  active           boolean not null default true,
  enabled_features jsonb not null default
    '{"virtual_tryon": true, "size_assist": true, "style_color_assist": true}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.embed_clients enable row level security;  -- service-role only (no policies)

-- Backfill the built-in demo client so it's editable in the admin portal too.
-- (The Atelier server also has a config fallback for it; the DB row wins.)
insert into public.embed_clients (client_id, name, secret, api_key, allowed_origins, active, enabled_features)
values (
  'demo', 'Demo Retailer',
  'dev-embed-shared-secret-change-me', 'demo-partner-api-key-change-me',
  array['http://localhost:5199','http://localhost:5173','http://localhost:8081'],
  true,
  '{"virtual_tryon": true, "size_assist": true, "style_color_assist": true}'::jsonb
)
on conflict (client_id) do nothing;
