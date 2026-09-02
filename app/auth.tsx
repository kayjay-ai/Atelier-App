import { useState, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, ScrollView, ActivityIndicator, Platform,
} from 'react-native'
import { router } from 'expo-router'
import { supabase } from '../lib/supabaseClient'
import { Colors, Typography, Space, Radius } from '../lib/theme'

export default function AuthScreen() {
  const [checking, setChecking] = useState(true)
  const [mode, setMode]       = useState<'login' | 'signup'>('login')
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [info, setInfo]       = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession()
      .then(({ data: { session } }) => {
        if (session) {
          router.replace('/(tabs)')
        } else {
          setChecking(false)
        }
      })
      .catch(() => setChecking(false))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    setLoading(true)
    setError(null)
    setInfo(null)
    try {
      if (mode === 'login') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        router.replace('/(tabs)')
      } else {
        const { error } = await supabase.auth.signUp({ email, password })
        if (error) throw error
        setInfo('Check your email for a confirmation link.')
      }
    } catch (e: any) {
      setError(e.message ?? 'Sign-in failed.')
    } finally {
      setLoading(false)
    }
  }

  async function signInWithGoogle() {
    setGoogleLoading(true)
    setError(null)
    try {
      const redirectTo = Platform.OS === 'web'
        ? `${window.location.origin}/auth/callback`
        : 'atelier://auth/callback'
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      })
      if (error) throw error
      // On web: Supabase redirects the browser. On native: expo-web-browser opens.
    } catch (e: any) {
      if (e.message?.toLowerCase().includes('provider')) {
        setError('Google sign-in is not yet configured. Enable Google in your Supabase project → Authentication → Providers.')
      } else {
        setError(e.message ?? 'Google sign-in failed.')
      }
    } finally {
      setGoogleLoading(false)
    }
  }

  if (checking) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator color={Colors.primary} />
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">

        {/* Brand */}
        <View style={s.brand}>
          <Text style={s.brandSub}>QUASAR'S</Text>
          <Text style={s.brandMark}>ATELIER</Text>
        </View>

        <Text style={s.title}>{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</Text>
        <Text style={s.subtitle}>
          {mode === 'login'
            ? 'Sign in to access your style profile and history.'
            : 'Join to start building your personal wardrobe intelligence.'}
        </Text>

        {/* Google */}
        <TouchableOpacity
          style={[s.googleBtn, googleLoading && { opacity: 0.6 }]}
          onPress={signInWithGoogle}
          disabled={googleLoading}
        >
          {googleLoading
            ? <ActivityIndicator color={Colors.text} />
            : <>
                <Text style={s.googleIcon}>G</Text>
                <Text style={s.googleText}>Continue with Google</Text>
              </>}
        </TouchableOpacity>

        {/* Divider */}
        <View style={s.divRow}>
          <View style={s.divLine} />
          <Text style={s.divLabel}>or</Text>
          <View style={s.divLine} />
        </View>

        {/* Email / password */}
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
        />

        <Text style={s.fieldLabel}>Password</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          placeholderTextColor={Colors.textFaint}
          secureTextEntry
        />

        {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}
        {info  && <View style={s.infoBox}><Text style={s.infoText}>{info}</Text></View>}

        <TouchableOpacity
          style={[s.submitBtn, loading && { opacity: 0.6 }]}
          onPress={submit}
          disabled={loading}
        >
          {loading
            ? <ActivityIndicator color={Colors.textOnDark} />
            : <Text style={s.submitText}>
                {mode === 'login' ? 'Sign in' : 'Create account'}
              </Text>}
        </TouchableOpacity>

        <TouchableOpacity
          style={s.toggleRow}
          onPress={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setInfo(null) }}
        >
          <Text style={s.toggleText}>
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <Text style={s.toggleLink}>{mode === 'login' ? 'Sign up' : 'Sign in'}</Text>
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={s.guestRow} onPress={() => router.replace('/(tabs)')}>
          <Text style={s.guestText}>Continue without an account →</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: Space.lg, paddingTop: Space.xxl },

  brand:     { alignItems: 'center', marginBottom: Space.xl },
  brandSub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 11 },
  brandMark: { ...Typography.display, color: Colors.text, fontSize: 32, letterSpacing: 8, fontWeight: '300' },

  title:    { ...Typography.h1, marginBottom: Space.sm },
  subtitle: { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 22, marginBottom: Space.xl },

  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Space.sm, backgroundColor: Colors.bgCard,
    borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.secondary,
    paddingVertical: 15, marginBottom: Space.lg,
  },
  googleIcon: { fontSize: 16, fontWeight: '700', color: Colors.text, fontFamily: 'serif' },
  googleText: { ...Typography.body, fontWeight: '500', color: Colors.text },

  divRow:  { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginBottom: Space.lg },
  divLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  divLabel: { ...Typography.caption, color: Colors.textFaint },

  fieldLabel: { ...Typography.label, marginBottom: Space.xs, marginTop: Space.md },
  input: {
    backgroundColor: Colors.bgSubtle,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.base,
    paddingVertical: 13,
    ...Typography.body,
    color: Colors.text,
  },

  errorBox: { backgroundColor: Colors.errorBg, borderRadius: Radius.sm, padding: Space.md, marginTop: Space.md },
  errorText: { ...Typography.bodySmall, color: Colors.error },
  infoBox:  { backgroundColor: Colors.successBg, borderRadius: Radius.sm, padding: Space.md, marginTop: Space.md },
  infoText: { ...Typography.bodySmall, color: Colors.success },

  submitBtn: {
    backgroundColor: Colors.secondary, borderRadius: Radius.full,
    paddingVertical: 16, alignItems: 'center', marginTop: Space.lg,
  },
  submitText: { ...Typography.body, fontWeight: '600', color: Colors.textOnDark },

  toggleRow: { paddingVertical: Space.lg, alignItems: 'center' },
  toggleText: { ...Typography.bodySmall, color: Colors.textMuted },
  toggleLink: { color: Colors.secondary, fontWeight: '600' },

  guestRow: { paddingBottom: Space.xl, alignItems: 'center' },
  guestText: { ...Typography.caption, color: Colors.textFaint },
})
