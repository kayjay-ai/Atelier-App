import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '../lib/supabaseClient'
import { upsertProfile } from '../lib/supabaseStorage'
import { useProfileStore } from '../lib/store'
import { FREE_CREDITS } from '../lib/pricing'
import { Colors, Typography, Space, Radius } from '../lib/theme'
import { Field, Loading, Notice, PillButton } from '../lib/ui'
import { AuthFrame } from '../components/AuthFrame'
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

  if (!user) return <Loading />

  if (step === 'welcome') {
    const first = name ? name.split(' ')[0] : ''
    return (
      <AuthFrame title={`Welcome${first ? `, ${first}` : ''}`}>
        <View style={s.gift}>
          <Text style={s.giftNum}>{FREE_CREDITS}</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.giftTitle}>free try-ons are yours</Text>
            <Text style={s.giftBody}>Try-on works straight away. Add your photo, size and fit to unlock Size Assist and your Style report.</Text>
          </View>
        </View>
        <PillButton label="Set up my profile" icon="profile" onPress={() => router.replace('/(tabs)/profile')} style={{ marginTop: Space.lg }} />
        <PillButton label="Skip for now" variant="ghost" onPress={() => router.replace('/(tabs)')} style={{ marginTop: Space.sm }} />
      </AuthFrame>
    )
  }

  return (
    <AuthFrame
      title="A little about you"
      subtitle="Your date of birth lets us tailor advice — some pieces are only meant for certain ages."
    >
      <Field
        label="Your name" value={name} onChangeText={setName}
        placeholder="Priya Sharma" autoCapitalize="words" autoComplete="name"
      />
      <View style={{ marginTop: Space.base, gap: 6 }}>
        <Text style={Typography.fieldLabel}>Date of birth</Text>
        <DateOfBirthField value={dob} onChange={setDob} />
      </View>

      {error && <Notice tone="error" text={error} style={{ marginTop: Space.base }} />}

      <PillButton label="Continue" onPress={saveDetails} loading={saving} style={{ marginTop: Space.xl }} />
    </AuthFrame>
  )
}

const s = StyleSheet.create({
  gift: {
    flexDirection: 'row', alignItems: 'center', gap: Space.base, marginTop: Space.lg,
    padding: Space.lg, borderRadius: Radius.lg, backgroundColor: Colors.bgDark,
  },
  giftNum:   { ...Typography.numeral, fontSize: 56, lineHeight: 60, color: Colors.primaryLight },
  giftTitle: { ...Typography.h3, color: Colors.textOnDark },
  giftBody:  { ...Typography.bodySmall, color: Colors.textOnDarkMuted },
})
