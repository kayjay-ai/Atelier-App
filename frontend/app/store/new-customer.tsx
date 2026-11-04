import { useCallback, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Image, StyleSheet, ActivityIndicator,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { useAccountStore } from '../../lib/account'
import { createFolder, saveFolderPhoto, useStoreSession, FOLDER_LIFETIME_DAYS } from '../../lib/b2b'
import { pickImageDataUri } from '../../lib/imageInput'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, PillButton } from '../../lib/ui'
import {
  MeasurementsFields, emptyMeasurementValues, parseMeasurements, type MeasurementValues,
} from '../../components/store/MeasurementsFields'
import type { CustomerFolder } from '../../lib/types'

// Spec §2.3–2.4: create the walk-in customer's folder (name + consent, optional
// measurements), then photograph them. The photo becomes their try-on photo.

const FRAMING_TIPS = [
  'Head to feet in the frame',
  'Arms slightly away from the body',
  'Plain background, good light',
]

export default function NewCustomerScreen() {
  const account = useAccountStore((st) => st.account)
  const setCustomerId = useStoreSession((st) => st.setCustomerId)

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [consent, setConsent] = useState(false)
  const [meas, setMeas] = useState<MeasurementValues>(emptyMeasurementValues())
  const [folder, setFolder] = useState<CustomerFolder | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Hidden tab screens stay mounted — start fresh every time the screen is left.
  useFocusEffect(useCallback(() => () => {
    setName(''); setPhone(''); setConsent(false); setMeas(emptyMeasurementValues())
    setFolder(null); setPhoto(null); setBusy(false); setError(null)
  }, []))

  if (account?.type !== 'b2b_company') return null
  const clientId = account.client.id

  async function create() {
    setError(null)
    if (!name.trim()) { setError('Enter the customer’s name.'); return }
    if (!consent) { setError('The customer must agree before their photo is taken.'); return }
    const parsed = parseMeasurements(meas)
    if (parsed.error !== undefined) { setError(parsed.error); return }
    setBusy(true)
    try {
      const created = await createFolder(clientId, {
        customerName: name, phone, measurements: parsed.measurements,
      })
      setFolder(created)
      setCustomerId(created.id)
    } catch (e: any) {
      setError(`Couldn't create the folder — ${e?.message ?? 'please try again'}.`)
    } finally {
      setBusy(false)
    }
  }

  async function capture(source: 'camera' | 'library') {
    setError(null)
    try {
      const uri = await pickImageDataUri(source, { quality: 0.8 })
      if (uri) setPhoto(uri)
    } catch (e: any) {
      setError(e?.message ?? 'Could not open the camera.')
    }
  }

  async function savePhoto() {
    if (!folder || !photo) return
    setBusy(true)
    setError(null)
    try {
      await saveFolderPhoto(clientId, folder.id, photo)
      router.replace('/store')
    } catch (e: any) {
      setError(`Couldn't save the photo — ${e?.message ?? 'please try again'}.`)
    } finally {
      setBusy(false)
    }
  }

  // ── Step 2: photograph the customer ──
  if (folder) {
    return (
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.eyebrow}>STEP 2 OF 2</Text>
        <Text style={s.title}>Photograph {folder.customerName}</Text>

        {photo ? (
          <View style={s.previewWrap}>
            <Image source={{ uri: photo }} style={s.preview} resizeMode="contain" />
          </View>
        ) : (
          <View style={s.guide}>
            <Icon name="profile" size={64} color={Colors.primaryLight} />
            {FRAMING_TIPS.map((t) => (
              <Text key={t} style={s.tip}>✓  {t}</Text>
            ))}
          </View>
        )}

        {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

        {photo ? (
          <View style={s.row}>
            <PillButton variant="outline" label="Retake" icon="refresh" onPress={() => setPhoto(null)} style={{ flex: 1 }} disabled={busy} />
            <PillButton variant="secondary" label="Save photo" icon="check" onPress={savePhoto} loading={busy} style={{ flex: 1 }} />
          </View>
        ) : (
          <View style={s.row}>
            <PillButton variant="secondary" label="Take photo" icon="takePhoto" onPress={() => capture('camera')} style={{ flex: 1 }} />
            <PillButton variant="outline" label="From gallery" icon="gallery" onPress={() => capture('library')} style={{ flex: 1 }} />
          </View>
        )}

        <TouchableOpacity style={s.skip} onPress={() => router.replace('/store')} disabled={busy}>
          <Text style={s.skipText}>Skip — add the photo later from the folder</Text>
        </TouchableOpacity>
      </ScrollView>
    )
  }

  // ── Step 1: folder details ──
  return (
    <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <TouchableOpacity style={s.back} onPress={() => router.navigate('/store')}>
        <Icon name="back" size={18} color={Colors.textMuted} />
        <Text style={s.backText}>Home</Text>
      </TouchableOpacity>
      <Text style={s.eyebrow}>STEP 1 OF 2</Text>
      <Text style={s.title}>New customer</Text>

      <Text style={s.label}>CUSTOMER NAME *</Text>
      <TextInput
        style={s.input}
        value={name}
        onChangeText={setName}
        placeholder="e.g. Priya Sharma"
        placeholderTextColor={Colors.textFaint}
        autoCapitalize="words"
      />

      <Text style={s.label}>PHONE (OPTIONAL — FOR SHARING PHOTOS)</Text>
      <TextInput
        style={s.input}
        value={phone}
        onChangeText={setPhone}
        placeholder="+91 98765 43210"
        placeholderTextColor={Colors.textFaint}
        keyboardType="phone-pad"
      />

      <TouchableOpacity
        style={s.consentRow}
        onPress={() => setConsent((c) => !c)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent }}
      >
        <View style={[s.checkbox, consent && s.checkboxOn]}>
          {consent && <Icon name="check" size={16} color={Colors.textOnDark} />}
        </View>
        <Text style={s.consentText}>
          Customer agrees to have their photo taken and stored for {FOLDER_LIFETIME_DAYS} days. *
        </Text>
      </TouchableOpacity>

      <Text style={[s.label, { marginTop: Space.lg }]}>MEASUREMENTS (OPTIONAL — NEEDED FOR SIZE ASSIST)</Text>
      <MeasurementsFields value={meas} onChange={setMeas} />

      {error && <View style={s.errorBox}><Text style={s.errorText}>{error}</Text></View>}

      <PillButton
        variant="secondary"
        label="Create folder"
        icon="newCustomer"
        onPress={create}
        loading={busy}
        style={{ marginTop: Space.lg }}
      />
      {busy && <ActivityIndicator style={{ marginTop: Space.sm }} color={Colors.primary} />}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  scroll: { padding: Space.lg, paddingBottom: Space.xxl, gap: Space.sm, maxWidth: 720, width: '100%', alignSelf: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, marginBottom: Space.sm },
  backText: { ...Typography.bodySmall, color: Colors.textMuted },
  eyebrow: { ...Typography.label, color: Colors.primary },
  title: { ...Typography.h1, marginBottom: Space.md },
  label: { ...Typography.label, marginTop: Space.md },
  input: {
    backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.base, paddingVertical: 13, ...Typography.body, color: Colors.text,
  },
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginTop: Space.lg },
  checkbox: {
    width: 26, height: 26, borderRadius: 6, borderWidth: 2, borderColor: Colors.secondary,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: Colors.secondary },
  consentText: { ...Typography.body, flex: 1 },
  errorBox: { backgroundColor: Colors.errorBg, borderRadius: Radius.sm, padding: Space.md, marginTop: Space.md },
  errorText: { ...Typography.bodySmall, color: Colors.error },
  guide: {
    alignItems: 'center', gap: Space.sm, paddingVertical: Space.xl,
    borderWidth: 2, borderStyle: 'dashed', borderColor: Colors.primaryLight, borderRadius: Radius.xl,
    marginBottom: Space.md,
  },
  tip: { ...Typography.body, color: Colors.textMuted },
  previewWrap: { backgroundColor: Colors.bgSubtle, borderRadius: Radius.xl, overflow: 'hidden', marginBottom: Space.md },
  preview: { width: '100%', aspectRatio: 3 / 4 },
  row: { flexDirection: 'row', gap: Space.md },
  skip: { alignItems: 'center', paddingVertical: Space.lg },
  skipText: { ...Typography.caption, color: Colors.textFaint },
})
