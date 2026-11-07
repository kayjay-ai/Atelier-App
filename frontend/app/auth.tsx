import { useState, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, ScrollView, ActivityIndicator, Platform,
} from 'react-native'
import { router } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { supabase } from '../lib/supabaseClient'
import { readAuthReturn } from '../lib/oauthReturn'
import { useAccountStore, homeFor } from '../lib/account'
import { fetchProfile, upsertProfile } from '../lib/supabaseStorage'
import { fetchAccountType } from '../lib/api'
import { Colors, Typography, Space, Radius } from '../lib/theme'
import { DateOfBirthField, parseDob, type DobValue } from '../components/DateOfBirthField'

const EMPTY_DOB: DobValue = { day: '', month: '', year: '' }
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())

// The server's account type — never the sign-in method — picks the interface:
// company logins open the B2B store app, everyone else the B2C app. A personal
// account saves the date of birth typed on this page; one still missing a date
// of birth (and the email form wasn't used, e.g. Google) or a name goes through
// /welcome (spec §3.1). Returns 'needsDob' when the email form must ask for it.
async function enterApp(opts: { dob?: string; fromForm?: boolean } = {}): Promise<'needsDob' | void> {
  const account = await useAccountStore.getState().load()
  if (account?.type !== 'b2b_company') {
    const { userId, email } = useAccountStore.getState()
    const profile = userId ? await fetchProfile(userId) : null
    let dateOfBirth = profile?.dateOfBirth ?? null
    // Only when the database has the column (b2c-app.sql); a failed save never
    // blocks signing in — the profile / welcome page can save it later.
    if (userId && profile?.hasAccountColumns && opts.dob && opts.dob !== dateOfBirth) {
      try {
        await upsertProfile(userId, email ?? '', { dateOfBirth: opts.dob })
        dateOfBirth = opts.dob
      } catch (e: any) {
        console.warn('[Atelier] saving date of birth failed:', e?.message)
      }
    }
    if (profile?.hasAccountColumns && !dateOfBirth && opts.fromForm) return 'needsDob'
    if (profile?.hasAccountColumns && (!dateOfBirth || !profile.name)) {
      router.replace('/welcome')
      return
    }
  }
  router.replace(homeFor(account))
}

// Where Google / Apple send the browser back to. Web: the Supabase client reads
// the session from the URL when this screen loads (detectSessionInUrl). iPad /
// phone: signInWith() reads it from the atelier://auth link (lib/oauthReturn.ts);
// that link must be in Supabase → Authentication → URL Configuration → Redirect URLs.
const oauthRedirect = () => (Platform.OS === 'web' ? `${window.location.origin}/auth` : 'atelier://auth')

// Apple requires "Sign in with Apple" wherever Google sign-in is offered on iOS.
// Needs the Apple provider configured in Supabase, so it's behind a flag.
function showApple(): boolean {
  if (process.env.EXPO_PUBLIC_APPLE_SIGNIN !== 'true') return false
  if (Platform.OS === 'ios') return true
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return false
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
}

type Mode = 'login' | 'signup' | 'verify'

export default function AuthScreen() {
  const [checking, setChecking] = useState(true)
  const [mode, setMode]       = useState<Mode>('login')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode]       = useState('')
  const [loading, setLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState<null | 'google' | 'apple'>(null)
  const [error, setError]     = useState<string | null>(null)
  const [info, setInfo]       = useState<string | null>(null)
  const [dob, setDob]         = useState<DobValue>(EMPTY_DOB)
  // Sign-in: is the typed email a company login or a personal account?
  const [emailType, setEmailType] = useState<'unknown' | 'company' | 'personal'>('unknown')
  // Signed in, but this personal account has no date of birth yet.
  const [dobNeeded, setDobNeeded] = useState(false)

  useEffect(() => {
    if (mode !== 'login' || !looksLikeEmail(email)) { setEmailType('unknown'); return }
    let cancelled = false
    const t = setTimeout(async () => {
      const type = await fetchAccountType(email.trim())
      if (!cancelled) setEmailType(type ?? 'personal') // can't tell → show the field
    }, 450)
    return () => { cancelled = true; clearTimeout(t) }
  }, [email, mode])

  const showDob = mode === 'signup' || (mode === 'login' && (emailType === 'personal' || dobNeeded))
  const dobTyped = !!(dob.day || dob.month || dob.year)

  /** The typed date of birth as YYYY-MM-DD; throws a friendly error if it's invalid. */
  function dobIso(required: boolean): string | undefined {
    if (!showDob || (!required && !dobTyped)) return undefined
    const parsed = parseDob(dob)
    if ('error' in parsed) throw new Error(parsed.error)
    return parsed.iso
  }

  useEffect(() => {
    // Also covers returning from Google / Apple: the session arrives in the URL.
    supabase.auth.getSession()
      .then(async ({ data: { session } }) => {
        if (session) await enterApp()
        else setChecking(false)
      })
      .catch((e) => {
        setError(`Couldn't load your account — ${e?.message ?? 'please try again'}.`)
        setChecking(false)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function switchMode(next: Mode) {
    setMode(next); setError(null); setInfo(null); setCode('')
    if (next !== 'verify') setDobNeeded(false) // verify keeps the signup date of birth
  }

  async function submit() {
    setLoading(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'login') {
        const dateOfBirth = dobIso(dobNeeded)
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) throw error
        if (await enterApp({ dob: dateOfBirth, fromForm: true }) === 'needsDob') {
          setDobNeeded(true)
          setError('Add your date of birth to finish signing in — we only ask once.')
        }
      } else if (mode === 'signup') {
        const dateOfBirth = dobIso(true)
        if (password.length < 8) throw new Error('Use at least 8 characters for your password.')
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(), password,
          // Saved to the profile by the database as soon as the account exists.
          options: { emailRedirectTo: oauthRedirect(), data: { date_of_birth: dateOfBirth } },
        })
        if (error) throw error
        if (data.session) { await enterApp({ dob: dateOfBirth }); return } // email confirmation switched off
        setMode('verify')
        setInfo(`We sent a verification code to ${email.trim()}.`)
      } else {
        const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'signup' })
        if (error) throw error
        const parsed = parseDob(dob)
        await enterApp({ dob: 'iso' in parsed ? parsed.iso : undefined })
      }
    } catch (e: any) {
      setError(e?.message ?? 'Something went wrong — please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function resendCode() {
    setError(null)
    const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() })
    if (error) setError(error.message)
    else setInfo('A new code is on its way.')
  }

  async function signInWith(provider: 'google' | 'apple') {
    setOauthLoading(provider)
    setError(null)
    try {
      if (Platform.OS === 'web') {
        const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: oauthRedirect() } })
        if (error) throw error
        return // the browser leaves for the provider and comes back to /auth
      }
      // iPad / phone: sign in inside a secure browser sheet; the provider returns
      // to atelier://auth with the session, which closes the sheet.
      const redirectTo = oauthRedirect()
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider, options: { redirectTo, skipBrowserRedirect: true },
      })
      if (error) throw error
      if (!data?.url) throw new Error('Sign-in could not start.')
      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo)
      if (result.type !== 'success') { setOauthLoading(null); return } // closed by the user
      const back = readAuthReturn(result.url)
      if (back.kind === 'error') throw new Error(back.message)
      if (back.kind === 'code') {
        const { error: exErr } = await supabase.auth.exchangeCodeForSession(back.code)
        if (exErr) throw exErr
      } else if (back.kind === 'tokens') {
        const { error: setErr } = await supabase.auth.setSession({
          access_token: back.accessToken, refresh_token: back.refreshToken,
        })
        if (setErr) throw setErr
      } else {
        throw new Error('Sign-in did not complete. Please try again.')
      }
      await enterApp()
      setOauthLoading(null)
    } catch (e: any) {
      const name = provider === 'google' ? 'Google' : 'Apple'
      setError(e?.message?.toLowerCase().includes('provider')
        ? `${name} sign-in isn't switched on yet — use email for now.`
        : e?.message ?? `${name} sign-in failed.`)
      setOauthLoading(null)
    }
  }

  if (checking) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.center}><ActivityIndicator color={Colors.primary} /></View>
      </SafeAreaView>
    )
  }

  const title = mode === 'login' ? 'Welcome back.' : mode === 'signup' ? 'Create your account.' : 'Check your email.'
  const subtitle = mode === 'login'
    ? 'Sign in to see your fittings, style report and credits.'
    : mode === 'signup'
      ? 'New accounts start with 3 free try-ons.'
      : 'Enter the code from the email to finish signing up. You can also tap the link in the email.'

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.column}>

          <View style={s.brand}>
            <Text style={s.brandSub}>QUASAR'S</Text>
            <Text style={s.brandMark}>ATELIER</Text>
          </View>

          <Text style={s.title}>{title}</Text>
          <Text style={s.subtitle}>{subtitle}</Text>
          {mode === 'login' && <Text style={s.staffHint}>Store staff: sign in with your company email.</Text>}

          {mode !== 'verify' && (
            <>
              <TouchableOpacity
                style={[s.oauthBtn, !!oauthLoading && { opacity: 0.6 }]}
                onPress={() => signInWith('google')}
                disabled={!!oauthLoading}
              >
                {oauthLoading === 'google'
                  ? <ActivityIndicator color={Colors.text} />
                  : <><Text style={s.googleIcon}>G</Text><Text style={s.oauthText}>Continue with Google</Text></>}
              </TouchableOpacity>

              {showApple() && (
                <TouchableOpacity
                  style={[s.oauthBtn, s.appleBtn, !!oauthLoading && { opacity: 0.6 }]}
                  onPress={() => signInWith('apple')}
                  disabled={!!oauthLoading}
                >
                  {oauthLoading === 'apple'
                    ? <ActivityIndicator color={Colors.textOnDark} />
                    : <Text style={[s.oauthText, { color: Colors.textOnDark }]}> Sign in with Apple</Text>}
                </TouchableOpacity>
              )}

              <View style={s.divRow}>
                <View style={s.divLine} />
                <Text style={s.divLabel}>or with email</Text>
                <View style={s.divLine} />
              </View>

              <Text style={s.fieldLabel}>Email</Text>
              <TextInput
                style={s.input}
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={Colors.textFaint}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
              />

              <Text style={s.fieldLabel}>Password</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                placeholderTextColor={Colors.textFaint}
                secureTextEntry
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                onSubmitEditing={submit}
              />

              {mode === 'login' && emailType === 'company' && !dobNeeded && (
                <Text style={s.fieldHint}>Company login — this opens your store app.</Text>
              )}

              {showDob && (
                <View style={dobNeeded && s.dobNeeded}>
                  <Text style={s.fieldLabel}>Date of birth</Text>
                  <Text style={s.fieldHint}>
                    {mode === 'signup' || dobNeeded
                      ? 'Helps us tailor advice — some pieces are only meant for certain ages.'
                      : 'Personal account — only needed once. Leave it blank if you’ve added it before.'}
                  </Text>
                  <DateOfBirthField value={dob} onChange={setDob} />
                </View>
              )}
            </>
          )}

          {mode === 'verify' && (
            <>
              <Text style={s.fieldLabel}>Verification code</Text>
              <TextInput
                style={[s.input, s.codeInput]}
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 8))}
                placeholder="123456"
                placeholderTextColor={Colors.textFaint}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                onSubmitEditing={submit}
              />
              <TouchableOpacity style={s.linkRow} onPress={resendCode}>
                <Text style={s.toggleLink}>Resend code</Text>
              </TouchableOpacity>
            </>
          )}

          {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}
          {info  && <View style={s.infoBox}><Text style={s.infoText}>{info}</Text></View>}

          <TouchableOpacity
            style={[s.submitBtn, (loading || (mode === 'verify' && code.length < 6)) && { opacity: 0.6 }]}
            onPress={submit}
            disabled={loading || (mode === 'verify' && code.length < 6)}
          >
            {loading
              ? <ActivityIndicator color={Colors.textOnDark} />
              : <Text style={s.submitText}>
                  {mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Verify and continue'}
                </Text>}
          </TouchableOpacity>

          {mode === 'verify' ? (
            <TouchableOpacity style={s.toggleRow} onPress={() => switchMode('signup')}>
              <Text style={s.toggleText}>Wrong email? <Text style={s.toggleLink}>Go back</Text></Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.toggleRow} onPress={() => switchMode(mode === 'login' ? 'signup' : 'login')}>
              <Text style={s.toggleText}>
                {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
                <Text style={s.toggleLink}>{mode === 'login' ? 'Sign up' : 'Sign in'}</Text>
              </Text>
            </TouchableOpacity>
          )}

        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { flexGrow: 1, padding: Space.lg, paddingTop: Space.xxl },
  // Comfortable reading width on iPad / desktop; full width on phones.
  column: { width: '100%', maxWidth: 440, alignSelf: 'center' },

  brand:     { alignItems: 'center', marginBottom: Space.xl },
  brandSub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 11 },
  brandMark: { ...Typography.display, color: Colors.text, fontSize: 32, letterSpacing: 8, fontWeight: '300' },

  title:    { ...Typography.h1, marginBottom: Space.sm },
  subtitle: { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 22, marginBottom: Space.lg },
  staffHint: { ...Typography.caption, color: Colors.textFaint, marginTop: -Space.md, marginBottom: Space.lg },

  oauthBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Space.sm, backgroundColor: Colors.bgCard, minHeight: 52,
    borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.secondary,
    paddingVertical: 14, marginBottom: Space.md,
  },
  appleBtn:   { backgroundColor: '#000000', borderColor: '#000000' },
  googleIcon: { fontSize: 16, fontWeight: '700', color: Colors.text, fontFamily: 'serif' },
  oauthText:  { ...Typography.body, fontWeight: '500', color: Colors.text },

  divRow:   { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginVertical: Space.md },
  divLine:  { flex: 1, height: 1, backgroundColor: Colors.border },
  divLabel: { ...Typography.caption, color: Colors.textFaint },

  fieldLabel: { ...Typography.label, marginBottom: Space.xs, marginTop: Space.md },
  input: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.base, paddingVertical: 13,
    ...Typography.body, color: Colors.text,
  },
  fieldHint: { ...Typography.caption, color: Colors.textFaint, marginTop: Space.xs, marginBottom: Space.xs },
  dobNeeded: { borderLeftWidth: 3, borderLeftColor: Colors.secondary, paddingLeft: Space.md, marginTop: Space.sm },
  codeInput: { fontSize: 22, letterSpacing: 6, textAlign: 'center' },
  linkRow:   { alignSelf: 'flex-end', paddingVertical: Space.sm },

  errorBox: { backgroundColor: Colors.errorBg, borderRadius: Radius.sm, padding: Space.md, marginTop: Space.md },
  errorText: { ...Typography.bodySmall, color: Colors.error },
  infoBox:  { backgroundColor: Colors.successBg, borderRadius: Radius.sm, padding: Space.md, marginTop: Space.md },
  infoText: { ...Typography.bodySmall, color: Colors.success },

  submitBtn: {
    backgroundColor: Colors.secondary, borderRadius: Radius.full, minHeight: 52,
    paddingVertical: 16, alignItems: 'center', justifyContent: 'center', marginTop: Space.lg,
  },
  submitText: { ...Typography.body, fontWeight: '600', color: Colors.textOnDark },

  toggleRow:  { paddingVertical: Space.lg, alignItems: 'center' },
  toggleText: { ...Typography.bodySmall, color: Colors.textMuted },
  toggleLink: { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '600' },

})
