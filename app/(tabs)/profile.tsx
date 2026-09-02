import { useState, useEffect, useRef } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, ScrollView, Image, Alert, Platform, Animated, ActivityIndicator,
} from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as FileSystem from 'expo-file-system/legacy'
import { useRouter } from 'expo-router'
import {
  useProfileStore, useMembershipStore, useGarmentStore, useCreditsStore,
} from '../../lib/store'
import { supabase } from '../../lib/supabaseClient'
import {
  fetchProfile, upsertProfile, uploadUserPhoto, downloadUserPhoto,
} from '../../lib/supabaseStorage'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon } from '../../lib/ui'
import type { Measurements } from '../../lib/types'

export default function ProfileScreen() {
  const profile    = useProfileStore()
  const membership = useMembershipStore()
  const garment    = useGarmentStore()
  const credits    = useCreditsStore()
  const router     = useRouter()
  const [session, setSession] = useState<any>(null)
  const [sessionChecked, setSessionChecked] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionChecked(true)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_OUT') {
        // Explicit sign-out — clear profile data and show guest view
        profile.reset()
        profile.setOwner(null)
      }
    })
    return () => subscription.unsubscribe()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const userId = session?.user?.id
    if (!userId) {
      profile.reset()
      profile.setOwner(null)
      garment.clear()
      membership.setMembership(null)
      return
    }
    if (useProfileStore.getState().ownerId !== userId) {
      profile.reset()
      garment.clear()
      profile.setOwner(userId)
    }
    membership.refresh().then((m) => {
      credits.syncFromMembership(m)
    })
    async function loadFromCloud() {
      const remote = await fetchProfile(userId)
      if (!remote) return
      if (remote.measurements) profile.setMeasurements(remote.measurements)
      if (remote.colorAnalysis) profile.setColorAnalysis(remote.colorAnalysis)
      if (remote.photoPath && !useProfileStore.getState().photoUri) {
        const photoUri = await downloadUserPhoto(remote.photoPath)
        if (photoUri) profile.setPhotoUri(photoUri)
      }
    }
    loadFromCloud()
  }, [session?.user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Waiting for session check
  if (!sessionChecked) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.loadingWrap}><ActivityIndicator color={Colors.primary} /></View>
      </SafeAreaView>
    )
  }

  // Session exists but profile store not yet rehydrated — brief flicker
  if (session && profile.ownerId !== session?.user?.id) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.loadingWrap}><Text style={s.hint}>Loading your profile…</Text></View>
      </SafeAreaView>
    )
  }

  // Guest mode — no session, show local-only profile
  if (!session) {
    return (
      <SafeAreaView style={s.safe}>
        <ScrollView contentContainerStyle={s.scroll}>
          <View style={s.guestBanner}>
            <Text style={s.guestTitle}>Your profile</Text>
            <Text style={s.guestHint}>
              Add your photo and measurements below — they're used for virtual try-on and size recommendations.
              Sign in to save them to the cloud and access them on any device.
            </Text>
            <TouchableOpacity style={s.signInPromptBtn} onPress={() => router.push('/auth')}>
              <Text style={s.signInPromptText}>Sign in or create account</Text>
            </TouchableOpacity>
          </View>
          <PhotoSection userId={null} userEmail="" />
          <MeasurementsSection userId={null} userEmail="" />
        </ScrollView>
      </SafeAreaView>
    )
  }

  const userId: string = session.user.id
  const userEmail: string = session.user.email ?? ''

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll}>

        <CreditsBar />
        <MembershipSection />
        <PhotoSection key={`photo-${userId}`} userId={userId} userEmail={userEmail} />
        <MeasurementsSection key={`meas-${userId}`} userId={userId} userEmail={userEmail} />

        <TouchableOpacity style={s.signOutBtn} onPress={() => supabase.auth.signOut()}>
          <Text style={s.signOutText}>Sign out</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  )
}

function CreditsBar() {
  const credits = useCreditsStore()
  const { membership } = useMembershipStore()
  const isPremium = membership?.isPremium || membership?.plan === 'premium'
  const balance = credits.remaining()

  return (
    <View style={s.creditsBox}>
      <View style={s.creditsLabelRow}>
        <Text style={s.creditsLabel}>CREDITS</Text>
        <Text style={s.creditsCount}>{isPremium ? 'Unlimited' : `${balance} left`}</Text>
      </View>
      <Text style={s.creditsHint}>
        {isPremium ? 'Premium — unlimited generations.' : '1 credit = 1 generation. Credits stack and don’t expire.'}
      </Text>
    </View>
  )
}

function MembershipSection() {
  const router = useRouter()
  const credits = useCreditsStore()
  const { membership } = useMembershipStore()
  const isPremium = membership?.isPremium || membership?.plan === 'premium'
  const balance = credits.remaining()

  if (isPremium) {
    return (
      <View style={s.section}>
        <Text style={s.sectionLabel}>MEMBERSHIP</Text>
        <View style={[s.memberCard, s.memberCardPremium]}>
          <View style={s.memberRow}>
            <Text style={[s.memberPlan, s.memberPlanPremium]}>Atelier Premium</Text>
            <View style={s.premiumBadge}><Text style={s.premiumBadgeText}>PREMIUM</Text></View>
          </View>
          <Text style={[s.memberHint, { color: 'rgba(250,248,245,0.6)' }]}>
            Unlimited generations and watermark-free downloads.
          </Text>
        </View>
      </View>
    )
  }

  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>CREDITS</Text>
      <View style={s.memberCard}>
        <View style={s.memberRow}>
          <Text style={s.memberPlan}>{balance} credit{balance === 1 ? '' : 's'} remaining</Text>
        </View>
        <Text style={s.memberHint}>Buy more anytime — ₹15 per generation, or a credit pack.</Text>
        <TouchableOpacity style={s.upgradeBtn} onPress={() => router.push('/premium')}>
          <Icon name="star" size={18} color={Colors.textOnDark} />
          <Text style={s.upgradeBtnText}>Buy credits</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function PhotoSection({ userId, userEmail }: { userId: string | null; userEmail: string }) {
  const profile = useProfileStore()
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoSaving, setPhotoSaving] = useState(false)

  async function pickPhoto() {
    if (Platform.OS !== 'web') {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!perm.granted) { Alert.alert('Permission needed', 'Allow photo library access.'); return }
    }
    const picked = await ImagePicker.launchImageLibraryAsync({ quality: 0.85 })
    if (picked.canceled || !picked.assets[0]) return
    const uri = picked.assets[0].uri

    let dataUri: string
    if (Platform.OS === 'web') {
      const res = await fetch(uri)
      const blob = await res.blob()
      dataUri = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      })
    } else {
      const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 })
      dataUri = `data:image/jpeg;base64,${raw}`
    }
    profile.setPhotoUri(dataUri)
    if (!userId) return // guest — no cloud account to save to

    // Cloud-only: upload to Storage, save its path on the profile. Surface failures.
    setPhotoSaving(true)
    setPhotoError(null)
    try {
      const photoPath = await uploadUserPhoto(userId, dataUri)
      if (!photoPath) throw new Error('Storage upload was rejected (check the Storage RLS policy for user-photos).')
      await upsertProfile(userId, userEmail, { photoPath })
    } catch (e: any) {
      console.error('[Atelier] Profile photo save failed:', e)
      setPhotoError("Couldn't save your photo to the cloud. Tap the photo to try again.")
    } finally {
      setPhotoSaving(false)
    }
  }

  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>YOUR PHOTO</Text>
      <Text style={s.hint}>Used for virtual try-on and colour analysis.</Text>
      <TouchableOpacity style={s.photoBox} onPress={pickPhoto}>
        {profile.photoUri ? (
          <Image source={{ uri: profile.photoUri }} style={s.photoImg} resizeMode="cover" />
        ) : (
          <View style={s.photoPlaceholder}>
            <Icon name="upload" size={28} color={Colors.textMuted} />
            <Text style={s.photoHint}>Tap to add</Text>
          </View>
        )}
      </TouchableOpacity>
      {photoSaving && <Text style={[s.hint, { marginTop: Space.sm }]}>Saving to cloud…</Text>}
      {photoError && (
        <View style={s.photoErrorBox}>
          <Text style={s.photoErrorText}>{photoError}</Text>
        </View>
      )}
    </View>
  )
}

function MeasurementsSection({ userId, userEmail }: { userId: string | null; userEmail: string }) {
  const profile  = useProfileStore()
  const router   = useRouter()
  const saved    = profile.measurements
  const [editing, setEditing] = useState(!saved)
  const [showSuccess, setShowSuccess] = useState(false)
  const successScale = useRef(new Animated.Value(0)).current
  const successOpacity = useRef(new Animated.Value(0)).current

  const [form, setForm] = useState<Record<string, string>>({
    heightCm: String(saved?.heightCm ?? ''),
    chestIn:  String(saved?.chestIn  ?? ''),
    waistIn:  String(saved?.waistIn  ?? ''),
    hipIn:    String(saved?.hipIn    ?? ''),
    fitPreference: saved?.fitPreference ?? 'true-to-size',
  })

  // Measurements load from the cloud asynchronously after this section mounts.
  // Re-sync the form + drop out of edit mode once they arrive, otherwise the
  // user is left looking at an empty edit form instead of their saved values.
  useEffect(() => {
    if (!saved) return
    setForm({
      heightCm: String(saved.heightCm ?? ''),
      chestIn:  String(saved.chestIn  ?? ''),
      waistIn:  String(saved.waistIn  ?? ''),
      hipIn:    String(saved.hipIn    ?? ''),
      fitPreference: saved.fitPreference ?? 'true-to-size',
    })
    setEditing(false)
  }, [saved])

  const fields: { key: string; label: string; unit: string }[] = [
    { key: 'heightCm', label: 'Height', unit: 'cm' },
    { key: 'chestIn',  label: 'Chest',  unit: 'in' },
    { key: 'waistIn',  label: 'Waist',  unit: 'in' },
    { key: 'hipIn',    label: 'Hip',    unit: 'in' },
  ]

  function save() {
    const m: Measurements = {
      heightCm: parseFloat(form.heightCm),
      chestIn:  parseFloat(form.chestIn),
      waistIn:  parseFloat(form.waistIn),
      hipIn:    parseFloat(form.hipIn),
      fitPreference: form.fitPreference as Measurements['fitPreference'],
    }
    const nums = [m.heightCm, m.chestIn, m.waistIn, m.hipIn]
    if (nums.some((v) => isNaN(v))) {
      Alert.alert('Incomplete', 'Fill in all measurements before saving.')
      return
    }
    profile.setMeasurements(m)
    setEditing(false)
    if (userId) {
      upsertProfile(userId, userEmail, { measurements: m }).catch(() => {})
    }

    // Longer, prominent success animation at the top, then redirect home
    setShowSuccess(true)
    Animated.parallel([
      Animated.spring(successScale, { toValue: 1, useNativeDriver: false, friction: 5, tension: 60 }),
      Animated.timing(successOpacity, { toValue: 1, duration: 350, useNativeDriver: false }),
    ]).start()
    setTimeout(() => {
      Animated.timing(successOpacity, { toValue: 0, duration: 500, useNativeDriver: false }).start(() => {
        setShowSuccess(false)
        successScale.setValue(0)
        router.replace('/(tabs)')
      })
    }, 1800)
  }

  return (
    <View style={s.section}>
      <View style={s.sectionRow}>
        <Text style={s.sectionLabel}>MEASUREMENTS</Text>
        {!editing && (
          <TouchableOpacity onPress={() => setEditing(true)}>
            <Text style={s.editLink}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      {editing ? (
        <>
          {fields.map(({ key, label, unit }) => (
            <View key={key} style={s.fieldRow}>
              <Text style={s.fieldLabel}>{label}</Text>
              <View style={s.fieldInputWrap}>
                <TextInput
                  style={s.input}
                  value={form[key]}
                  onChangeText={(v) => setForm({ ...form, [key]: v })}
                  keyboardType="numeric"
                  placeholder="0"
                  placeholderTextColor={Colors.textFaint}
                />
                <Text style={s.unit}>{unit}</Text>
              </View>
            </View>
          ))}

          <Text style={[s.fieldLabel, { marginTop: Space.md }]}>Fit preference</Text>
          <View style={s.fitRow}>
            {(['snug', 'true-to-size', 'relaxed'] as Measurements['fitPreference'][]).map((f) => (
              <TouchableOpacity
                key={f}
                style={[s.fitChip, form.fitPreference === f && s.fitChipActive]}
                onPress={() => setForm({ ...form, fitPreference: f })}
              >
                <Text style={[s.fitChipText, form.fitPreference === f && s.fitChipTextActive]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={s.saveBtnRow}>
            <TouchableOpacity style={s.saveBtn} onPress={save}>
              <Text style={s.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : saved ? (
        <View style={s.savedGrid}>
          {fields.map(({ key, label, unit }) => (
            <View key={key} style={s.savedItem}>
              <Text style={s.savedValue}>{saved[key as keyof Measurements]}{unit}</Text>
              <Text style={s.savedLabel}>{label}</Text>
            </View>
          ))}
          <View style={s.savedItem}>
            <Text style={s.savedValue}>{saved.fitPreference}</Text>
            <Text style={s.savedLabel}>Fit</Text>
          </View>
        </View>
      ) : (
        <Text style={s.hint}>No measurements saved yet. Tap Edit to add them.</Text>
      )}

      {showSuccess && (
        <Animated.View style={[s.successBanner, { opacity: successOpacity, transform: [{ scale: successScale }] }]}>
          <Icon name="check" size={26} color={Colors.success} />
          <View>
            <Text style={s.successTitle}>Measurements saved</Text>
            <Text style={s.successHint}>Taking you home…</Text>
          </View>
        </Animated.View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: Colors.bg },
  scroll:     { padding: Space.base, paddingBottom: Space.xxl },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header:  { marginBottom: Space.lg },
  logoSub: { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 9 },
  logo:    { ...Typography.h2, letterSpacing: 5, marginTop: -2 },

  // Credits bar
  creditsBox: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Space.base, marginBottom: Space.md, gap: Space.xs,
  },
  creditsLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  creditsLabel:    { ...Typography.label, letterSpacing: 1 },
  creditsCount:    { ...Typography.bodySmall, color: Colors.primary, fontWeight: '600' },
  barBg:  { height: 6, backgroundColor: Colors.bgSubtle, borderRadius: Radius.full, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: Colors.primary, borderRadius: Radius.full },
  creditsHint: { ...Typography.caption, color: Colors.textFaint },

  section:    { marginBottom: Space.lg },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Space.sm },
  sectionLabel: { ...Typography.label, letterSpacing: 1, color: Colors.textMuted, marginBottom: Space.sm },
  hint:       { ...Typography.bodySmall, color: Colors.textMuted, marginBottom: Space.md },
  editLink:   { ...Typography.bodySmall, color: Colors.secondaryLight },

  // Membership card
  memberCard:        { backgroundColor: Colors.bgCard, borderRadius: Radius.md, padding: Space.base, borderWidth: 1, borderColor: Colors.border, gap: Space.sm },
  memberCardPremium: { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  memberRow:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  memberPlan:        { ...Typography.h3, fontSize: 18 },
  memberPlanPremium: { color: Colors.textOnDark },
  memberHint:        { ...Typography.bodySmall, color: Colors.textMuted },
  premiumBadge:      { backgroundColor: Colors.primary, borderRadius: Radius.full, paddingHorizontal: Space.md, paddingVertical: 3 },
  premiumBadgeText:  { ...Typography.label, color: Colors.textOnPrimary, letterSpacing: 1 },
  upgradeBtn:        { flexDirection: 'row', gap: Space.xs, backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 13, alignItems: 'center', justifyContent: 'center', marginTop: Space.xs },
  upgradeBtnText:    { ...Typography.bodySmall, color: Colors.textOnDark, fontWeight: '600' },

  // Photo
  photoBox: {
    width: 120, height: 150, borderRadius: Radius.md,
    overflow: 'hidden', backgroundColor: Colors.bgSubtle,
    borderWidth: 1, borderColor: Colors.border,
  },
  photoImg:         { width: '100%', height: '100%' },
  photoPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.xs },
  photoIcon:        { fontSize: 28, color: Colors.textMuted },
  photoHint:        { ...Typography.caption, color: Colors.textMuted },
  photoErrorBox:    { marginTop: Space.sm, backgroundColor: Colors.errorBg, borderRadius: Radius.sm, borderWidth: 1, borderColor: '#F3C9C2', padding: Space.sm },
  photoErrorText:   { ...Typography.caption, color: Colors.error, lineHeight: 16 },

  // Measurements form
  fieldRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Space.md },
  fieldLabel:     { ...Typography.bodySmall, color: Colors.text, flex: 1 },
  fieldInputWrap: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  input: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.sm,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.md, paddingVertical: 8,
    ...Typography.body, color: Colors.text, width: 80, textAlign: 'right',
  },
  unit: { ...Typography.caption, color: Colors.textMuted, width: 24 },

  fitRow: { flexDirection: 'row', gap: Space.sm, marginTop: Space.xs, marginBottom: Space.base, flexWrap: 'wrap' },
  fitChip: {
    paddingHorizontal: Space.md, paddingVertical: 7, borderRadius: Radius.full,
    backgroundColor: Colors.bgSubtle, borderWidth: 1, borderColor: Colors.border,
  },
  fitChipActive:     { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  fitChipText:       { ...Typography.caption, color: Colors.textMuted },
  fitChipTextActive: { color: Colors.textOnDark },

  saveBtnRow:  { marginTop: Space.xl, paddingTop: Space.lg, borderTopWidth: 1, borderTopColor: Colors.border },
  saveBtn:     { backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 16, alignItems: 'center' },
  saveBtnText: { ...Typography.body, color: Colors.textOnDark, fontWeight: '600' as const, letterSpacing: 0.5 },

  // Saved display
  savedGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md, marginTop: Space.xs },
  savedItem:  { alignItems: 'center', minWidth: 60 },
  savedValue: { ...Typography.h3, fontSize: 17 },
  savedLabel: { ...Typography.label, marginTop: 2, color: Colors.textFaint },

  // Success banner — prominent, at top of section
  successBanner: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md,
    backgroundColor: Colors.successBg, borderRadius: Radius.md,
    borderWidth: 1, borderColor: '#A8D5BA',
    paddingVertical: Space.md, paddingHorizontal: Space.base,
    marginTop: Space.md,
  },
  successIcon:  { fontSize: 26, color: Colors.success },
  successTitle: { ...Typography.body, color: Colors.success, fontWeight: '600' },
  successHint:  { ...Typography.caption, color: Colors.success, opacity: 0.75, marginTop: 2 },

  signOutBtn: {
    borderWidth: 1.5, borderColor: Colors.secondary, borderRadius: Radius.full,
    paddingVertical: 14, alignItems: 'center', marginTop: Space.md,
  },
  signOutText: { ...Typography.bodySmall, color: Colors.textMuted },

  // Guest mode
  guestBanner: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Space.base, marginBottom: Space.lg, gap: Space.sm,
  },
  guestTitle:        { ...Typography.h3 },
  guestHint:         { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 20 },
  signInPromptBtn:   { backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 13, alignItems: 'center', marginTop: Space.xs },
  signInPromptText:  { ...Typography.bodySmall, color: Colors.textOnDark, fontWeight: '600' as const },
})
