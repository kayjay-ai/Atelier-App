import { useCallback, useState } from 'react'
import { View, Text, Image, StyleSheet } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { useAccountStore } from '../../lib/account'
import { createFolder, saveFolderPhoto, useStoreSession, FOLDER_LIFETIME_DAYS } from '../../lib/b2b'
import { pickImageDataUri } from '../../lib/imageInput'
import { Colors, Typography, Space, Radius, Weight } from '../../lib/theme'
import { Card, Checkbox, Field, Icon, Notice, Page, PageHeader, PillButton } from '../../lib/ui'
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

const PHONE_HINT = 'Enter a 10-digit phone number, or leave the phone empty.'

/** A database error from saving a folder, as a sentence for the store staff. */
function folderErrorMessage(e: any): string {
  const msg = String(e?.message ?? '')
  if (msg.includes('invalid_phone')) return PHONE_HINT
  if (msg.includes('invalid_name')) return 'Enter the customer’s name.'
  if (e?.code === '23505') return 'This customer already has a folder with this phone number. Open it from Customers.'
  return `Couldn't create the folder — ${msg || 'please try again'}.`
}

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
    const phoneDigits = phone.replace(/\D/g, '')
    if (phoneDigits && phoneDigits.length < 10) { setError(PHONE_HINT); return }
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
      setError(folderErrorMessage(e))
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

  const stepper = (step: 1 | 2) => (
    <View style={s.stepper} accessibilityLabel={`Step ${step} of 2`}>
      {(['Their details', 'Their photo'] as const).map((label, i) => (
        <View key={label} style={s.stepItem}>
          <View style={[s.stepBar, i < step && s.stepBarOn]} />
          <Text style={[s.stepLabel, i + 1 === step && s.stepLabelOn]}>{`${i + 1}. ${label}`}</Text>
        </View>
      ))}
    </View>
  )

  // ── Step 2: photograph the customer ──
  if (folder) {
    return (
      <Page width="reading">
        {stepper(2)}
        <PageHeader title={`Photograph ${folder.customerName}`} subtitle="This photo is used for every try-on in their folder." />

        {photo ? (
          <View style={s.previewWrap}>
            <Image source={{ uri: photo }} style={s.preview} resizeMode="contain" accessibilityLabel={`Photo of ${folder.customerName}`} />
          </View>
        ) : (
          <View style={s.guide}>
            <View style={s.guideIcon}><Icon name="takePhoto" size={30} color={Colors.secondary} /></View>
            {FRAMING_TIPS.map((t) => (
              <View key={t} style={s.tipRow}>
                <Icon name="check" size={16} color={Colors.primaryDark} />
                <Text style={s.tip}>{t}</Text>
              </View>
            ))}
          </View>
        )}

        {error && <Notice tone="error" text={error} />}

        {photo ? (
          <View style={s.row}>
            <PillButton variant="outline" label="Retake" icon="refresh" onPress={() => setPhoto(null)} style={s.flex} disabled={busy} />
            <PillButton label="Save photo" icon="check" onPress={savePhoto} loading={busy} style={s.flex} />
          </View>
        ) : (
          <View style={s.row}>
            <PillButton label="Take photo" icon="takePhoto" onPress={() => capture('camera')} style={s.flex} />
            <PillButton variant="outline" label="From gallery" icon="gallery" onPress={() => capture('library')} style={s.flex} />
          </View>
        )}

        <PillButton variant="ghost" size="sm" label="Skip — add the photo later from the folder" onPress={() => router.replace('/store')} disabled={busy} style={{ alignSelf: 'center' }} />
      </Page>
    )
  }

  // ── Step 1: folder details ──
  return (
    <Page width="reading">
      {stepper(1)}
      <PageHeader title="New Customer" back={{ label: 'Home', onPress: () => router.navigate('/store') }}
        subtitle="Their folder keeps their photo and every try-on for 15 days." />

      <Card>
        <Field
          label="Customer name" value={name} onChangeText={setName}
          placeholder="e.g. Priya Sharma" autoCapitalize="words" containerStyle={{ marginTop: 0 }}
        />
        <Field
          label="Phone" optional hint="To send them their photos."
          value={phone} onChangeText={setPhone} placeholder="+91 98765 43210" keyboardType="phone-pad"
          containerStyle={{ marginTop: 0 }}
        />
        <View style={s.consent}>
          <Checkbox
            checked={consent} onChange={setConsent}
            label={`The customer agrees to have their photo taken and kept for ${FOLDER_LIFETIME_DAYS} days.`}
            hint="Required before you take their photo."
          />
        </View>
      </Card>

      <Card>
        <View style={{ gap: Space.xs }}>
          <Text style={s.cardTitle}>Measurements <Text style={s.optional}>Optional</Text></Text>
          <Text style={s.muted}>Needed for Size Assist. You can add them later from the folder.</Text>
        </View>
        <MeasurementsFields value={meas} onChange={setMeas} />
      </Card>

      {error && <Notice tone="error" text={error} />}

      <PillButton label="Create folder" icon="newCustomer" onPress={create} loading={busy} />
    </Page>
  )
}

const s = StyleSheet.create({
  stepper: { flexDirection: 'row', gap: Space.sm },
  stepItem: { flex: 1, gap: Space.sm },
  stepBar: { height: 4, borderRadius: 2, backgroundColor: Colors.border },
  stepBarOn: { backgroundColor: Colors.secondary },
  stepLabel: { ...Typography.caption },
  stepLabelOn: { ...Weight.semibold, color: Colors.text },

  cardTitle: { ...Typography.h3 },
  optional: { ...Typography.caption, ...Weight.regular },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  consent: { paddingTop: Space.xs },

  guide: {
    alignItems: 'flex-start', gap: Space.md, padding: Space.xl, alignSelf: 'stretch',
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: Colors.primary, borderRadius: Radius.xl,
    backgroundColor: Colors.primarySubtle,
  },
  guideIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.bgCard, alignItems: 'center', justifyContent: 'center', marginBottom: Space.xs },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  tip: { ...Typography.body },
  previewWrap: { backgroundColor: Colors.bgSubtle, borderRadius: Radius.xl, overflow: 'hidden' },
  preview: { width: '100%', aspectRatio: 3 / 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  flex: { flexGrow: 1, flexBasis: 180 },
})
