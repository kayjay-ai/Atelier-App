export interface EmailDraft { to: string; subject?: string; body?: string }

/** The link the device's email app opens, with the address, subject and body filled in. */
export function mailtoUrl({ to, subject, body }: EmailDraft): string {
  const q = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean)
  return `mailto:${to}${q.length ? `?${q.join('&')}` : ''}`
}

/** A new Gmail draft (in the browser) with the address, subject and body filled in. */
export function gmailComposeUrl({ to, subject, body }: EmailDraft): string {
  const q = new URLSearchParams({ view: 'cm', fs: '1', to })
  if (subject) q.set('su', subject)
  if (body) q.set('body', body)
  return `https://mail.google.com/mail/?${q.toString()}`
}
