import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError, acceptStoreInvite, fetchStoreInvite, type StoreInvite } from '../lib/api'
import { dropOwnerSession, passwordOk, usePrefill } from '../lib/owner'
import { supabase } from '../lib/supabaseClient'
import { useAccountStore } from '../lib/account'
import { Colors, Typography, Space, Weight } from '../lib/theme'
import { Loading } from '../lib/ui'
import { AuthShell } from '../components/owner/AuthShell'
import { Banner, Btn, Field, PasswordChecklist, PasswordField } from '../components/owner/kit'

// ─── A store manager accepts an owner's invite (/invite?token=…) ──────────────
// Store and email come prefilled from the invite. Accepting sets up the store
// login (that email + a new password) and moves the store Invited → Pending;
// the manager is then signed in to the store app on Plan & Credits to buy a
// package (an existing Atelier account signs in with its own password first).

export default function AcceptInvite() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const [invite, setInvite] = useState<StoreInvite | null>(null)
  const [problem, setProblem] = useState<{ text: string; code: string | null } | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  // An existing Atelier account sets a new password here unless the manager
  // says they know their current one (often they don't, e.g. a Google sign-up).
  const [keepCurrent, setKeepCurrent] = useState(false)
  const choosesPassword = !invite?.hasAccount || !keepCurrent

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
    if (choosesPassword && (!passwordOk(pw) || pw !== pw2)) return
    setBusy(true); setProblem(null)
    let r: Awaited<ReturnType<typeof acceptStoreInvite>>
    try {
      r = await acceptStoreInvite(String(token), choosesPassword ? pw : undefined)
    } catch (e: any) {
      setProblem({ text: e?.message ?? 'Couldn’t accept the invite. Try again.', code: e instanceof ApiError ? e.code : null })
      setBusy(false)
      return
    }
    // This browser now belongs to the store manager: forget any other login on
    // it (e.g. the owner who sent the invite, testing on the same computer),
    // or sign-in would open that account instead of the store app.
    await dropOwnerSession()
    if (!choosesPassword) {
      toSignIn(r.email, `You’re all set. Sign in with your current Atelier password to open ${r.storeName}.`)
      return
    }
    // A password was just set: sign straight in to the store app, on Plan &
    // Credits so the store can buy its first credits.
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: r.email, password: pw })
      if (error) throw error
      const account = await useAccountStore.getState().load()
      if (account?.type !== 'b2b_company') throw new Error('not a store login')
      router.replace('/store/plan')
    } catch {
      toSignIn(r.email, `You’re all set. Sign in with your new password to open ${r.storeName}.`)
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

      {invite.hasAccount && (
        <View style={{ marginTop: Space.md }}>
          <Banner tone="info" text={keepCurrent
            ? 'This email already has an Atelier account. After you accept, sign in to the store app with your current password.'
            : 'This email already has an Atelier account. Set a password for it below. It becomes the password for this email everywhere on Atelier.'} />
        </View>
      )}
      {choosesPassword && (
        <>
          <PasswordField label={invite.hasAccount ? 'Set a password' : 'Create a password'} value={pw} onChangeText={setPw} autoComplete="new-password" />
          <PasswordChecklist password={pw} />
          <PasswordField
            label="Confirm password" value={pw2} onChangeText={setPw2} autoComplete="new-password"
            error={pw2.length > 0 && !match ? 'The passwords don’t match.' : null} onSubmitEditing={accept}
          />
        </>
      )}
      {invite.hasAccount && (
        <Text style={s.switch} onPress={() => { setKeepCurrent((k) => !k); setPw(''); setPw2('') }} accessibilityRole="button">
          {keepCurrent ? 'Set a new password instead' : 'I know my current password — keep it'}
        </Text>
      )}

      {problem && <View style={{ marginTop: Space.md }}><Banner tone="error" text={problem.text} /></View>}
      <Btn
        label="Accept invite" onPress={accept} loading={busy} style={{ marginTop: Space.lg }}
        disabled={busy || (choosesPassword && (!passwordOk(pw) || !match))}
      />
      <Text style={s.small}>Next, your store buys a credit package from Plan & Credits in the store app.</Text>
    </AuthShell>
  )
}

const s = StyleSheet.create({
  small: { ...Typography.caption, color: Colors.textMuted, textAlign: 'center', marginTop: Space.md },
  switch: { ...Typography.bodySmall, ...Weight.semibold, color: Colors.secondary, textDecorationLine: 'underline', marginTop: Space.md, alignSelf: 'flex-start' },
})
