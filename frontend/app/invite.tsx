import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError, acceptStoreInvite, fetchStoreInvite, type StoreInvite } from '../lib/api'
import { passwordOk, usePrefill } from '../lib/owner'
import { Colors, Typography, Space } from '../lib/theme'
import { Loading } from '../lib/ui'
import { AuthShell } from '../components/owner/AuthShell'
import { Banner, Btn, Field, PasswordChecklist, PasswordField } from '../components/owner/kit'

// ─── A store manager accepts an owner's invite (/invite?token=…) ──────────────
// Store and email come prefilled from the invite. Accepting sets up the store
// login (that email + a new password) and moves the store Invited → Pending;
// then the manager signs in under Company › Store staff and buys a package.

export default function AcceptInvite() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const [invite, setInvite] = useState<StoreInvite | null>(null)
  const [problem, setProblem] = useState<{ text: string; code: string | null } | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) { setProblem({ text: 'This invite is no longer valid. Ask the owner for a new one.', code: 'invalid_invite' }); return }
    fetchStoreInvite(String(token))
      .then(setInvite)
      .catch((e) => setProblem({ text: e?.message ?? 'Couldn’t open this invite.', code: e instanceof ApiError ? e.code : null }))
  }, [token])

  function toSignIn(email?: string, notice?: string) {
    usePrefill.getState().put({ storeEmail: email, notice })
    router.replace('/auth')
  }

  async function accept() {
    if (!invite || !token) return
    if (!invite.hasAccount && (!passwordOk(pw) || pw !== pw2)) return
    setBusy(true); setProblem(null)
    try {
      const r = await acceptStoreInvite(String(token), invite.hasAccount ? undefined : pw)
      toSignIn(r.email, r.hadAccount
        ? `You’re all set. Sign in with your existing Atelier password to open ${r.storeName}.`
        : `You’re all set. Sign in with your new password to open ${r.storeName}.`)
    } catch (e: any) {
      setProblem({ text: e?.message ?? 'Couldn’t accept the invite. Try again.', code: e instanceof ApiError ? e.code : null })
      setBusy(false)
    }
  }

  if (!invite && !problem) return <Loading label="Opening your invite…" />

  if (!invite) {
    return (
      <AuthShell title="Store invite" showSwitch={false}>
        <Banner tone="error" text={problem!.text} />
        {problem!.code === 'already_accepted' && <Btn label="Go to sign in" onPress={() => toSignIn()} style={{ marginTop: Space.lg }} />}
      </AuthShell>
    )
  }

  const match = pw2.length > 0 && pw === pw2
  const first = invite.managerName.split(' ')[0]
  return (
    <AuthShell
      title={`Welcome${first ? `, ${first}` : ''}`} showSwitch={false}
      subtitle={`${invite.organization || 'Your owner'} invited you to manage ${invite.storeName}${invite.city ? ` (${invite.city})` : ''} on Atelier.`}
    >
      <Field label="Store" value={invite.storeName} editable={false} />
      <Field label="Your email (the store’s login)" value={invite.managerEmail} editable={false} />

      {invite.hasAccount ? (
        <View style={{ marginTop: Space.md }}>
          <Banner tone="info" text="This email already has an Atelier account. After you accept, it signs in to the store app with your existing password." />
        </View>
      ) : (
        <>
          <PasswordField label="Create a password" value={pw} onChangeText={setPw} autoComplete="new-password" />
          <PasswordChecklist password={pw} />
          <PasswordField
            label="Confirm password" value={pw2} onChangeText={setPw2} autoComplete="new-password"
            error={pw2.length > 0 && !match ? 'The passwords don’t match.' : null} onSubmitEditing={accept}
          />
        </>
      )}

      {problem && <View style={{ marginTop: Space.md }}><Banner tone="error" text={problem.text} /></View>}
      <Btn
        label="Accept invite" onPress={accept} loading={busy} style={{ marginTop: Space.lg }}
        disabled={busy || (!invite.hasAccount && (!passwordOk(pw) || !match))}
      />
      <Text style={s.small}>Next, your store buys a credit package from Plan & Credits in the store app.</Text>
    </AuthShell>
  )
}

const s = StyleSheet.create({
  small: { ...Typography.caption, color: Colors.textMuted, textAlign: 'center', marginTop: Space.md },
})
