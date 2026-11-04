import { useState, useEffect } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Switch,
  SafeAreaView, ScrollView, Image, ActivityIndicator,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useProfileStore, useMembershipStore, isPremium, creditsLeft } from '../../lib/store'
import { supabase } from '../../lib/supabaseClient'
import { upsertProfile, uploadUserPhoto } from '../../lib/supabaseStorage'
import { postEvent, deleteAccount } from '../../lib/api'
import { pickImageDataUri } from '../../lib/imageInput'
import { FREE_CREDITS } from '../../lib/pricing'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, PillButton } from '../../lib/ui'
import { FIT_LABELS, type Measurements } from '../../lib/types'
import { DateOfBirthField, parseDob, dobFromIso, type DobValue } from '../../components/DateOfBirthField'

// Profile tab (spec §3.2): Your photo · Your size · Fit preference · Account,
// with a completeness bar. Guests can fill photo / size / fit for this session.

type Session = { id: string; email: string } | null

const FRAMING_TIPS = [
  'Head to feet in the frame',
  'Arms slightly away from your body',
  'Plain background, good light',
  'Fitted clothes show your shape best',
]

export default function ProfileScreen() {
  const profile = useProfileStore()
  const router = useRouter()
  const [session, setSession] = useState<Session>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const apply = (u: any) => setSession(u ? { id: u.id, email: u.email ?? '' } : null)
    supabase.auth.getSession().then(({ data }) => { apply(data.session?.user); setChecked(true) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => apply(s?.user))
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session) profile.hydrate(session.id).catch(() => {})
  }, [session?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!checked || (session && (!profile.loaded || profile.ownerId !== session.id))) {
    return <SafeAreaView style={s.safe}><View style={s.center}><ActivityIndicator color={Colors.primary} /></View></SafeAreaView>
  }

  const done = [!!profile.photoUri, !!profile.measurements, !!profile.measurements?.fitChosen]
  const doneCount = done.filter(Boolean).length

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.column}>
          {!session && (
            <View style={s.card}>
              <Text style={s.cardTitle}>Your profile</Text>
              <Text style={s.muted}>
                Add your photo, size and fit below — they're used for try-on and size advice. Sign in to keep them on every device.
              </Text>
              <PillButton label="Sign in or create account" onPress={() => router.push('/auth')} />
            </View>
          )}

          <View style={s.progressCard}>
            <View style={s.rowBetween}>
              <Text style={s.cardTitle}>Profile {doneCount} of 3 done</Text>
              {doneCount === 3 && <Icon name="check" size={20} color={Colors.success} />}
            </View>
            <View style={s.bar}><View style={[s.barFill, { width: `${(doneCount / 3) * 100}%` }]} /></View>
            {doneCount < 3 && (
              <Text style={s.muted}>
                {!done[0] ? 'Add your photo to try things on.' : !done[1] ? 'Add your size to get size advice.' : 'Pick your fit preference.'}
              </Text>
            )}
          </View>

          <PhotoSection session={session} />
          <SizeSection session={session} />
          <FitSection session={session} />
          {session && <AccountSection session={session} />}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

// ─── Your photo ───────────────────────────────────────────────────────────────
function PhotoSection({ session }: { session: Session }) {
  const profile = useProfileStore()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose(source: 'camera' | 'library') {
    setError(null)
    let uri: string | null = null
    try {
      uri = await pickImageDataUri(source, { quality: 0.85 })
    } catch (e: any) {
      setError(e?.message ?? 'Could not open the camera.')
      return
    }
    if (!uri) return
    profile.setPhotoUri(uri)
    if (!session) return // guest — kept for this session only
    setSaving(true)
    try {
      const path = await uploadUserPhoto(session.id, uri)
      if (!path) throw new Error('upload rejected')
      await upsertProfile(session.id, session.email, { photoPath: path })
    } catch (e) {
      console.error('[Atelier] profile photo save failed:', e)
      setError("Couldn't save your photo — try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Your photo</Text>
      <Text style={s.muted}>Used for every try-on and for your Style report.</Text>
      <View style={s.photoRow}>
        <View style={s.photoBox}>
          {profile.photoUri
            ? <Image source={{ uri: profile.photoUri }} style={s.photoImg} resizeMode="cover" />
            : <View style={s.photoEmpty}><Icon name="profile" size={34} color={Colors.textFaint} /></View>}
          {saving && <View style={s.photoSaving}><ActivityIndicator color={Colors.textOnDark} /></View>}
        </View>
        <View style={s.tips}>
          <Text style={s.label}>FOR THE BEST RESULT</Text>
          {FRAMING_TIPS.map((tip) => (
            <View key={tip} style={s.tipRow}>
              <Icon name="check" size={14} color={Colors.primary} />
              <Text style={s.tipText}>{tip}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={s.btnRow}>
        <PillButton label={profile.photoUri ? 'Retake' : 'Camera'} icon="takePhoto" onPress={() => choose('camera')} disabled={saving} style={s.flexBtn} />
        <PillButton label="Gallery" icon="gallery" variant="outline" onPress={() => choose('library')} disabled={saving} style={s.flexBtn} />
      </View>
      {error && <Text style={s.errorText}>{error}</Text>}
    </View>
  )
}

// ─── Your size ────────────────────────────────────────────────────────────────
const SIZE_FIELDS: { key: 'heightCm' | 'weightKg' | 'chestIn' | 'waistIn' | 'hipIn'; label: string; unit: string }[] = [
  { key: 'heightCm', label: 'Height', unit: 'cm' },
  { key: 'weightKg', label: 'Weight', unit: 'kg' },
  { key: 'chestIn',  label: 'Chest / bust', unit: 'in' },
  { key: 'waistIn',  label: 'Waist', unit: 'in' },
  { key: 'hipIn',    label: 'Hip', unit: 'in' },
]

function formFrom(m: Measurements | null) {
  const out: Record<string, string> = { usualSize: m?.usualSize ?? '' }
  for (const f of SIZE_FIELDS) out[f.key] = m?.[f.key] != null ? String(m[f.key]) : ''
  return out
}

async function saveMeasurements(session: Session, m: Measurements) {
  useProfileStore.getState().setMeasurements(m)
  if (session) await upsertProfile(session.id, session.email, { measurements: m })
}

function SizeSection({ session }: { session: Session }) {
  const profile = useProfileStore()
  const saved = profile.measurements
  const [editing, setEditing] = useState(!saved)
  const [form, setForm] = useState(formFrom(saved))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { setForm(formFrom(saved)); if (saved) setEditing(false) }, [saved])

  async function save() {
    setMsg(null)
    const num = (k: string) => Number(form[k].replace(',', '.'))
    const missing = SIZE_FIELDS.filter((f) => !form[f.key] || !(num(f.key) > 0))
    if (missing.length) { setMsg({ ok: false, text: `Fill in ${missing.map((f) => f.label.toLowerCase()).join(', ')}.` }); return }
    const m: Measurements = {
      heightCm: num('heightCm'), weightKg: num('weightKg'), chestIn: num('chestIn'),
      waistIn: num('waistIn'), hipIn: num('hipIn'),
      usualSize: form.usualSize.trim() || undefined,
      fitPreference: saved?.fitPreference ?? 'true-to-size',
      fitChosen: saved?.fitChosen ?? false,
    }
    setBusy(true)
    try {
      await saveMeasurements(session, m)
      if (session) postEvent('profile_completed', { metadata: { measurements: true, photo: !!profile.photoUri } })
      setEditing(false)
      setMsg({ ok: true, text: 'Saved.' })
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn't save — ${e?.message ?? 'try again'}.` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={s.card}>
      <View style={s.rowBetween}>
        <Text style={s.cardTitle}>Your size</Text>
        {!editing && saved && (
          <TouchableOpacity onPress={() => { setEditing(true); setMsg(null) }}><Text style={s.link}>Edit</Text></TouchableOpacity>
        )}
      </View>
      {editing ? (
        <>
          <View style={s.grid}>
            {SIZE_FIELDS.map(({ key, label, unit }) => (
              <View key={key} style={s.field}>
                <Text style={s.label}>{label.toUpperCase()}</Text>
                <View style={s.inputWrap}>
                  <TextInput
                    style={s.input} value={form[key]} onChangeText={(v) => setForm({ ...form, [key]: v })}
                    keyboardType="decimal-pad" placeholder="0" placeholderTextColor={Colors.textFaint}
                  />
                  <Text style={s.unit}>{unit}</Text>
                </View>
              </View>
            ))}
            <View style={s.field}>
              <Text style={s.label}>USUAL SIZE</Text>
              <TextInput
                style={[s.input, s.inputText]} value={form.usualSize} onChangeText={(v) => setForm({ ...form, usualSize: v })}
                placeholder="e.g. M / 32" placeholderTextColor={Colors.textFaint} autoCapitalize="characters"
              />
            </View>
          </View>
          <View style={s.btnRow}>
            {saved && <PillButton label="Cancel" variant="outline" onPress={() => { setEditing(false); setForm(formFrom(saved)); setMsg(null) }} style={s.flexBtn} />}
            <PillButton label="Save" onPress={save} loading={busy} style={s.flexBtn} />
          </View>
        </>
      ) : saved ? (
        <View style={s.savedGrid}>
          {SIZE_FIELDS.map(({ key, label, unit }) => (
            <View key={key} style={s.savedItem}>
              <Text style={s.savedValue}>{saved[key] != null ? `${saved[key]} ${unit}` : '—'}</Text>
              <Text style={s.savedLabel}>{label}</Text>
            </View>
          ))}
          <View style={s.savedItem}>
            <Text style={s.savedValue}>{saved.usualSize || '—'}</Text>
            <Text style={s.savedLabel}>Usual size</Text>
          </View>
        </View>
      ) : null}
      {msg && <Text style={msg.ok ? s.okText : s.errorText}>{msg.text}</Text>}
    </View>
  )
}

// ─── Fit preference ───────────────────────────────────────────────────────────
function FitSection({ session }: { session: Session }) {
  const profile = useProfileStore()
  const saved = profile.measurements
  const [choice, setChoice] = useState<Measurements['fitPreference'] | null>(saved?.fitChosen ? saved.fitPreference : null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { if (saved?.fitChosen) setChoice(saved.fitPreference) }, [saved])

  async function save() {
    if (!choice || !saved) return
    setBusy(true)
    setMsg(null)
    try {
      await saveMeasurements(session, { ...saved, fitPreference: choice, fitChosen: true })
      setMsg({ ok: true, text: 'Saved.' })
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn't save — ${e?.message ?? 'try again'}.` })
    } finally {
      setBusy(false)
    }
  }

  const unchanged = !!saved?.fitChosen && saved.fitPreference === choice
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Fit preference</Text>
      <Text style={s.muted}>How you like clothes to sit — used for every size recommendation.</Text>
      <View style={s.chips}>
        {(['snug', 'true-to-size', 'relaxed'] as const).map((f) => (
          <TouchableOpacity key={f} style={[s.chip, choice === f && s.chipOn]} onPress={() => { setChoice(f); setMsg(null) }}>
            <Text style={[s.chipText, choice === f && s.chipTextOn]}>{FIT_LABELS[f]}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {!saved
        ? <Text style={s.muted}>Save your size first, then your fit.</Text>
        : <PillButton label={unchanged ? 'Saved' : 'Save'} onPress={save} loading={busy} disabled={!choice || unchanged} />}
      {msg && !msg.ok && <Text style={s.errorText}>{msg.text}</Text>}
    </View>
  )
}

// ─── Account ──────────────────────────────────────────────────────────────────
function AccountSection({ session }: { session: NonNullable<Session> }) {
  const profile = useProfileStore()
  const router = useRouter()
  const membership = useMembershipStore((st) => st.membership)
  const premium = isPremium(membership)
  const balance = creditsLeft(membership) ?? '—' // '—' until loaded

  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(profile.name ?? '')
  const [dob, setDob] = useState<DobValue>(dobFromIso(profile.dateOfBirth))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function saveDetails() {
    setMsg(null)
    if (name.trim().length < 2) { setMsg({ ok: false, text: 'Enter your name.' }); return }
    const parsed = parseDob(dob)
    if ('error' in parsed) { setMsg({ ok: false, text: parsed.error }); return }
    setBusy(true)
    try {
      await upsertProfile(session.id, session.email, { name: name.trim(), dateOfBirth: parsed.iso })
      profile.setAccount({ name: name.trim(), dateOfBirth: parsed.iso })
      setEditing(false)
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn't save — ${e?.message ?? 'try again'}.` })
    } finally {
      setBusy(false)
    }
  }

  async function toggle(key: 'notifyEmail' | 'notifyPush', value: boolean) {
    profile.setAccount({ [key]: value })
    try {
      await upsertProfile(session.id, session.email, { [key]: value })
    } catch {
      profile.setAccount({ [key]: !value })
      setMsg({ ok: false, text: "Couldn't update notification settings." })
    }
  }

  async function removeAccount() {
    setDeleting(true)
    setMsg(null)
    try {
      await deleteAccount()
      await supabase.auth.signOut()
      router.replace('/auth')
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? 'Could not delete your account.' })
      setDeleting(false)
    }
  }

  const dobLabel = profile.dateOfBirth
    ? new Date(`${profile.dateOfBirth}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'Not set'
  const planLabel = premium ? 'Premium — unlimited' : membership?.plan ? 'Credit plan' : 'Free starter credits'

  return (
    <View style={s.card}>
      <View style={s.rowBetween}>
        <Text style={s.cardTitle}>Account</Text>
        {!editing && <TouchableOpacity onPress={() => { setEditing(true); setName(profile.name ?? ''); setDob(dobFromIso(profile.dateOfBirth)) }}><Text style={s.link}>Edit</Text></TouchableOpacity>}
      </View>

      {editing ? (
        <>
          <Text style={s.label}>NAME</Text>
          <TextInput style={[s.input, s.inputText]} value={name} onChangeText={setName} autoCapitalize="words" placeholderTextColor={Colors.textFaint} />
          <Text style={[s.label, { marginTop: Space.sm }]}>DATE OF BIRTH</Text>
          <DateOfBirthField value={dob} onChange={setDob} />
          <View style={s.btnRow}>
            <PillButton label="Cancel" variant="outline" onPress={() => { setEditing(false); setMsg(null) }} style={s.flexBtn} />
            <PillButton label="Save" onPress={saveDetails} loading={busy} style={s.flexBtn} />
          </View>
        </>
      ) : (
        <View style={s.infoList}>
          <InfoRow label="Name" value={profile.name ?? 'Not set'} />
          <InfoRow label="Email" value={session.email} />
          <InfoRow label="Date of birth" value={dobLabel} />
        </View>
      )}

      <View style={s.divider} />
      <View style={s.rowBetween}>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>PLAN & CREDITS</Text>
          <Text style={s.value}>{planLabel}</Text>
          <Text style={s.muted}>{premium ? 'No limit on try-ons.' : `${balance} credit${balance === 1 ? '' : 's'} left · new accounts get ${FREE_CREDITS} free`}</Text>
        </View>
        <TouchableOpacity style={s.manageBtn} onPress={() => router.navigate('/(tabs)/premium')}>
          <Text style={s.manageText}>Manage</Text>
        </TouchableOpacity>
      </View>

      <View style={s.divider} />
      <Text style={s.label}>NOTIFICATIONS</Text>
      <View style={s.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.value}>Email</Text>
          <Text style={s.muted}>Low-credit reminders and plan news</Text>
        </View>
        <Switch value={profile.notifyEmail} onValueChange={(v) => toggle('notifyEmail', v)}
          {...SWITCH_COLORS} />
      </View>
      <View style={s.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.value}>Push & in-app</Text>
          <Text style={s.muted}>Alerts inside Atelier</Text>
        </View>
        <Switch value={profile.notifyPush} onValueChange={(v) => toggle('notifyPush', v)}
          {...SWITCH_COLORS} />
      </View>

      {msg && <Text style={msg.ok ? s.okText : s.errorText}>{msg.text}</Text>}

      <View style={s.divider} />
      <TouchableOpacity style={s.actionRow} onPress={() => supabase.auth.signOut()}>
        <Icon name="logout" size={18} color={Colors.text} />
        <Text style={s.value}>Sign out</Text>
      </TouchableOpacity>

      {confirmDelete ? (
        <View style={s.dangerBox}>
          <Text style={s.value}>Delete your account?</Text>
          <Text style={s.muted}>Your photo, size, style report, history and remaining credits are removed permanently. This can't be undone.</Text>
          <View style={s.btnRow}>
            <PillButton label="Cancel" variant="outline" onPress={() => setConfirmDelete(false)} disabled={deleting} style={s.flexBtn} />
            <TouchableOpacity style={[s.deleteBtn, s.flexBtn, deleting && { opacity: 0.6 }]} onPress={removeAccount} disabled={deleting}>
              {deleting ? <ActivityIndicator color={Colors.textOnDark} /> : <Text style={s.deleteBtnText}>Delete account</Text>}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <TouchableOpacity style={s.actionRow} onPress={() => setConfirmDelete(true)}>
          <Icon name="trash" size={18} color={Colors.error} />
          <Text style={[s.value, { color: Colors.error }]}>Delete account</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

// Brand colours for toggles. activeThumbColor / activeTrackColor are the web
// (react-native-web) names; without them the "on" state falls back to teal.
const SWITCH_COLORS = {
  trackColor: { true: Colors.primary, false: Colors.border },
  thumbColor: Colors.bgCard,
  activeTrackColor: Colors.primary,
  activeThumbColor: Colors.secondary,
  ios_backgroundColor: Colors.border,
} as any

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.value} numberOfLines={1}>{value}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: Space.base, paddingBottom: Space.xxl },
  column: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: Space.md },

  card: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border,
    padding: Space.base, gap: Space.sm,
  },
  progressCard: { backgroundColor: Colors.primarySubtle, borderRadius: Radius.lg, padding: Space.base, gap: Space.sm },
  cardTitle: { ...Typography.h3 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.md },
  muted:  { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 20 },
  label:  { ...Typography.label, color: Colors.textFaint },
  value:  { ...Typography.body, color: Colors.text },
  link:   { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '700' },
  okText: { ...Typography.bodySmall, color: Colors.success },
  errorText: { ...Typography.bodySmall, color: Colors.error },

  bar:     { height: 8, borderRadius: Radius.full, backgroundColor: Colors.bgCard, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: Colors.secondary, borderRadius: Radius.full },

  photoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.base, marginTop: Space.xs },
  photoBox: {
    width: 120, height: 160, borderRadius: Radius.md, overflow: 'hidden',
    backgroundColor: Colors.bgSubtle, borderWidth: 1, borderColor: Colors.border,
  },
  photoImg:    { width: '100%', height: '100%' },
  photoEmpty:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  photoSaving: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  tips:    { flex: 1, minWidth: 180, gap: Space.xs },
  tipRow:  { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  tipText: { ...Typography.bodySmall, color: Colors.textMuted, flex: 1 },

  btnRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, marginTop: Space.sm },
  flexBtn: { flexGrow: 1, flexBasis: 140 },

  grid:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  // Three per row on every width (3 × 2 grid for the six fields).
  field: { flexGrow: 1, flexBasis: '30%', minWidth: 96, gap: Space.xs },
  inputWrap: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, minWidth: 0 },
  input: {
    // minWidth 0: a web <input> otherwise refuses to shrink below ~170px and overlaps its neighbours.
    flex: 1, minWidth: 0, width: '100%', backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Space.md, paddingVertical: 11, ...Typography.body, color: Colors.text, textAlign: 'right',
  },
  inputText: { textAlign: 'left' },
  unit: { ...Typography.caption, color: Colors.textMuted, width: 20 },

  savedGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.md },
  savedItem:  { flexBasis: 96, flexGrow: 1, backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, padding: Space.md, gap: 2 },
  savedValue: { ...Typography.h3, fontSize: 17 },
  savedLabel: { ...Typography.caption, color: Colors.textMuted },

  chips:      { flexDirection: 'row', gap: Space.sm, flexWrap: 'wrap', marginVertical: Space.xs },
  chip:       { flexGrow: 1, flexBasis: 90, alignItems: 'center', paddingVertical: 12, borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.bgSubtle },
  chipOn:     { backgroundColor: Colors.secondary, borderColor: Colors.secondary },
  chipText:   { ...Typography.bodySmall, color: Colors.text, fontWeight: '600' },
  chipTextOn: { color: Colors.textOnDark },

  infoList:  { gap: Space.sm },
  infoRow:   { flexDirection: 'row', justifyContent: 'space-between', gap: Space.md },
  infoLabel: { ...Typography.bodySmall, color: Colors.textMuted },
  divider:   { height: 1, backgroundColor: Colors.borderSubtle, marginVertical: Space.sm },
  manageBtn: { borderWidth: 1.5, borderColor: Colors.secondary, borderRadius: Radius.full, paddingHorizontal: Space.base, paddingVertical: Space.sm },
  manageText: { ...Typography.bodySmall, color: Colors.secondary, fontWeight: '600' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.xs },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingVertical: Space.sm },
  dangerBox: { backgroundColor: Colors.errorBg, borderRadius: Radius.md, padding: Space.base, gap: Space.sm },
  deleteBtn: { minHeight: 56, borderRadius: Radius.full, backgroundColor: Colors.error, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Space.lg },
  deleteBtnText: { ...Typography.body, color: Colors.textOnDark, fontWeight: '600' },
})
