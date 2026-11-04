/**
 * Creates user-photos and try-on-results buckets in Supabase Storage.
 *
 * Option A (recommended): paste supabase/storage-buckets.sql into Dashboard → SQL Editor → Run
 * Option B: add SUPABASE_SERVICE_ROLE_KEY to .env, then run: npm run setup:supabase
 */
import { serviceDb, supabaseUrl } from '../lib/db.mjs'

const url = supabaseUrl()
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url) {
  console.error('Missing SUPABASE_URL in .env')
  process.exit(1)
}

if (!serviceKey) {
  console.error(`
Missing SUPABASE_SERVICE_ROLE_KEY in .env.

Quick fix — run SQL instead:
  1. Open https://supabase.com/dashboard → your project → SQL Editor
  2. Paste the contents of supabase/storage-buckets.sql
  3. Click Run

Or add your service role key (Dashboard → Project Settings → API → service_role secret)
to .env as SUPABASE_SERVICE_ROLE_KEY=... and run this script again.
`)
  process.exit(1)
}

const supabase = serviceDb()

const buckets = [
  { id: 'user-photos', public: false },
  { id: 'try-on-results', public: false },
]

for (const bucket of buckets) {
  const { data, error: getError } = await supabase.storage.getBucket(bucket.id)
  if (data && !getError) {
    console.log(`✓ ${bucket.id} already exists`)
    continue
  }

  const { error } = await supabase.storage.createBucket(bucket.id, {
    public: bucket.public,
    fileSizeLimit: 10 * 1024 * 1024,
  })

  if (error) {
    console.error(`✗ Failed to create ${bucket.id}:`, error.message)
    process.exitCode = 1
    continue
  }

  console.log(`✓ Created ${bucket.id}`)
}

console.log(`
Buckets ready. Still run supabase/storage-buckets.sql in SQL Editor for storage RLS policies
(unless you already ran the full supabase/schema.sql).
`)
