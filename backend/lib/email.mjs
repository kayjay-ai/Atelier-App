import { lookup } from 'node:dns/promises'
import nodemailer from 'nodemailer'

// =============================================================================
// Transactional email. Two senders, tried in this order:
//   1. Resend (RESEND_API_KEY + NOTIFY_FROM_EMAIL): used once NOTIFY_FROM_EMAIL
//      is an address on a domain verified in Resend. Until then leave
//      NOTIFY_FROM_EMAIL blank: Resend only delivers to its own account owner.
//   2. SMTP (SMTP_USER + SMTP_PASS; Gmail by default): sends from SMTP_USER.
// When the first fails, the second is tried. With neither set nothing is sent
// and the result says 'skipped'; outside production (NODE_ENV !== 'production')
// a skipped email is printed to the server log for local testing.
// =============================================================================

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const fromName = () => (process.env.EMAIL_FROM_NAME || 'Atelier').replace(/["<>\r\n]/g, '').trim() || 'Atelier'
const resendReady = () => !!(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_EMAIL)
const smtpReady = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS)

/** True when at least one sender is set up. */
export function emailConfigured() {
  return resendReady() || smtpReady()
}

/** The senders that are set up, in the order they're tried. */
export function emailProviders() {
  return [resendReady() && 'resend', smtpReady() && 'smtp'].filter(Boolean)
}

/** "Atelier <a@b.com>", unless the setting already carries a name. */
function withName(address) {
  return /</.test(address) ? address : `${fromName()} <${address}>`
}

// ── Message ──────────────────────────────────────────────────────────────────

/**
 * The email in plain text and in a simple branded HTML layout (inline styles:
 * email clients ignore stylesheets).
 */
export function renderEmail({ subject, body, link, code }) {
  const paragraphs = String(body ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  const text = [
    ...(code ? [`Your code: ${code}`] : []),
    ...paragraphs,
    ...(link?.url ? [`${link.label}: ${link.url}`] : []),
    '— Atelier',
  ].join('\n\n')

  const p = (s) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#423D3A">${escapeHtml(s).replace(/\n/g, '<br>')}</p>`
  const codeBlock = code
    ? `<div style="margin:0 0 24px;padding:18px 0;background:#F2EFE8;border-radius:12px;text-align:center;font-size:32px;line-height:36px;letter-spacing:10px;font-weight:600;color:#2A2725;font-family:'Courier New',monospace">${escapeHtml(code)}</div>`
    : ''
  const button = link?.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:999px;background:#423D3A">` +
      `<a href="${escapeHtml(link.url)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:999px">${escapeHtml(link.label)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:#6F6865">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(link.url)}</span></p>`
    : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject ?? '')}</title></head>` +
    `<body style="margin:0;padding:0;background:#FAF8F5;font-family:Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F5"><tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">` +
    `<tr><td style="padding:0 4px 20px;font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:4px;color:#423D3A">ATELIER</td></tr>` +
    `<tr><td style="background:#FFFFFF;border:1px solid #E5E0D8;border-radius:16px;padding:32px 28px">` +
    codeBlock + paragraphs.map(p).join('') + button +
    `</td></tr>` +
    `<tr><td style="padding:20px 4px 0;font-size:12px;line-height:18px;color:#6F6865">This email was sent by Atelier, the virtual try-on app.</td></tr>` +
    `</table></td></tr></table></body></html>`
  return { text, html }
}

// ── Senders ──────────────────────────────────────────────────────────────────

async function viaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: withName(process.env.NOTIFY_FROM_EMAIL), to: [to], subject, html, text,
      ...(process.env.NOTIFY_REPLY_TO ? { reply_to: process.env.NOTIFY_REPLY_TO } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

let transport = null
let transportKey = ''
async function smtpTransport() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com'
  const port = Number(process.env.SMTP_PORT) || 465
  // Resolve the server with the system resolver (cached by the OS): nodemailer's
  // own DNS queries can take seconds on some networks. TLS still checks `host`.
  let address = host
  try {
    address = (await lookup(host, { family: 4 })).address
  } catch {}
  const config = {
    host: address, port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    tls: { servername: host },
    // Gmail shows app passwords in groups of four; the spaces aren't part of it.
    auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') },
    connectionTimeout: 15_000, dnsTimeout: 10_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  }
  const key = JSON.stringify(config)
  if (!transport || key !== transportKey) {
    transport?.close()
    transport = nodemailer.createTransport(config)
    transportKey = key
  }
  return transport
}

async function viaSmtp({ to, subject, text, html }) {
  // Gmail only sends as the signed-in account (or an alias set up in Gmail).
  const from = process.env.SMTP_FROM || process.env.SMTP_USER
  await (await smtpTransport()).sendMail({
    from: withName(from), to, subject, text, html,
    ...(process.env.NOTIFY_REPLY_TO ? { replyTo: process.env.NOTIFY_REPLY_TO } : {}),
  })
}

const SENDERS = { resend: viaResend, smtp: viaSmtp }

/**
 * Send one email. `body` is plain text (paragraphs separated by blank lines);
 * `link` adds a button under it; `code` shows a one-time code in large type.
 * @returns {Promise<{ status: 'sent'|'failed'|'skipped', error: string|null, provider?: string }>}
 */
export async function sendEmail({ to, subject, body, link, code }) {
  if (!to) return { status: 'skipped', error: 'recipient has no email address' }
  const { text, html } = renderEmail({ subject, body, link, code })
  const providers = emailProviders()
  if (!providers.length) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Atelier] (email not configured — not sent) to=${to} subject="${subject}"\n${text}`)
    }
    return { status: 'skipped', error: 'email not configured (SMTP_USER / SMTP_PASS, or RESEND_API_KEY / NOTIFY_FROM_EMAIL)' }
  }
  const errors = []
  for (const provider of providers) {
    try {
      await SENDERS[provider]({ to, subject, text, html })
      if (errors.length) console.warn(`[Atelier] email sent by ${provider} after: ${errors.join(' | ')}`)
      return { status: 'sent', error: null, provider }
    } catch (err) {
      errors.push(`${provider}: ${String(err?.message ?? err).slice(0, 300)}`)
    }
  }
  return { status: 'failed', error: errors.join(' | ') }
}
