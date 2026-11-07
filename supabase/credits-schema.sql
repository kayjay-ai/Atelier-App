-- Company + user credit pools for iframe partners (run after schema.sql)
--
-- user_credit_limit: max credits per user per company across all time (-1 = unlimited)
-- credit_balance: remaining company pool (decremented on each AI action)

create table if not exists public.companies (
  id text primary key,
  name text not null,
  credit_balance integer not null check (credit_balance >= 0),
  credit_pool integer not null,
  user_credit_limit integer not null default -1,
  allowed_origins text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references public.companies (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  guest_id text,
  referrer_origin text not null,
  action text not null,
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now(),
  constraint credit_ledger_actor check (user_id is not null or guest_id is not null)
);

create index if not exists credit_ledger_company_user_idx
  on public.credit_ledger (company_id, user_id, created_at desc);

create index if not exists credit_ledger_company_guest_idx
  on public.credit_ledger (company_id, guest_id, created_at desc);

alter table public.companies enable row level security;
alter table public.credit_ledger enable row level security;

-- Partners read own company row (by id claim — admin uses service role)
create policy "Public read active companies"
  on public.companies for select
  using (active = true);

-- Users see their own ledger entries
create policy "Users read own credit ledger"
  on public.credit_ledger for select
  using (auth.uid() = user_id);

-- Seed VERVE demo tenant (100 credits, 10 per user; set user_credit_limit = -1 for unlimited)
insert into public.companies (id, name, credit_balance, credit_pool, user_credit_limit, allowed_origins)
values (
  'verve',
  'VERVE',
  100,
  100,
  -1,
  array['http://localhost:5199', 'http://127.0.0.1:5199']
)
on conflict (id) do update set
  name = excluded.name,
  allowed_origins = excluded.allowed_origins,
  updated_at = now();

-- Optional: per-user cap of 10 for VERVE
-- update public.companies set user_credit_limit = 10 where id = 'verve';
