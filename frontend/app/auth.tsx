import { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Platform } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { supabase } from '../lib/supabaseClient'
import { readAuthReturn } from '../lib/oauthReturn'
import { useAccountStore, homeFor, isCompanyLogin } from '../lib/account'
import { fetchProfile, upsertProfile } from '../lib/supabaseStorage'
import { fetchOwnerMe } from '../lib/api'
import { takePrefill } from '../lib/owner'
import { Colors, Typography, Space, Radius, Weight } from '../lib/theme'
import { Field, Icon, Loading, Notice, PasswordField, PillButton, TextLink } from '../lib/ui'
import { DateOfBirthField, parseDob, type DobValue } from '../components/DateOfBirthField'
import { AccountKindSwitch } from '../components/AccountKindSwitch'
import { AuthFrame } from '../components/AuthFrame'

const EMPTY_DOB: DobValue = { day: '', month: '', year: '' }

/** Picked at the top of the page: Personal opens the B2C app, Company the B2B store app. */
type AccountKind = 'personal' | 'company'

/** The signed-in login doesn't match the option picked — shown as is, the user is signed out. */
class WrongKindError extends Error {}

// Google / Apple on the web leave this page and come back to it, so the option
// picked is kept for that one round trip.
const KIND_KEY = 'atelier.authKind'
function rememberKind(kind: AccountKind) {
  if (Platform.OS !== 'web') return
  try { window.sessionStorage.setItem(KIND_KEY, kind) } catch {}
}
function takeRememberedKind(): AccountKind | null {
  if (Platform.OS !== 'web') return null
  try {
    const kind = window.sessionStorage.getItem(KIND_KEY)
    window.sessionStorage.removeItem(KIND_KEY)
    return kind === 'personal' || kind === 'company' ? kind : null
  } catch {
    return null
  }
}

/**
 * The option picked must match the login: only a store login (decided by the
 * database) may open the store app, and a store login can't be used as a
 * personal account. On a mismatch the user is signed out with a clear message.
 */
async function checkKind(kind: AccountKind): Promise<void> {
  const { data } = await supabase.auth.getSession()
  const company = await isCompanyLogin(data.session?.user?.email)
  if (company === (kind === 'company')) return
  // This device only: a store login's other iPads must stay signed in.
  await supabase.auth.signOut({ scope: 'local' })
  throw new WrongKindError(company
    ? 'This is a store login. Choose “Company” › “Store staff” above to open your store app.'
    : 'This email isn’t a store login. Owners: choose “Owner” above. Shoppers: choose “Personal”.')
}

/** An already signed-in owner (owner portal session) goes back to the portal. */
async function isOwnerSession(): Promise<boolean> {
  try {
    await fetchOwnerMe()
    return true
  } catch {
    return false
  }
}

// `as` = the option picked on this page (Personal / Company). Without it (an
// already signed-in session, e.g. a reload) the account decides. A personal
// account saves the date of birth typed on this page; one still missing a date
// of birth (and the email form wasn't used, e.g. Google) or a name goes through
// /welcome (spec §3.1). Returns 'needsDob' when the email form must ask for it.
async function enterApp(opts: { as?: AccountKind; dob?: string; fromForm?: boolean } = {}): Promise<'needsDob' | void> {
  if (opts.as) await checkKind(opts.as)
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
  // ?as=company opens with Company › Store staff picked (the owner login's switch links here).
  const params = useLocalSearchParams<{ as?: string }>()
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
  const [kind, setKind]       = useState<AccountKind>(params.as === 'company' ? 'company' : 'personal')
  // Signed in, but this personal account has no date of birth yet.
  const [dobNeeded, setDobNeeded] = useState(false)

  const company = kind === 'company'
  const showDob = !company && mode !== 'verify'
  const dobTyped = !!(dob.day || dob.month || dob.year)

  /** The typed date of birth as YYYY-MM-DD; throws a friendly error if it's invalid. */
  function dobIso(required: boolean): string | undefined {
    if (!showDob || (!required && !dobTyped)) return undefined
    const parsed = parseDob(dob)
    if ('error' in parsed) throw new Error(parsed.error)
    return parsed.iso
  }

  useEffect(() => {
    // Also covers returning from Google / Apple on the web: the session arrives
    // in the URL, and the option picked before leaving was remembered.
    const picked = takeRememberedKind()
    if (picked) setKind(picked)
    // A store manager who just accepted an owner's invite (/invite) lands here.
    const storeEmail = takePrefill('storeEmail')
    if (storeEmail) { setKind('company'); setEmail(storeEmail) }
    const notice = takePrefill('notice')
    if (notice) setInfo(notice)
    ;(async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session && !picked && await isOwnerSession()) { router.replace('/owner/home'); return }
        if (session) { await enterApp({ as: picked ?? undefined }); return }
      } catch (e: any) {
        setError(e instanceof WrongKindError ? e.message : `Couldn't load your account — ${e?.message ?? 'please try again'}.`)
      }
      setChecking(false)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function switchMode(next: Mode) {
    setMode(next); setError(null); setInfo(null); setCode('')
    if (next !== 'verify') setDobNeeded(false) // verify keeps the signup date of birth
  }

  // Company logins are created by Atelier, so Company is sign-in only.
  function switchKind(next: AccountKind) {
    if (next === kind) return
    setKind(next); setError(null); setInfo(null); setDobNeeded(false)
    if (next === 'company' && mode !== 'login') { setMode('login'); setCode('') }
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
        if (await enterApp({ as: kind, dob: dateOfBirth, fromForm: !company }) === 'needsDob') {
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
        if (data.session) { await enterApp({ as: 'personal', dob: dateOfBirth }); return } // email confirmation switched off
        setMode('verify')
        setInfo(`We sent a verification code to ${email.trim()}.`)
      } else {
        const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'signup' })
        if (error) throw error
        const parsed = parseDob(dob)
        await enterApp({ as: 'personal', dob: 'iso' in parsed ? parsed.iso : undefined })
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
        rememberKind(kind)
        const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: oauthRedirect() } })
        if (error) { takeRememberedKind(); throw error }
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
      await enterApp({ as: kind })
      setOauthLoading(null)
    } catch (e: any) {
      const name = provider === 'google' ? 'Google' : 'Apple'
      setError(e instanceof WrongKindError ? e.message : e?.message?.toLowerCase().includes('provider')
        ? `${name} sign-in isn't switched on yet — use email for now.`
        : e?.message ?? `${name} sign-in failed.`)
      setOauthLoading(null)
    }
  }

  if (checking) return <Loading />

  const title = company ? 'Store sign-in'
    : mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Check your email'
  const subtitle = company
    ? 'Use your store login: the email your owner invited, or the one Atelier set up. This opens your store app.'
    : mode === 'login'
      ? 'Sign in to see your fittings, style report and credits.'
      : mode === 'signup'
        ? 'New accounts start with 3 free try-ons.'
        : 'Enter the code from the email to finish signing up, or tap the link in it.'
  const busy = loading || !!oauthLoading

  return (
    <AuthFrame
      audience={company ? 'company' : 'personal'}
      title={title}
      subtitle={subtitle}
      top={mode !== 'verify' ? (
        <AccountKindSwitch
          value={company ? 'store' : 'personal'}
          onChange={(role) => {
            if (role === 'owner') { router.replace('/owner/login'); return }
            switchKind(role === 'store' ? 'company' : 'personal')
          }}
          disabled={busy}
        />
      ) : undefined}
    >
      {mode !== 'verify' && (
        <>
          <View style={s.oauth}>
            <PillButton
              label="Continue with Google" icon="google" variant="outline" size="md"
              onPress={() => signInWith('google')} loading={oauthLoading === 'google'} disabled={!!oauthLoading}
            />
            {showApple() && (
              <TouchableOpacity
                style={[s.appleBtn, !!oauthLoading && { opacity: 0.5 }]}
                onPress={() => signInWith('apple')} disabled={!!oauthLoading}
                accessibilityRole="button" accessibilityLabel="Sign in with Apple"
              >
                {oauthLoading === 'apple'
                  ? <ActivityIndicator color="#FFFFFF" />
                  : <><Icon name="apple" size={20} color="#FFFFFF" /><Text style={s.appleText}>Sign in with Apple</Text></>}
              </TouchableOpacity>
            )}
          </View>

          <View style={s.divRow}>
            <View style={s.divLine} />
            <Text style={s.divLabel}>or with email</Text>
            <View style={s.divLine} />
          </View>

          <Field
            label="Email" value={email} onChangeText={setEmail}
            placeholder={company ? 'store@yourcompany.com' : 'you@example.com'}
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} autoComplete="email"
            containerStyle={{ marginTop: 0 }}
          />
          <PasswordField
            label="Password" value={password} onChangeText={setPassword}
            placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            onSubmitEditing={submit}
          />

          {showDob && (
            <View style={[s.dob, dobNeeded && s.dobNeeded]}>
              <Text style={Typography.fieldLabel}>
                Date of birth{mode === 'login' && !dobNeeded ? <Text style={s.optional}>  Skip it if you’ve added it before</Text> : null}
              </Text>
              {(mode === 'signup' || dobNeeded) && (
                <Text style={s.fieldHint}>Helps us tailor advice — some pieces are only meant for certain ages.</Text>
              )}
              <DateOfBirthField value={dob} onChange={setDob} />
            </View>
          )}
        </>
      )}

      {mode === 'verify' && (
        <>
          <Field
            label="Verification code" value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 8))}
            placeholder="123456" keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode"
            onSubmitEditing={submit} inputStyle={s.codeInput}
          />
          <TextLink label="Resend code" onPress={resendCode} style={{ alignSelf: 'flex-end', marginTop: Space.sm }} />
        </>
      )}

      {error && <Notice tone="error" text={error} style={s.notice} />}
      {info && <Notice tone="success" text={info} style={s.notice} />}

      <PillButton
        label={mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Verify and continue'}
        onPress={submit} loading={loading} disabled={loading || (mode === 'verify' && code.length < 6)}
        style={{ marginTop: Space.lg }}
      />

      <View style={s.footer}>
        {mode === 'verify' ? (
          <Text style={s.footerText}>Wrong email? <Text style={s.footerLink} onPress={() => switchMode('signup')} accessibilityRole="link">Go back</Text></Text>
        ) : company ? (
          <Text style={s.footerText}>
            No store login yet? Ask your owner to invite you from the owner portal, or contact Atelier support.
          </Text>
        ) : (
          <Text style={s.footerText}>
            {mode === 'login' ? 'New to Atelier? ' : 'Already have an account? '}
            <Text style={s.footerLink} onPress={() => switchMode(mode === 'login' ? 'signup' : 'login')} accessibilityRole="link">
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </Text>
          </Text>
        )}
      </View>
    </AuthFrame>
  )
}

const s = StyleSheet.create({
  oauth: { gap: Space.sm, marginTop: Space.lg },
  appleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm,
    minHeight: 48, borderRadius: Radius.full, backgroundColor: '#000000',
  },
  appleText: { ...Typography.button, color: '#FFFFFF' },

  divRow:   { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginTop: Space.lg, marginBottom: Space.base },
  divLine:  { flex: 1, height: 1, backgroundColor: Colors.border },
  divLabel: { ...Typography.caption },

  dob:       { marginTop: Space.base, gap: 6 },
  dobNeeded: { borderLeftWidth: 3, borderLeftColor: Colors.secondary, paddingLeft: Space.md },
  optional:  { ...Typography.caption },
  fieldHint: { ...Typography.caption, marginBottom: Space.xs },
  codeInput: { fontSize: 22, letterSpacing: 8, textAlign: 'center' },

  notice: { marginTop: Space.base },
  footer: { paddingVertical: Space.lg, alignItems: 'center' },
  footerText: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center' },
  footerLink: { ...Weight.semibold, color: Colors.secondary, textDecorationLine: 'underline' },
})
