import express from 'express'
import crypto from 'crypto'
import { sendNotification } from '../lib/notify.mjs'
import { CATEGORIES, notifyOwner } from '../lib/ownerNotify.mjs'
import { serviceDb } from '../lib/db.mjs'
import { runDailyJob } from '../jobs/daily.mjs'

const router = express.Router()
export default router

// ---------------------------------------------------------------------------
// Server-to-server endpoints (never called by the apps). Each needs its own
// shared secret in a header; unset secret → the endpoint is off.
// ---------------------------------------------------------------------------
function secretOk(req, header, envName) {
  const expected = process.env[envName]
  const given = req.headers[header]
  if (!expected || typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// POST /api/jobs/daily — run the daily maintenance job (folder expiry, plan
// expiry, credit notifications). For an external scheduler; the Droplet's cron
// runs `npm run job:daily` directly instead.
router.post('/api/jobs/daily', async (req, res) => {
  if (!secretOk(req, 'x-job-secret', 'JOBS_SECRET')) return res.status(401).json({ error: 'unauthorized' })
  try {
    return res.json(await runDailyJob())
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// POST /api/admin/notify — the admin dashboard's "Notify" / "Notify all"
// (spec §5.9). Body: { recipients: [{ type: 'b2b_store'|'b2c_user', id }],
// template, channels?, subject?, body?, sentBy? }. Respects the 24 h cooldown.
router.post('/api/admin/notify', async (req, res) => {
  if (!secretOk(req, 'x-admin-secret', 'ADMIN_API_SECRET')) return res.status(401).json({ error: 'unauthorized' })
  const { recipients, template, channels, subject, body, sentBy } = req.body || {}
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > 500) {
    return res.status(400).json({ error: 'recipients must be a list of 1–500 { type, id }' })
  }
  const results = []
  for (const r of recipients) {
    results.push({
      ...r,
      ...(await sendNotification({
        recipientType: r?.type, recipientId: r?.id, template, channels, subject, body,
        trigger: 'manual', sentBy: sentBy ?? null,
      })),
    })
  }
  return res.json({ sent: results.filter((r) => r.sent).length, results })
})

// POST /api/admin/owner-notify — Atelier posts to owners' Notifications feed:
// deals & offers and gift cards (or any category). Body: { companyIds?: uuid[]
// | all: true, category, title, body, expiresAt?, cta?, code?, amountInr? }.
router.post('/api/admin/owner-notify', async (req, res) => {
  if (!secretOk(req, 'x-admin-secret', 'ADMIN_API_SECRET')) return res.status(401).json({ error: 'unauthorized' })
  const b = req.body || {}
  if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: `category must be one of ${CATEGORIES.join(', ')}` })
  if (typeof b.title !== 'string' || !b.title.trim() || typeof b.body !== 'string' || !b.body.trim()) {
    return res.status(400).json({ error: 'title and body are required' })
  }
  const db = serviceDb()
  if (!db) return res.status(503).json({ error: 'no database' })
  let companyIds = Array.isArray(b.companyIds) ? b.companyIds.filter((id) => typeof id === 'string') : []
  if (b.all === true) {
    const { data, error } = await db.from('b2b_owners').select('company_id').not('activated_at', 'is', null)
    if (error) return res.status(500).json({ error: error.message })
    companyIds = (data ?? []).map((o) => o.company_id)
  }
  if (!companyIds.length || companyIds.length > 2000) return res.status(400).json({ error: 'give companyIds (1–2000) or all: true' })
  const kind = b.category === 'gift_cards' ? 'gift_card' : 'offer'
  const data = {
    expiresAt: typeof b.expiresAt === 'string' ? b.expiresAt : null,
    cta: typeof b.cta === 'string' ? b.cta.slice(0, 40) : null,
    code: typeof b.code === 'string' ? b.code.slice(0, 60) : null,
    amountInr: Number.isFinite(Number(b.amountInr)) ? Number(b.amountInr) : null,
  }
  const results = []
  for (const companyId of companyIds) {
    const r = await notifyOwner({
      companyId, category: b.category, title: b.title.trim(), body: b.body.trim(),
      data, link: ['deals', 'gift_cards'].includes(b.category) ? { screen: kind } : null,
    })
    results.push({ companyId, ...r })
  }
  return res.json({ posted: results.filter((r) => r.posted).length, results })
})
