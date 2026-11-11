import {
  changeStoreInviteEmail, deactivateOwnerStore, deleteInvitedStore, fetchStoreInviteLink,
  resendStoreInvite, revokeStoreInvite, type OwnerStoreRow,
} from '../../lib/api'
import { copyText, num, ownerErrorText } from '../../lib/owner'
import { confirmDialog, promptDialog, toast, type MenuItem } from './kit'

// What the owner can do to a store, by status (flow doc, "Row menu by status"):
//   Invited         Resend invite · Copy invite link · Edit manager email · Revoke invite
//   Invite expired  Resend invite · Delete
//   Active / Pending / Low credits / Expired   View details · Deactivate store
//   Deactivated     View details

const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

/**
 * TEMPORARY test mode (the API has no email yet): no invite email went out, so
 * hand the owner the link to pass on. Gone once the server's email is set up.
 */
export async function showTestInvite(url: string | undefined, email: string): Promise<boolean> {
  if (!url) return false
  const copy = await confirmDialog({
    title: 'Share this invite link',
    body: `Test mode — email isn’t set up yet, so nothing was emailed to ${email}. Send them this link (it works once, for 7 days):\n\n${url}`,
    confirmLabel: 'Copy link',
  })
  if (copy) {
    const r = await copyText(url)
    if (r === 'copied') toast('Invite link copied.')
  }
  return true
}

async function run(work: () => Promise<void>) {
  try {
    await work()
  } catch (e) {
    toast(ownerErrorText(e), { tone: 'error' })
  }
}

export const storeActions = {
  resend: (row: OwnerStoreRow, done: () => void) => run(async () => {
    const r = await resendStoreInvite(row.id)
    if (await showTestInvite(r.testInviteUrl, row.managerEmail)) { done(); return }
    if (r.emailStatus === 'failed') toast(`The invite email to ${row.managerEmail} wasn’t delivered. Try resending in a few minutes.`, { tone: 'error' })
    else toast(`Invite sent again to ${row.managerEmail}. The old link no longer works.`)
    done()
  }),

  copyLink: (row: OwnerStoreRow) => run(async () => {
    const { url } = await fetchStoreInviteLink(row.id)
    const r = await copyText(url)
    if (r === 'copied') toast('Invite link copied. It works once and expires 7 days after it was sent.')
    else if (r === 'failed') toast('Couldn’t copy the link — use Resend invite instead.', { tone: 'error' })
  }),

  editEmail: (row: OwnerStoreRow, done: () => void) => run(async () => {
    const email = await promptDialog({
      title: 'Edit manager email',
      body: `A fresh invite for ${row.name} goes to the new address, and the old link stops working.`,
      confirmLabel: 'Send new invite',
      input: {
        label: 'Manager email', initial: row.managerEmail, keyboardType: 'email-address',
        validate: (v) => (looksLikeEmail(v) ? null : 'Enter a valid email address.'),
      },
    })
    if (!email || email.toLowerCase() === row.managerEmail.toLowerCase()) return
    const r = await changeStoreInviteEmail(row.id, email)
    if (await showTestInvite(r.testInviteUrl, email)) { done(); return }
    toast(r.emailStatus === 'failed' ? `Email changed, but the invite to ${email} wasn’t delivered — resend it.` : `New invite sent to ${email}.`,
      { tone: r.emailStatus === 'failed' ? 'error' : 'success' })
    done()
  }),

  revoke: (row: OwnerStoreRow, done: () => void) => run(async () => {
    const ok = await confirmDialog({
      title: `Revoke the invite to ${row.managerEmail}?`,
      body: `The invite link stops working and ${row.name} is removed from your dashboard. You can add it again later.`,
      confirmLabel: 'Revoke invite', danger: true,
    })
    if (!ok) return
    await revokeStoreInvite(row.id)
    toast(`Invite revoked. ${row.name} was removed.`)
    done()
  }),

  remove: (row: OwnerStoreRow, done: () => void) => run(async () => {
    const ok = await confirmDialog({
      title: `Delete ${row.name}?`,
      body: 'Its invite expired unused. The store is removed from your dashboard; you can add it again later.',
      confirmLabel: 'Delete', danger: true,
    })
    if (!ok) return
    await deleteInvitedStore(row.id)
    toast(`${row.name} was deleted.`)
    done()
  }),

  deactivate: (row: OwnerStoreRow, done: () => void) => run(async () => {
    const devices = row.devices
    const ok = await confirmDialog({
      title: `Deactivate ${row.name}?`,
      body: (devices > 0
        ? `${devices} connected device${devices === 1 ? '' : 's'} will be signed out and disconnected. `
        : 'The store’s login will stop working. ') +
        `Its remaining ${num(row.usableCredits)} credit${row.usableCredits === 1 ? '' : 's'} will be frozen. ` +
        'To turn the store back on, contact Atelier support.',
      confirmLabel: 'Deactivate store', danger: true,
    })
    if (!ok) return
    await deactivateOwnerStore(row.id)
    toast(`${row.name} was deactivated.`)
    done()
  }),
}

/** The row menu for a store. */
export function storeMenu(row: OwnerStoreRow, { reload, open }: { reload: () => void; open: () => void }): MenuItem[] {
  switch (row.status) {
    case 'invited':
      return [
        { label: 'Resend invite', icon: 'mail', onPress: () => storeActions.resend(row, reload) },
        { label: 'Copy invite link', icon: 'copy', onPress: () => storeActions.copyLink(row) },
        { label: 'Edit manager email', icon: 'edit', onPress: () => storeActions.editEmail(row, reload) },
        { label: 'Revoke invite', icon: 'close', danger: true, onPress: () => storeActions.revoke(row, reload) },
      ]
    case 'invite_expired':
      return [
        { label: 'Resend invite', icon: 'mail', onPress: () => storeActions.resend(row, reload) },
        { label: 'Delete', icon: 'trash', danger: true, onPress: () => storeActions.remove(row, reload) },
      ]
    case 'deactivated':
      return [{ label: 'View details', icon: 'info', onPress: open }]
    default:
      return [
        { label: 'View details', icon: 'info', onPress: open },
        { label: 'Deactivate store', icon: 'close', danger: true, onPress: () => storeActions.deactivate(row, reload) },
      ]
  }
}
