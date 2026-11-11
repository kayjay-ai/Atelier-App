import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError, ownerLogin } from '../../lib/api'
import { adoptOwnerSession, safeNext, takePrefill, usePrefill, useOwnerStore } from '../../lib/owner'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon } from '../../lib/ui'
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

  if (checking) {
    return <View style={s.center}><ActivityIndicator color={Colors.primary} /></View>
  }

  return (
    <AuthShell title="Owner sign-in." subtitle="Follow every store in your organization: status, devices, credits and payments.">
      {notice && <Banner tone="info" text={notice} />}

      <Field
        label="Email" value={email} onChangeText={setEmail} placeholder="you@brand.com"
        keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
      />
      <PasswordField
        label="Password" value={password} onChangeText={setPassword} placeholder="••••••••"
        autoComplete="current-password" onSubmitEditing={submit}
      />

      <TouchableOpacity
        style={s.check} onPress={() => setRemember((v) => !v)}
        accessibilityRole="checkbox" accessibilityState={{ checked: remember }}
      >
        <View style={[s.box, remember && s.boxOn]}>{remember && <Icon name="check" size={14} color={Colors.textOnDark} />}</View>
        <View style={{ flex: 1 }}>
          <Text style={s.checkLabel}>Keep me signed in</Text>
          <Text style={s.checkHint}>{remember ? 'For 30 days on this device.' : 'You’ll be signed out after 24 hours.'}</Text>
        </View>
      </TouchableOpacity>

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
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  check: { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginTop: Space.lg },
  box: {
    width: 22, height: 22, borderRadius: Radius.sm - 2, borderWidth: 1.5, borderColor: Colors.secondary,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: Colors.secondary },
  checkLabel: { ...Typography.bodySmall, fontWeight: '600' },
  checkHint: { ...Typography.caption, color: Colors.textFaint },
  links: { marginTop: Space.lg, alignItems: 'center', gap: Space.xs },
})
