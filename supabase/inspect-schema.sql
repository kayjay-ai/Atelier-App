-- Read-only: describes the public schema (tables, columns, keys, RLS, policies,
-- functions, triggers, storage buckets) as ONE JSON value. Run it in the
-- Supabase SQL editor, then copy the single result cell.
select jsonb_pretty(jsonb_build_object(
  'tables', (
    select jsonb_object_agg(c.relname, jsonb_build_object(
      'rls', c.relrowsecurity,
      'rows_estimate', c.reltuples::bigint,
      'columns', (
        select jsonb_agg(jsonb_build_object(
          'name', a.attname,
          'type', format_type(a.atttypid, a.atttypmod),
          'not_null', a.attnotnull,
          'default', pg_get_expr(d.adbin, d.adrelid)
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ),
      'constraints', (
        select jsonb_agg(pg_get_constraintdef(k.oid))
        from pg_constraint k where k.conrelid = c.oid
      ),
      'policies', (
        select jsonb_agg(jsonb_build_object(
          'name', p.policyname, 'cmd', p.cmd, 'roles', p.roles,
          'using', p.qual, 'check', p.with_check))
        from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
      ),
      'triggers', (
        select jsonb_agg(t.tgname || ' → ' || t.tgfoid::regproc::text)
        from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
      )
    ))
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'p')
  ),
  'functions', (
    select jsonb_agg(p.proname || '(' || pg_get_function_arguments(p.oid) || ') → '
                     || pg_get_function_result(p.oid)
                     || case when p.prosecdef then ' [security definer]' else '' end)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ),
  'auth_triggers', (
    select jsonb_agg(t.tgname || ' → ' || t.tgfoid::regproc::text)
    from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
  ),
  'buckets', (select jsonb_agg(jsonb_build_object('id', id, 'public', public)) from storage.buckets)
)) as schema;
