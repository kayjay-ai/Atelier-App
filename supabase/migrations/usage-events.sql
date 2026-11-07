-- =============================================================================
-- Atelier — unified feature usage log
-- Run AFTER schema.sql and membership.sql (safe to re-run).
--
-- Records EVERY AI feature call (style, size, color, verdict, try-on, URL parse)
-- so the admin portal can show a complete activity feed — not just try-ons.
--
-- Security model: the backend (service role) is the sole writer. Users may READ
-- their own rows, so a future "your history" view can reuse this table. There is
-- no INSERT/UPDATE/DELETE policy, so the anon key can never forge usage rows.
-- =============================================================================

create table if not exists public.usage_events (
  id           uuid primary key default gen_random_uuid(),
  -- Nullable so anonymous / web-demo usage (no signed-in user) is still recorded.
  user_id      uuid references public.profiles (id) on delete cascade,
  feature      text not null check (feature in (
                 'style', 'size', 'color', 'verdict', 'tryon', 'garment_from_url'
               )),
  status       text not null default 'success' check (status in (
                 'success', 'fallback', 'error', 'blocked', 'paywall', 'denied'
               )),
  product_name text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists usage_events_created_idx
  on public.usage_events (created_at desc);

create index if not exists usage_events_user_created_idx
  on public.usage_events (user_id, created_at desc);

create index if not exists usage_events_feature_idx
  on public.usage_events (feature, created_at desc);

alter table public.usage_events enable row level security;

-- Users can read their own usage (no write policies → service role only).
drop policy if exists "Users read own usage" on public.usage_events;
create policy "Users read own usage"
  on public.usage_events for select
  using (auth.uid() = user_id);
