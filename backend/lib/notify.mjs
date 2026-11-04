import { getSettings } from './clients.mjs'
import { serviceDb } from './db.mjs'

// =============================================================================
// Credit / plan notifications (Admin spec §5.9). One function sends a message to
// a B2B company or a B2C user on any mix of channels and records every send in
// public.notifications:
//   email  → Resend (RESEND_API_KEY + NOTIFY_FROM_EMAIL); without them the row is
//            written with status 'skipped' so the dashboard still sees the attempt
//   tablet → shown as a banner on all of the company's iPads (/api/b2b/session)
//   in_app → read by the B2C app from notifications (RLS: own rows)
// The same template is never sent to the same recipient twice within the
// cooldown window (default 24 h), automatic or manual.
// =============================================================================

const B2C_UPGRADE_URL = process.env.B2C_UPGRADE_URL || ''
const B2B_UPGRADE_URL = process.env.B2B_UPGRADE_URL || ''

const TEMPLATES = {
  low_credits: {
    b2b_store: (r) => ({
      subject: `${r.name}: ${r.creditsLeft} Atelier credits left`,
      body: `${r.pctLeft}% of your plan credits are left (${r.creditsLeft}). Upgrade or top up your plan so your iPads keep working.`,
    }),
    b2c_user: (r) => ({
      subject: `You have ${r.creditsLeft} try-on${r.creditsLeft === 1 ? '' : 's'} left`,
      body: `Hi ${r.name}, you have ${r.creditsLeft} try-on${r.creditsLeft === 1 ? '' : 's'} left. See the Premium plans to keep trying things on.`,
    }),
  },
  out_of_credits: {
    b2b_store: (r) => ({
      subject: `${r.name}: Atelier credits used up`,
      body: 'Your company has used all its credits, so new try-ons are paused on every iPad. Upgrade or top up your plan to continue.',
    }),
    b2c_user: (r) => ({
      subject: 'You are out of try-ons',
      body: `Hi ${r.name}, you've used all your try-ons. Pick a Premium plan to keep going.`,
    }),
  },
  plan_ending: {
    b2b_store: (r) => ({
      subject: `${r.name}: your Atelier plan renews on ${r.renewalDate}`,
      body: `Your plan renews on ${r.renewalDate}. Renew on time so your iPads keep working.`,
    }),
    b2c_user: (r) => ({
      subject: 'Your Atelier plan is ending soon',
      body: `Hi ${r.name}, your plan ends on ${r.renewalDate}.`,
    }),
  },
  upgrade_offer: {
    b2b_store: (r) => ({ subject: `An upgrade for ${r.name}`, body: 'Get more credits every month by moving to a bigger plan.' }),
    b2c_user: (r) => ({ subject: 'Try on more with Premium', body: `Hi ${r.name}, Premium gives you more try-ons every month.` }),
  },
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

async function sendEmail({ to, subject, body, linkUrl }) {
  const key = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_FROM_EMAIL
  if (!key || !from) return { status: 'skipped', error: 'email not configured (RESEND_API_KEY / NOTIFY_FROM_EMAIL)' }
  if (!to) return { status: 'skipped', error: 'recipient has no email address' }
  const html = `<p>${escapeHtml(body)}</p>${linkUrl ? `<p><a href="${escapeHtml(linkUrl)}">Upgrade your plan</a></p>` : ''}`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [to], subject, html,
        text: linkUrl ? `${body}\n\n${linkUrl}` : body,
        ...(process.env.NOTIFY_REPLY_TO ? { reply_to: process.env.NOTIFY_REPLY_TO } : {}),
      }),
    })
    if (!res.ok) return { status: 'failed', error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` }
    return { status: 'sent', error: null }
  } catch (err) {
    return { status: 'failed', error: err?.message ?? String(err) }
  }
}

/** Recipient details: name, email and the numbers the templates use. */
async function loadRecipient(db, recipientType, recipientId) {
  if (recipientType === 'b2b_store') {
    // Billing mails go to the company manager, else the store's own login email.
    const { data: c } = await db.from('b2b_stores')
      .select('store_id, store_name, store_email, credits_balance, renewal_at, b2b_plans(credits_included), b2b_companies(company_name, brand_name, manager_email)')
      .eq('store_id', recipientId).maybeSingle()
    if (!c) return null
    const included = c.b2b_plans?.credits_included ?? 0
    const company = c.b2b_companies
    return {
      name: company ? `${company.brand_name || company.company_name} · ${c.store_name}` : c.store_name,
      email: company?.manager_email || c.store_email,
      creditsLeft: c.credits_balance,
      pctLeft: included > 0 ? Math.round((c.credits_balance / included) * 100) : 0,
      renewalDate: c.renewal_at ? new Date(c.renewal_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
    }
  }
  const [{ data: p }, { data: m }] = await Promise.all([
    db.from('profiles').select('*').eq('id', recipientId).maybeSingle(),
    db.from('memberships').select('credits_balance').eq('user_id', recipientId).maybeSingle(),
  ])
  if (!p) return null
  // Profile → Notification settings (b2c-app.sql). Older rows default to on.
  const firstName = p.name && !p.name.includes('@') ? p.name.split(' ')[0] : 'there'
  return {
    name: firstName, email: p.email, creditsLeft: m?.credits_balance ?? 0, pctLeft: 0, renewalDate: '',
    emailOptOut: p.notify_email === false,
  }
}

/** True when this template already went to this recipient inside the cooldown. */
async function recentlySent(db, recipientType, recipientId, template, hours) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
  const { data } = await db.from('notifications').select('id')
    .eq('recipient_type', recipientType).eq('recipient_id', recipientId).eq('template', template)
    .in('status', ['sent', 'skipped']).gte('sent_at', since).limit(1)
  return (data ?? []).length > 0
}

/**
 * Send one notification.
 * @param {object} o
 * @param {'b2b_store'|'b2c_user'} o.recipientType
 * @param {string} o.recipientId       client id or auth user id
 * @param {string[]} [o.channels]      default: b2b → email + tablet, b2c → email + in_app
 * @param {'low_credits'|'out_of_credits'|'plan_ending'|'upgrade_offer'|'custom'} o.template
 * @param {'auto'|'manual'} [o.trigger]
 * @param {string} [o.subject]         override the template text (manual sends can edit it)
 * @param {string} [o.body]
 * @param {string} [o.sentBy]          admin auth user id for manual sends
 * @param {boolean} [o.force]          ignore the cooldown (never used by the daily job)
 * @returns {Promise<{ sent: boolean, reason?: string, results?: object[] }>}
 */
export async function sendNotification({
  recipientType, recipientId, channels, template, trigger = 'auto', subject, body, sentBy = null, force = false,
}) {
  const db = serviceDb()
  if (!db) return { sent: false, reason: 'supabase_not_configured' }
  if (!['b2b_store', 'b2c_user'].includes(recipientType)) return { sent: false, reason: 'bad_recipient_type' }
  if (!TEMPLATES[template] && template !== 'custom') return { sent: false, reason: 'bad_template' }

  const settings = await getSettings()
  const cooldown = Number(settings.notify_cooldown_hours) || 24
  if (!force && await recentlySent(db, recipientType, recipientId, template, cooldown)) {
    return { sent: false, reason: 'cooldown' }
  }
  const r = await loadRecipient(db, recipientType, recipientId)
  if (!r) return { sent: false, reason: 'unknown_recipient' }

  const text = template === 'custom' ? { subject: subject || '', body: body || '' } : TEMPLATES[template][recipientType](r)
  const finalSubject = subject || text.subject
  const finalBody = body || text.body
  const linkUrl = recipientType === 'b2b_store' ? B2B_UPGRADE_URL : B2C_UPGRADE_URL
  const list = channels?.length ? channels : recipientType === 'b2b_store' ? ['email', 'tablet'] : ['email', 'in_app']

  const results = []
  for (const channel of list) {
    if (!['email', 'tablet', 'in_app'].includes(channel)) continue
    if (channel === 'tablet' && recipientType !== 'b2b_store') continue
    if (channel === 'in_app' && recipientType !== 'b2c_user') continue
    const outcome = channel === 'email'
      ? (r.emailOptOut && trigger === 'auto'
        ? { status: 'skipped', error: 'user turned off email notifications' }
        : await sendEmail({ to: r.email, subject: finalSubject, body: finalBody, linkUrl }))
      : { status: 'sent', error: null } // tablet / in-app: the row itself is the message
    const { error } = await db.from('notifications').insert({
      recipient_type: recipientType, recipient_id: recipientId, channel, template, trigger,
      subject: finalSubject, body: finalBody, link_url: linkUrl || null,
      status: outcome.status, error: outcome.error, sent_by: sentBy,
    })
    if (error) console.warn('[Atelier] notification insert failed:', error.message)
    results.push({ channel, status: outcome.status, error: outcome.error })
  }
  return { sent: results.some((x) => x.status === 'sent'), results }
}
