import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { supabase } from '../lib/supabaseClient'
import { ApiError, requestPasswordReset } from '../lib/api'
import { Colors, Typography, Space } from '../lib/theme'
import { Field, Notice, PasswordField, PillButton, TextLink, toast } from '../lib/ui'

// "Change password" for a signed-in shopper (Profile) or store login (Company).
// Step 1: "Update password" emails a one-time code to the account's email
// (POST /api/auth/password-reset, reason 'change'). Step 2: the code and the
// new password; the app checks the code with Supabase (verifyOtp, type
// 'recovery', which renews this session for the same account) and sets it.
// Renders no card of its own: the screen puts it in one.

export function ChangePassword({ email }: { email: string }) {
  const [step, setStep] = useState<'start' | 'code'>('start')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [verified, setVerified] = useState(false) // code accepted; only the password is left
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resendIn, setResendIn] = useState(0)

  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  function reset() {
    setStep('start'); setCode(''); setPassword(''); setVerified(false); setError(null)
  }

  async function sendCode(again = false) {
    if (again && resendIn > 0) return
    setError(null)
    setBusy(!again)
    try {
      const r = await requestPasswordReset(email, 'change')
      setResendIn(r.resendInSec); setCode(''); setVerified(false)
      setStep('code')
      if (again) toast('A new code is on its way. Older codes no longer work.')
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'cooldown') {
        if (e.extra.retryInSec) setResendIn(Number(e.extra.retryInSec))
        // A code went out a moment ago (e.g. the button was pressed twice): it's still good.
        if (!again) { setStep('code'); return }
      }
      setError(e?.message ?? 'Couldn’t send the code — please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setError(null)
    if (!verified && code.trim().length < 6) { setError('Enter the code from the email.'); return }
    if (password.length < 8) { setError('Use at least 8 characters for your new password.'); return }
    setBusy(true)
    try {
      if (!verified) {
        const { error: otpErr } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'recovery' })
        if (otpErr) {
          throw new Error(/expired|invalid/i.test(otpErr.message)
            ? 'That code isn’t right or has expired. Check it, or send a new one.' : otpErr.message)
        }
        setVerified(true)
      }
      const { error: upErr } = await supabase.auth.updateUser({ password })
      if (upErr) {
        throw new Error(upErr.code === 'same_password' || /different from the old/i.test(upErr.message)
          ? 'Choose a password you haven’t used for this account.' : upErr.message)
      }
      reset()
      toast('Password changed. Use it next time you sign in on any device.')
    } catch (e: any) {
      setError(e?.message ?? 'Couldn’t change your password — please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (step === 'start') {
    return (
      <View style={s.wrap}>
        <Text style={s.muted}>We’ll email a code to {email || 'your email'} to confirm it’s you, then you choose a new password.</Text>
        {error && <Notice tone="error" text={error} />}
        <PillButton label="Update password" size="md" onPress={() => sendCode()} loading={busy} disabled={!email} />
      </View>
    )
  }

  return (
    <View style={s.wrap}>
      <Notice tone="info" text={`We sent a code to ${email}. Check your inbox (and spam). It expires in 1 hour.`} />
      <Field
        label="Code from the email" value={code}
        onChangeText={(v) => { setCode(v.replace(/\D/g, '').slice(0, 10)); setVerified(false) }}
        placeholder="123456" keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
        inputStyle={s.codeInput} containerStyle={{ marginTop: 0 }} editable={!verified && !busy}
      />
      <TextLink
        label={resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'} tone={resendIn > 0 ? 'muted' : 'ink'}
        onPress={() => sendCode(true)} style={{ alignSelf: 'flex-end' }}
      />
      <PasswordField
        label="New password" value={password} onChangeText={setPassword}
        placeholder="At least 8 characters" autoComplete="new-password" textContentType="newPassword"
        onSubmitEditing={save} containerStyle={{ marginTop: 0 }}
      />
      {error && <Notice tone="error" text={error} />}
      <PillButton label="Set new password" size="md" onPress={save} loading={busy} />
      <PillButton label="Cancel" variant="ghost" size="md" onPress={reset} disabled={busy} />
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { gap: Space.md },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  codeInput: { fontSize: 22, letterSpacing: 8, textAlign: 'center' },
})
