import express from 'express'
import crypto from 'crypto'
import { sendNotification } from '../lib/notify.mjs'
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
// expiry, credit notifications). For an external scheduler; Render's cron job
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
