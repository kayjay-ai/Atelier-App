-- Owner portal: "Remove store" for a deactivated store.
-- A store without payment records is deleted outright. Payments and Terms
-- acceptances are tax records (on delete restrict), so a store that has them is
-- listed here instead: the owner portal no longer shows it, and the records stay.
-- Idempotent: safe to run more than once.

create table if not exists public.b2b_owner_removed_stores (
  store_id    text primary key references public.b2b_stores (store_id) on delete cascade,
  company_id  uuid references public.b2b_companies (company_id) on delete cascade,
  removed_by  text,
  removed_at  timestamptz not null default now()
);
create index if not exists b2b_owner_removed_stores_company_idx on public.b2b_owner_removed_stores (company_id);

-- Written and read only by the API (service role).
alter table public.b2b_owner_removed_stores enable row level security;
revoke all on public.b2b_owner_removed_stores from anon, authenticated;
