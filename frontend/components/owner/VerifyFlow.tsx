import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, StyleSheet, AppState, Platform } from 'react-native'
import { router } from 'expo-router'
import {
  ApiError, ownerVerify, ownerResendCode, ownerConfirmCode, ownerTokenStatus, ownerSetPassword, type OwnerPurpose,
} from '../../lib/api'
import { adoptOwnerSession, passwordOk, takePrefill, usePrefill, useOwnerStore } from '../../lib/owner'
import { Colors, Typography, Space } from '../../lib/theme'
import { AuthShell } from './AuthShell'
import { Banner, Btn, Field, LinkText, OtpInput, PasswordChecklist, PasswordField } from './kit'

// Activation and Forgot password share these three screens (flow doc):
//   A  store code + email → Verify        (POST /api/owner/activate/verify | /forgot)
//   B  6-digit code from the email        (POST /api/owner/otp/confirm, /otp/resend)
//   C  create / set a new password        (POST /api/owner/password) → signed in → Home

type Step = 'details' | 'code' | 'password'
type Problem = { text: string; code: string | null }

const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
const problemOf = (e: any): Problem => ({ text: e?.message ?? 'Something went wrong — please try again.', code: e instanceof ApiError ? e.code : null })

export function VerifyFlow({ purpose }: { purpose: OwnerPurpose }) {
  const reset = purpose === 'reset'
  const [step, setStep] = useState<Step>('details')
  const [orgCode, setOrgCode] = useState('')
  const [email, setEmail] = useState('')
  const [masked, setMasked] = useState('')
  const [code, setCode] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const tokenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { const e = takePrefill('ownerEmail'); if (e) setEmail(e) }, [])

  // Resend countdown.
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  useEffect(() => () => { if (tokenTimer.current) clearTimeout(tokenTimer.current) }, [])

  const backToDetails = useCallback((p: Problem | null) => {
    setStep('details'); setCode(''); setToken(null); setPw(''); setPw2(''); setProblem(p)
  }, [])

  // Screen C: the 15-minute token can run out, or the account can be activated
  // in another tab — re-check whenever the page comes back into view.
  useEffect(() => {
    if (step !== 'password' || !token) return
    let cancelled = false
    const recheck = async () => {
      try {
        const st = await ownerTokenStatus(token)
        if (cancelled || st.valid) return
        if (st.reason === 'already_active') setProblem({ text: 'Your account is already active. Log in instead.', code: 'already_active' })
        else backToDetails({ text: 'Your session expired. Verify again.', code: 'token_expired' })
      } catch {}
    }
    if (Platform.OS === 'web') {
      const onVis = () => { if (document.visibilityState === 'visible') recheck() }
      window.addEventListener('focus', recheck)
      document.addEventListener('visibilitychange', onVis)
      return () => { cancelled = true; window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', onVis) }
    }
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') recheck() })
    return () => { cancelled = true; sub.remove() }
  }, [step, token, backToDetails])

  function toLogin() {
    usePrefill.getState().put({ ownerEmail: email.trim() })
    router.replace('/owner/login')
  }
  function toActivate() {
    usePrefill.getState().put({ ownerEmail: email.trim() })
    router.replace('/owner/activate')
  }

  // TEMPORARY test mode (the API has no email yet): the code is shown and filled
  // in here instead of emailed. Gone once the server's email is set up.
  function showTestCode(testCode?: string) {
    setCode(testCode ?? '')
    if (testCode) setInfo(`Test mode — email isn’t set up yet, so your code is ${testCode}. It’s filled in below; press Continue.`)
  }

  async function verify() {
    setBusy(true); setProblem(null); setInfo(null)
    try {
      const r = await ownerVerify(orgCode.trim(), email.trim(), purpose)
      setMasked(r.maskedEmail); setCooldown(r.resendInSec); setStep('code')
      showTestCode(r.testCode)
    } catch (e) {
      setProblem(problemOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function resend() {
    setProblem(null); setInfo(null)
    try {
      const r = await ownerResendCode(email.trim(), purpose)
      setMasked(r.maskedEmail); setCooldown(r.resendInSec)
      setInfo('A new code is on its way. Older codes no longer work.')
      showTestCode(r.testCode)
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'cooldown' && e.extra.retryInSec) setCooldown(Number(e.extra.retryInSec))
      if (e instanceof ApiError && e.code === 'restart') { backToDetails(problemOf(e)); return }
      setProblem(problemOf(e))
    }
  }

  async function confirm(value: string) {
    if (busy) return
    setBusy(true); setProblem(null); setInfo(null)
    try {
      const r = await ownerConfirmCode(email.trim(), value, purpose)
      setToken(r.token); setStep('password')
      if (tokenTimer.current) clearTimeout(tokenTimer.current)
      tokenTimer.current = setTimeout(() => backToDetails({ text: 'Your session expired. Verify again.', code: 'token_expired' }), r.expiresInSec * 1000)
    } catch (e) {
      setProblem(problemOf(e)); setCode('')
    } finally {
      setBusy(false)
    }
  }

  async function savePassword() {
    if (!token || !passwordOk(pw) || pw !== pw2) return
    setBusy(true); setProblem(null)
    try {
      const { session } = await ownerSetPassword(token, pw)
      if (tokenTimer.current) clearTimeout(tokenTimer.current)
      await adoptOwnerSession(session)
      await useOwnerStore.getState().load()
      router.replace('/owner/home')
    } catch (e: any) {
      const p = problemOf(e)
      if (p.code === 'token_expired') backToDetails(p)
      else setProblem(p)
      setBusy(false)
    }
  }

  // ── Screen A ───────────────────────────────────────────────────────────────
  if (step === 'details') {
    const canVerify = orgCode.trim().length > 0 && looksLikeEmail(email) && !busy
    return (
      <AuthShell
        title={reset ? 'Reset your password.' : 'Verify your account.'}
        subtitle={reset
          ? 'Enter your store code and the email registered for your organization. We’ll email you a code.'
          : 'Enter the store code Atelier gave you and the email it was registered to. We’ll email you a 6-digit code.'}
      >
        <Field
          label="Store code" value={orgCode} onChangeText={(v) => setOrgCode(v.toUpperCase().replace(/\s/g, ''))}
          placeholder="ABCD" autoCapitalize="characters" autoCorrect={false} maxLength={12}
        />
        <Field
          label="Email" value={email} onChangeText={setEmail} placeholder="you@brand.com"
          keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
          onSubmitEditing={() => canVerify && verify()}
        />
        {problem && (
          <View style={s.problem}>
            <Banner tone="error" text={problem.text} />
            {problem.code === 'already_active' && <Btn label="Log in" kind="secondary" small onPress={toLogin} />}
            {problem.code === 'not_activated' && <Btn label="Activate now" kind="secondary" small onPress={toActivate} />}
          </View>
        )}
        <Btn label="Verify" onPress={verify} loading={busy} disabled={!canVerify} style={{ marginTop: Space.lg }} />
        <View style={s.links}><LinkText label="Back to sign in" onPress={toLogin} /></View>
      </AuthShell>
    )
  }

  // ── Screen B ───────────────────────────────────────────────────────────────
  if (step === 'code') {
    return (
      <AuthShell title="Enter the code." showSwitch={false}>
        <Text style={s.copy}>We’ve sent a 6-digit code to <Text style={s.bold}>{masked}</Text>. It works for 10 minutes.</Text>
        <LinkText label="Wrong email? Go back." onPress={() => backToDetails(null)} style={{ alignSelf: 'flex-start' }} />
        <OtpInput value={code} onChange={(v) => { setCode(v); setProblem(null) }} onComplete={confirm} disabled={busy} error={!!problem} />
        {problem && <Banner tone="error" text={problem.text} />}
        {info && <Banner tone="success" text={info} />}
        <Btn label="Continue" onPress={() => confirm(code)} loading={busy} disabled={code.length !== 6 || busy} style={{ marginTop: Space.lg }} />
        <View style={s.links}>
          {cooldown > 0
            ? <Text style={s.muted}>Resend code in {cooldown}s</Text>
            : <LinkText label="Resend code" onPress={resend} />}
        </View>
      </AuthShell>
    )
  }

  // ── Screen C ───────────────────────────────────────────────────────────────
  const match = pw2.length > 0 && pw === pw2
  return (
    <AuthShell title={reset ? 'Set a new password.' : 'Create your password.'} showSwitch={false}
      subtitle={reset ? 'Your other devices will be signed out.' : 'You’ll sign in with your email and this password from now on.'}>
      <PasswordField label="New password" value={pw} onChangeText={setPw} autoComplete="new-password" />
      <PasswordChecklist password={pw} />
      <PasswordField
        label="Confirm password" value={pw2} onChangeText={setPw2} autoComplete="new-password"
        error={pw2.length > 0 && !match ? 'The passwords don’t match.' : null}
        onSubmitEditing={savePassword}
      />
      {problem && (
        <View style={s.problem}>
          <Banner tone="error" text={problem.text} />
          {problem.code === 'already_active' && <Btn label="Log in" kind="secondary" small onPress={toLogin} />}
        </View>
      )}
      <Btn
        label={reset ? 'Set new password' : 'Create password'} onPress={savePassword} loading={busy}
        disabled={!passwordOk(pw) || !match || busy || problem?.code === 'already_active'} style={{ marginTop: Space.lg }}
      />
    </AuthShell>
  )
}

const s = StyleSheet.create({
  problem: { marginTop: Space.md, gap: Space.sm },
  links: { marginTop: Space.lg, alignItems: 'center' },
  copy: { ...Typography.body, color: Colors.textMuted },
  bold: { fontWeight: '700', color: Colors.text },
  muted: { ...Typography.bodySmall, color: Colors.textFaint },
})
