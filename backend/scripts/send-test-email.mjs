// Send one test email with the current settings and say which sender delivered it.
//   npm run email:test -w backend -- you@example.com
// Uses backend/.env (or the Droplet's env file when run there with --env-file).
import { sendEmail, emailProviders } from '../lib/email.mjs'

const to = process.argv[2]
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error('Usage: npm run email:test -w backend -- you@example.com')
  process.exit(2)
}
const providers = emailProviders()
console.log(`Senders set up, in order: ${providers.join(' → ') || 'none'}`)
const r = await sendEmail({
  to,
  subject: 'Atelier test email',
  code: '123456',
  body: 'This is a test of Atelier’s email setup. The code above is only an example.\n\nIf you can read this, email works.',
  link: process.env.APP_PUBLIC_URL ? { url: process.env.APP_PUBLIC_URL, label: 'Open Atelier' } : null,
})
console.log(r.status === 'sent' ? `Sent to ${to} by ${r.provider}.` : `Not sent (${r.status}): ${r.error}`)
process.exit(r.status === 'sent' ? 0 : 1)
