-- Optional: run if try_ons already exists without retailer_product_url
alter table public.try_ons
  add column if not exists retailer_product_url text;
