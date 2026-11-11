// =============================================================================
// Transactional email through Resend (RESEND_API_KEY + NOTIFY_FROM_EMAIL).
// Without them nothing is sent and the result says 'skipped'. Outside
// production (NODE_ENV !== 'production') a skipped email is printed to the
// server log, so codes and invite links can be tested locally.
// =============================================================================

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function emailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_EMAIL)
}

/**
 * TEMPORARY test mode for the owner portal while email isn't set up: sign-in
 * codes and invite links that would have been emailed are returned to the app
 * and shown on screen instead, so the whole flow can be tried on the live site.
 * Switches itself off once RESEND_API_KEY + NOTIFY_FROM_EMAIL are set, or at
 * once with OWNER_EMAIL_BYPASS=false. Anyone who knows an organization's store
 * code and owner email can activate it while this is on — set up email before
 * real owners are onboarded.
 */
export function emailBypass() {
  return !emailConfigured() && process.env.OWNER_EMAIL_BYPASS !== 'false'
}

/**
 * Send one email. `body` is plain text (paragraphs separated by blank lines);
 * `link` adds a button-style link under it.
 * @returns {Promise<{ status: 'sent'|'failed'|'skipped', error: string|null }>}
 */
export async function sendEmail({ to, subject, body, link }) {
  const key = process.env.RESEND_API_KEY
  const from = process.env.NOTIFY_FROM_EMAIL
  if (!to) return { status: 'skipped', error: 'recipient has no email address' }
  const text = link?.url ? `${body}\n\n${link.label}: ${link.url}` : body
  if (!key || !from) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Atelier] (email not configured — not sent) to=${to} subject="${subject}"\n${text}`)
    }
    return { status: 'skipped', error: 'email not configured (RESEND_API_KEY / NOTIFY_FROM_EMAIL)' }
  }
  const paragraphs = String(body).split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
  const html = paragraphs + (link?.url ? `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>` : '')
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from, to: [to], subject, html, text,
        ...(process.env.NOTIFY_REPLY_TO ? { reply_to: process.env.NOTIFY_REPLY_TO } : {}),
      }),
    })
    if (!res.ok) return { status: 'failed', error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` }
    return { status: 'sent', error: null }
  } catch (err) {
    return { status: 'failed', error: err?.message ?? String(err) }
  }
}
