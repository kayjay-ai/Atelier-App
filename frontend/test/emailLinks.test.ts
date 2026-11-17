import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gmailComposeUrl, mailtoUrl } from '../lib/emailLinks.ts'

test('mailtoUrl: address, then subject and body when given', () => {
  assert.equal(mailtoUrl({ to: 'a@b.in' }), 'mailto:a@b.in')
  assert.equal(mailtoUrl({ to: 'a@b.in', subject: 'Atelier — Test Store', body: 'Hi\n' }),
    'mailto:a@b.in?subject=Atelier%20%E2%80%94%20Test%20Store&body=Hi%0A')
})

test('gmailComposeUrl: a filled-in Gmail draft', () => {
  const u = new URL(gmailComposeUrl({ to: 'a@b.in', subject: 'Atelier — Test Store', body: 'Company: X\n\n' }))
  assert.equal(u.origin + u.pathname, 'https://mail.google.com/mail/')
  assert.equal(u.searchParams.get('view'), 'cm')
  assert.equal(u.searchParams.get('to'), 'a@b.in')
  assert.equal(u.searchParams.get('su'), 'Atelier — Test Store')
  assert.equal(u.searchParams.get('body'), 'Company: X\n\n')
  assert.equal(new URL(gmailComposeUrl({ to: 'a@b.in' })).searchParams.has('su'), false)
})
