import { useEffect, useState } from 'react'
import { View, StyleSheet } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError, ownerLogin } from '../../lib/api'
import { adoptOwnerSession, safeNext, takePrefill, usePrefill, useOwnerStore } from '../../lib/owner'
import { Space } from '../../lib/theme'
import { Checkbox, Loading } from '../../lib/ui'
import { AuthShell } from '../../components/owner/AuthShell'
import { Banner, Btn, Field, LinkText, PasswordField } from '../../components/owner/kit'

// Owner login: email + password (the store code is only asked once, at
// activation). "Keep me signed in" = 30 days, otherwise 24 hours.
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())

export default function OwnerLogin() {
  const { next } = useLocalSearchParams<{ next?: string }>()
  const [checking, setChecking] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; code: string | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const prefilled = takePrefill('ownerEmail')
    if (prefilled) setEmail(prefilled)
    const n = takePrefill('notice')
    if (n) setNotice(n)
    // Already signed in as an owner: straight to the portal.
    useOwnerStore.getState().load().finally(() => {
      if (useOwnerStore.getState().status === 'ready') router.replace(safeNext(next) as any)
      else setChecking(false)
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const canSubmit = looksLikeEmail(email) && password.length > 0 && !busy

  async function submit() {
    if (!canSubmit) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const { session } = await ownerLogin(email.trim(), password, remember)
      await adoptOwnerSession(session)
      await useOwnerStore.getState().load()
      router.replace(safeNext(next) as any)
    } catch (e: any) {
      setError({ text: e?.message ?? 'Sign-in failed. Please try again.', code: e instanceof ApiError ? e.code : null })
      setBusy(false)
    }
  }

  function toActivate() {
    usePrefill.getState().put({ ownerEmail: email.trim() })
    router.push('/owner/activate')
  }

  if (checking) return <Loading />

  return (
    <AuthShell title="Owner sign-in" subtitle="Follow every store in your organization: status, devices, credits and payments.">
      {notice && <Banner tone="info" text={notice} />}

      <Field
        label="Email" value={email} onChangeText={setEmail} placeholder="you@brand.com"
        keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
      />
      <PasswordField
        label="Password" value={password} onChangeText={setPassword} placeholder="••••••••"
        autoComplete="current-password" onSubmitEditing={submit}
      />

      <View style={{ marginTop: Space.lg }}>
        <Checkbox
          checked={remember} onChange={setRemember} label="Keep me signed in"
          hint={remember ? 'For 30 days on this device.' : 'You will be signed out after 24 hours.'}
        />
      </View>

      {error && (
        <View style={{ marginTop: Space.md, gap: Space.sm }}>
          <Banner tone="error" text={error.text} />
          {error.code === 'not_activated' && <Btn label="Activate now" kind="secondary" small onPress={toActivate} />}
        </View>
      )}

      <Btn label="Sign in" onPress={submit} loading={busy} disabled={!canSubmit} style={{ marginTop: Space.lg }} />

      <View style={s.links}>
        <LinkText label="First time here? Activate your account" onPress={toActivate} />
        <LinkText label="Forgot password?" onPress={() => { usePrefill.getState().put({ ownerEmail: email.trim() }); router.push('/owner/forgot') }} />
      </View>
    </AuthShell>
  )
}

const s = StyleSheet.create({
  links: { marginTop: Space.lg, alignItems: 'center', gap: Space.xs },
})
