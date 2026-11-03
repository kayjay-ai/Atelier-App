import { useEffect, useState } from 'react'
import { View, Text, TextInput, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '../lib/supabaseClient'
import { upsertProfile } from '../lib/supabaseStorage'
import { useProfileStore } from '../lib/store'
import { FREE_CREDITS } from '../lib/pricing'
import { Colors, Typography, Space, Radius } from '../lib/theme'
import { Icon, PillButton } from '../lib/ui'
import { DateOfBirthField, parseDob, dobFromIso, type DobValue } from '../components/DateOfBirthField'

// New B2C account (spec §3.1): name + date of birth (18+ matters for "Should I
// Buy It?"), then the 3-free-try-ons welcome with Set up profile / Skip.
export default function WelcomeScreen() {
  const profile = useProfileStore()
  const [user, setUser] = useState<{ id: string; email: string; fullName?: string } | null>(null)
  const [step, setStep] = useState<'details' | 'welcome'>('details')
  const [name, setName] = useState('')
  const [dob, setDob] = useState<DobValue>({ day: '', month: '', year: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const u = data.session?.user
      if (!u) { router.replace('/auth'); return }
      // Google sign-in already gives us a name.
      const fullName = (u.user_metadata?.full_name || u.user_metadata?.name) as string | undefined
      setUser({ id: u.id, email: u.email ?? '', fullName })
      await profile.hydrate(u.id)
      const p = useProfileStore.getState()
      setName(p.name ?? fullName ?? '')
      setDob(dobFromIso(p.dateOfBirth))
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function saveDetails() {
    if (!user) return
    setError(null)
    if (name.trim().length < 2) { setError('Enter your name.'); return }
    const parsed = parseDob(dob)
    if ('error' in parsed) { setError(parsed.error); return }
    setSaving(true)
    try {
      await upsertProfile(user.id, user.email, { name: name.trim(), dateOfBirth: parsed.iso })
      profile.setAccount({ name: name.trim(), dateOfBirth: parsed.iso })
      setStep('welcome')
    } catch (e: any) {
      setError(`Couldn't save — ${e?.message ?? 'please try again'}.`)
    } finally {
      setSaving(false)
    }
  }

  if (!user) {
    return <SafeAreaView style={s.safe}><View style={s.center}><ActivityIndicator color={Colors.primary} /></View></SafeAreaView>
  }

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.column}>
          <View style={s.brand}>
            <Text style={s.brandSub}>QUASAR'S</Text>
            <Text style={s.brandMark}>ATELIER</Text>
          </View>

          {step === 'details' ? (
            <>
              <Text style={s.title}>A little about you</Text>
              <Text style={s.subtitle}>Your date of birth lets us tailor advice — some pieces are only meant for certain ages.</Text>

              <Text style={s.fieldLabel}>YOUR NAME</Text>
              <TextInput
                style={s.input} value={name} onChangeText={setName}
                placeholder="Priya Sharma" placeholderTextColor={Colors.textFaint}
                autoCapitalize="words" autoComplete="name"
              />

              <Text style={s.fieldLabel}>DATE OF BIRTH</Text>
              <DateOfBirthField value={dob} onChange={setDob} />

              {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

              <PillButton label="Continue" onPress={saveDetails} loading={saving} style={{ marginTop: Space.xl }} />
            </>
          ) : (
            <View style={s.welcome}>
              <View style={s.giftIcon}><Icon name="star" size={34} color={Colors.textOnDark} /></View>
              <Text style={[s.title, { textAlign: 'center' }]}>Welcome{name ? `, ${name.split(' ')[0]}` : ''}!</Text>
              <Text style={[s.subtitle, { textAlign: 'center' }]}>
                You have {FREE_CREDITS} free try-ons to explore Atelier.
              </Text>
              <Text style={s.note}>
                Try-on works straight away. Add your photo, size and fit preference to unlock Size Assist and your Style report.
              </Text>
              <PillButton label="Set up profile" icon="profile" onPress={() => router.replace('/(tabs)/profile')} style={s.fullBtn} />
              <PillButton label="Skip for now" variant="outline" onPress={() => router.replace('/(tabs)')} style={s.fullBtn} />
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 1, padding: Space.lg, paddingTop: Space.xxl },
  column: { width: '100%', maxWidth: 440, alignSelf: 'center' },

  brand:     { alignItems: 'center', marginBottom: Space.xl },
  brandSub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 11 },
  brandMark: { ...Typography.display, color: Colors.text, fontSize: 32, letterSpacing: 8, fontWeight: '300' },

  title:      { ...Typography.h1, marginBottom: Space.sm },
  subtitle:   { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 22, marginBottom: Space.md },
  fieldLabel: { ...Typography.label, marginBottom: Space.xs, marginTop: Space.lg },
  input: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.base, paddingVertical: 13, ...Typography.body, color: Colors.text,
  },
  errorBox:  { backgroundColor: Colors.errorBg, borderRadius: Radius.sm, padding: Space.md, marginTop: Space.md },
  errorText: { ...Typography.bodySmall, color: Colors.error },

  welcome:  { alignItems: 'center', gap: Space.sm },
  giftIcon: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: Colors.secondary,
    alignItems: 'center', justifyContent: 'center', marginBottom: Space.md,
  },
  note:    { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', lineHeight: 21, marginBottom: Space.lg },
  fullBtn: { alignSelf: 'stretch', marginTop: Space.sm },
})
