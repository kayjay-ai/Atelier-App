import path from 'path'
import { fileURLToPath } from 'url'
import { getSettings, logAppEvent } from '../lib/clients.mjs'
import { sendNotification } from '../lib/notify.mjs'
import { serviceDb } from '../lib/db.mjs'

// =============================================================================
// Daily maintenance (Admin spec §5.7, §5.9, §8). Safe to run more often — every
// step is idempotent. Runs either as the Droplet's daily cron (`npm run job:daily`)
// or through POST /api/jobs/daily with the X-Job-Secret header.
//   1. Delete customer folders past expires_at: their photos/results in the
//      customer-photos bucket, then the row (results cascade). Logs
//      customer_folder_expired for the compliance log.
//   2. Auto-suspend stores whose trial ended or whose plan is past renewal +
//      grace days (expire_b2b_stores).
//   3. Automatic credit / plan-ending notifications for stores and B2C users.
// =============================================================================

const BUCKET = 'customer-photos'
const BATCH = 200

async function expireCustomerFolders(db) {
  let removed = 0
  for (;;) {
    const { data: folders, error } = await db.from('customer_folders')
      .select('id, store_id, device_id, created_at')
      .lt('expires_at', new Date().toISOString())
      .limit(BATCH)
    if (error) throw error
    if (!folders?.length) break
    for (const f of folders) {
      const prefix = `${f.store_id}/${f.id}`
      const { data: files, error: listErr } = await db.storage.from(BUCKET).list(prefix, { limit: 1000 })
      if (listErr) throw listErr
      if (files?.length) {
        const { error: rmErr } = await db.storage.from(BUCKET).remove(files.map((x) => `${prefix}/${x.name}`))
        if (rmErr) throw rmErr
      }
      const { error: delErr } = await db.from('customer_folders').delete().eq('id', f.id)
      if (delErr) throw delErr
      await logAppEvent({
        event: 'customer_folder_expired', channel: 'b2b', clientId: f.store_id,
        deviceId: f.device_id, folderId: f.id, metadata: { created_at: f.created_at, files: files?.length ?? 0 },
      })
      removed++
    }
    if (folders.length < BATCH) break
  }
  return removed
}

async function notifyCompanies(db, settings) {
  const auto = settings.notify_auto || {}
  const lowPct = Number(settings.b2b_low_credit_pct) || 20
  const endingDays = Number(settings.plan_ending_days) || 7
  const { data: stores, error } = await db.from('b2b_stores')
    .select('store_id, credits_balance, renewal_at, b2b_plans(credits_included), b2b_companies(status)')
    .eq('status', 'active')
  if (error) throw error
  let sent = 0
  for (const s of stores ?? []) {
    if (s.b2b_companies?.status === 'inactive') continue
    const c = { id: s.store_id, credits_balance: s.credits_balance, renewal_at: s.renewal_at }
    const included = s.b2b_plans?.credits_included ?? 0
    let template = null
    if (c.credits_balance <= 0 && auto.out_of_credits !== false) template = 'out_of_credits'
    else if (included > 0 && (c.credits_balance / included) * 100 <= lowPct && auto.low_credits !== false) template = 'low_credits'
    if (template) {
      const r = await sendNotification({ recipientType: 'b2b_store', recipientId: c.id, template })
      if (r.sent) sent++
    }
    if (c.renewal_at && auto.plan_ending !== false) {
      const days = (Date.parse(c.renewal_at) - Date.now()) / 86_400_000
      if (days > 0 && days <= endingDays) {
        const r = await sendNotification({ recipientType: 'b2b_store', recipientId: c.id, template: 'plan_ending' })
        if (r.sent) sent++
      }
    }
  }
  return sent
}

async function notifyConsumers(db, settings) {
  const auto = settings.notify_auto || {}
  const lowLeft = Number(settings.b2c_low_credit_left ?? 1)
  // Store logins also get a memberships row (signup trigger) — skip them.
  const { data: storeRows } = await db.from('b2b_stores').select('store_email')
  const storeEmails = new Set((storeRows ?? []).map((r) => (r.store_email ?? '').toLowerCase()).filter(Boolean))
  const { data: rows, error } = await db.from('memberships')
    .select('user_id, credits_balance, plan')
    .lte('credits_balance', lowLeft)
    .or('plan.is.null,plan.neq.premium') // premium = unlimited; a plain neq would drop null plans
    .limit(1000)
  if (error) throw error
  const ids = (rows ?? []).map((m) => m.user_id)
  const { data: emails } = ids.length ? await db.from('profiles').select('id, email').in('id', ids) : { data: [] }
  const skip = new Set((emails ?? []).filter((p) => storeEmails.has((p.email ?? '').toLowerCase())).map((p) => p.id))
  let sent = 0
  for (const m of rows ?? []) {
    if (skip.has(m.user_id)) continue
    const template = m.credits_balance <= 0 ? 'out_of_credits' : 'low_credits'
    if (template === 'out_of_credits' && auto.out_of_credits === false) continue
    if (template === 'low_credits' && auto.low_credits === false) continue
    const r = await sendNotification({ recipientType: 'b2c_user', recipientId: m.user_id, template })
    if (r.sent) sent++
  }
  return sent
}

/** Run every step; one failing step doesn't stop the others. */
export async function runDailyJob() {
  const db = serviceDb()
  if (!db) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set')
  const settings = await getSettings()
  const report = {}
  const step = async (name, fn) => {
    try {
      report[name] = await fn()
    } catch (err) {
      report[name] = { error: err?.message ?? String(err) }
      console.error(`[Atelier] daily job: ${name} failed:`, err?.message)
    }
  }
  await step('foldersExpired', () => expireCustomerFolders(db))
  await step('storesSuspended', async () => {
    const { data, error } = await db.rpc('expire_b2b_stores')
    if (error) throw error
    return data
  })
  await step('storeNotifications', () => notifyCompanies(db, settings))
  await step('consumerNotifications', () => notifyConsumers(db, settings))
  console.log('[Atelier] daily job finished:', JSON.stringify(report))
  return report
}

// `npm run job:daily` (from the repo root)
// Loads .env only when run as a script: importing this module (routes/admin.mjs)
// must not change the environment.
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  import('dotenv/config')
    .then(() => runDailyJob())
    .then((r) => process.exit(Object.values(r).some((v) => v && typeof v === 'object' && v.error) ? 1 : 0))
    .catch((err) => { console.error(err); process.exit(1) })
}
