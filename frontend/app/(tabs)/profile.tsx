import { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Switch, Image, ActivityIndicator, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import { useProfileStore, useMembershipStore, isPremium, creditsLeft } from '../../lib/store'
import { supabase } from '../../lib/supabaseClient'
import { upsertProfile, uploadUserPhoto } from '../../lib/supabaseStorage'
import { postEvent, deleteAccount } from '../../lib/api'
import { pickImageDataUri } from '../../lib/imageInput'
import { FREE_CREDITS } from '../../lib/pricing'
import { Colors, Typography, Space, Radius, Weight } from '../../lib/theme'
import {
  Card, Divider, Field, Icon, Loading, Notice, Page, PageHeader, PillButton, Segmented, TextLink, confirmDialog, toast,
} from '../../lib/ui'
import { FIT_LABELS, type Measurements } from '../../lib/types'
import { DateOfBirthField, parseDob, dobFromIso, type DobValue } from '../../components/DateOfBirthField'

// Profile tab (spec §3.2): Your photo · Your size · Fit preference · Account,
// with the three set-up steps on top. Guests can fill photo / size / fit for
// this session.

type Session = { id: string; email: string } | null

const FRAMING_TIPS = [
  'Head to feet in the frame',
  'Arms slightly away from your body',
  'Plain background, good light',
  'Fitted clothes show your shape best',
]

const STEPS = ['Your photo', 'Your size', 'Fit preference'] as const

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
    return <Loading label="Loading your profile…" />
  }

  const done = [!!profile.photoUri, !!profile.measurements, !!profile.measurements?.fitChosen]
  const doneCount = done.filter(Boolean).length
  const next = done.findIndex((d) => !d)

  return (
    <Page width="reading">
      <PageHeader title="Your Profile" subtitle="Your photo, size and fit are used for every try-on and size recommendation." />

      {!session && (
        <Notice tone="info" title="You’re not signed in"
          text="What you add here is kept for this visit only. Sign in to keep it on every device."
          actionLabel="Sign in or create an account" onAction={() => router.push('/auth')} />
      )}

      <Card variant="sunken" style={{ gap: Space.md }}>
        <View style={s.rowBetween}>
          <Text style={s.cardTitle}>{doneCount === 3 ? 'Your profile is complete' : `${doneCount} of 3 steps done`}</Text>
          {doneCount === 3 && <Icon name="success" size={22} color={Colors.success} />}
        </View>
        <View style={s.steps} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 3, now: doneCount }}>
          {STEPS.map((label, i) => (
            <View key={label} style={s.step}>
              <View style={[s.stepBar, done[i] && s.stepBarDone]} />
              <View style={s.stepLabelRow}>
                {done[i] && <Icon name="check" size={13} color={Colors.success} />}
                <Text style={[s.stepLabel, done[i] && { color: Colors.text }, i === next && Weight.semibold]}>{label}</Text>
              </View>
            </View>
          ))}
        </View>
        {next >= 0 && (
          <Text style={s.muted}>
            {next === 0 ? 'Add your photo to try things on.' : next === 1 ? 'Add your size to get size advice.' : 'Pick how you like clothes to fit.'}
          </Text>
        )}
      </Card>

      <PhotoSection session={session} />
      <SizeSection session={session} />
      <FitSection session={session} />
      {session && <AccountSection session={session} />}
    </Page>
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
      toast('Photo saved.')
    } catch (e) {
      console.error('[Atelier] profile photo save failed:', e)
      setError('Couldn’t save your photo. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <View style={{ gap: Space.xs }}>
        <Text style={s.cardTitle}>Your photo</Text>
        <Text style={s.muted}>Used for every try-on and for your Style report.</Text>
      </View>
      <View style={s.photoRow}>
        <View style={s.photoBox}>
          {profile.photoUri
            ? <Image source={{ uri: profile.photoUri }} style={s.photoImg} resizeMode="cover" accessibilityLabel="Your photo" />
            : <View style={s.photoEmpty}><Icon name="profile" size={36} color={Colors.primary} /><Text style={s.photoEmptyText}>No photo yet</Text></View>}
          {saving && <View style={s.photoSaving}><ActivityIndicator color={Colors.textOnDark} /></View>}
        </View>
        <View style={s.tips}>
          <Text style={s.tipsTitle}>For the best result</Text>
          {FRAMING_TIPS.map((tip) => (
            <View key={tip} style={s.tipRow}>
              <Icon name="check" size={15} color={Colors.primaryDark} />
              <Text style={s.tipText}>{tip}</Text>
            </View>
          ))}
        </View>
      </View>
      <View style={s.btnRow}>
        <PillButton label={profile.photoUri ? 'Retake photo' : 'Take a photo'} icon="takePhoto" size="md" onPress={() => choose('camera')} disabled={saving} style={s.flexBtn} />
        <PillButton label="Choose from gallery" icon="gallery" variant="outline" size="md" onPress={() => choose('library')} disabled={saving} style={s.flexBtn} />
      </View>
      {error && <Notice tone="error" text={error} />}
    </Card>
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
  const { width } = useWindowDimensions()
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
      toast('Size saved.')
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn’t save — ${e?.message ?? 'try again'}.` })
    } finally {
      setBusy(false)
    }
  }

  // Three fields a row from tablet width, two on phones.
  const cell = { flexBasis: width < 520 ? '46%' : '30%' } as const
  return (
    <Card>
      <View style={s.rowBetween}>
        <View style={{ gap: Space.xs, flex: 1 }}>
          <Text style={s.cardTitle}>Your size</Text>
          <Text style={s.muted}>Body measurements, not garment sizes.</Text>
        </View>
        {!editing && saved && (
          <TextLink label="Edit" icon="edit" onPress={() => { setEditing(true); setMsg(null) }} />
        )}
      </View>
      {editing ? (
        <>
          <View style={s.grid}>
            {SIZE_FIELDS.map(({ key, label, unit }) => (
              <Field
                key={key} label={label} value={form[key]} onChangeText={(v) => setForm({ ...form, [key]: v })}
                keyboardType="decimal-pad" placeholder="0"
                right={<Text style={s.unit}>{unit}</Text>}
                containerStyle={[s.field, cell]}
              />
            ))}
            <Field
              label="Usual size" value={form.usualSize} onChangeText={(v) => setForm({ ...form, usualSize: v })}
              placeholder="e.g. M / 32" autoCapitalize="characters" containerStyle={[s.field, cell]}
            />
          </View>
          {msg && !msg.ok && <Notice tone="error" text={msg.text} />}
          <View style={s.btnRow}>
            {saved && <PillButton label="Cancel" variant="ghost" size="md" onPress={() => { setEditing(false); setForm(formFrom(saved)); setMsg(null) }} />}
            <PillButton label="Save size" size="md" onPress={save} loading={busy} style={{ minWidth: 160 }} />
          </View>
        </>
      ) : saved ? (
        <View style={s.savedGrid}>
          {SIZE_FIELDS.map(({ key, label, unit }) => (
            <View key={key} style={s.savedItem}>
              <Text style={s.savedValue}>{saved[key] != null ? saved[key] : '—'}<Text style={s.savedUnit}> {unit}</Text></Text>
              <Text style={s.savedLabel}>{label}</Text>
            </View>
          ))}
          <View style={s.savedItem}>
            <Text style={s.savedValue}>{saved.usualSize || '—'}</Text>
            <Text style={s.savedLabel}>Usual size</Text>
          </View>
        </View>
      ) : null}
    </Card>
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
      toast('Fit preference saved.')
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn’t save — ${e?.message ?? 'try again'}.` })
    } finally {
      setBusy(false)
    }
  }

  const unchanged = !!saved?.fitChosen && saved.fitPreference === choice
  const fits = (['snug', 'true-to-size', 'relaxed'] as const).map((f) => ({ value: f, label: FIT_LABELS[f] }))
  return (
    <Card>
      <View style={{ gap: Space.xs }}>
        <Text style={s.cardTitle}>Fit preference</Text>
        <Text style={s.muted}>How you like clothes to sit — used for every size recommendation.</Text>
      </View>
      <Segmented
        options={fits} value={(choice ?? '') as Measurements['fitPreference']} size="md"
        onChange={(f) => { setChoice(f); setMsg(null) }} disabled={!saved} accessibilityLabel="Fit preference"
      />
      {!saved
        ? <Text style={s.muted}>Save your size first, then your fit.</Text>
        : (
          <View style={s.btnRow}>
            <PillButton label={unchanged ? 'Saved' : 'Save fit'} icon={unchanged ? 'check' : undefined} size="md" onPress={save}
              loading={busy} disabled={!choice || unchanged} style={{ minWidth: 160 }} />
          </View>
        )}
      {msg && !msg.ok && <Notice tone="error" text={msg.text} />}
    </Card>
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
      toast('Details saved.')
    } catch (e: any) {
      setMsg({ ok: false, text: `Couldn’t save — ${e?.message ?? 'try again'}.` })
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
      setMsg({ ok: false, text: 'Couldn’t update your notification settings. Try again.' })
    }
  }

  async function removeAccount() {
    const ok = await confirmDialog({
      title: 'Delete your account?',
      body: 'Your photo, size, style report, history and remaining credits are removed permanently. This can’t be undone.',
      confirmLabel: 'Delete account', danger: true,
    })
    if (!ok) return
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
    <Card>
      <View style={s.rowBetween}>
        <Text style={s.cardTitle}>Account</Text>
        {!editing && <TextLink label="Edit" icon="edit" onPress={() => { setEditing(true); setName(profile.name ?? ''); setDob(dobFromIso(profile.dateOfBirth)) }} />}
      </View>

      {editing ? (
        <View>
          <Field label="Name" value={name} onChangeText={setName} autoCapitalize="words" autoComplete="name" containerStyle={{ marginTop: 0 }} />
          <View style={{ marginTop: Space.base, gap: 6 }}>
            <Text style={Typography.fieldLabel}>Date of birth</Text>
            <DateOfBirthField value={dob} onChange={setDob} />
          </View>
          <View style={[s.btnRow, { marginTop: Space.lg }]}>
            <PillButton label="Cancel" variant="ghost" size="md" onPress={() => { setEditing(false); setMsg(null) }} />
            <PillButton label="Save details" size="md" onPress={saveDetails} loading={busy} style={{ minWidth: 160 }} />
          </View>
        </View>
      ) : (
        <View>
          <InfoRow label="Name" value={profile.name ?? 'Not set'} />
          <InfoRow label="Email" value={session.email} />
          <InfoRow label="Date of birth" value={dobLabel} last />
        </View>
      )}

      <Divider />
      <View style={s.rowBetween}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={s.value}>{planLabel}</Text>
          <Text style={s.muted}>{premium ? 'No limit on try-ons.' : `${balance} credit${balance === 1 ? '' : 's'} left · new accounts get ${FREE_CREDITS} free`}</Text>
        </View>
        <PillButton label="Manage" variant="outline" size="sm" onPress={() => router.navigate('/(tabs)/premium')} />
      </View>

      <Divider />
      <Text style={s.subTitle}>Notifications</Text>
      <View style={s.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.value}>Email</Text>
          <Text style={s.muted}>Low-credit reminders and plan news</Text>
        </View>
        <Switch value={profile.notifyEmail} onValueChange={(v) => toggle('notifyEmail', v)} accessibilityLabel="Email notifications" {...SWITCH_COLORS} />
      </View>
      <View style={s.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.value}>Push and in-app</Text>
          <Text style={s.muted}>Alerts inside Atelier</Text>
        </View>
        <Switch value={profile.notifyPush} onValueChange={(v) => toggle('notifyPush', v)} accessibilityLabel="Push and in-app notifications" {...SWITCH_COLORS} />
      </View>

      {msg && !msg.ok && <Notice tone="error" text={msg.text} />}

      <Divider />
      <View style={s.dangerRow}>
        <PillButton label="Sign out" icon="logout" variant="outline" size="sm" onPress={() => supabase.auth.signOut()} />
        <TouchableOpacity style={s.deleteLink} onPress={removeAccount} disabled={deleting} accessibilityRole="button">
          {deleting ? <ActivityIndicator color={Colors.error} /> : <Icon name="trash" size={16} color={Colors.error} />}
          <Text style={s.deleteText}>Delete account</Text>
        </TouchableOpacity>
      </View>
    </Card>
  )
}

// Brand colours for toggles. activeThumbColor / activeTrackColor are the web
// (react-native-web) names; without them the "on" state falls back to teal.
const SWITCH_COLORS = {
  trackColor: { true: Colors.secondary, false: Colors.border },
  thumbColor: Colors.bgCard,
  activeTrackColor: Colors.secondary,
  activeThumbColor: Colors.bgCard,
  ios_backgroundColor: Colors.border,
} as any

function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[s.infoRow, !last && s.infoBorder]}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.value, { flexShrink: 1, textAlign: 'right' }]} numberOfLines={1}>{value}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  cardTitle: { ...Typography.h3 },
  subTitle:  { ...Typography.bodySmall, ...Weight.semibold },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.md },
  muted:  { ...Typography.bodySmall, color: Colors.textMuted },
  value:  { ...Typography.body },

  steps:        { flexDirection: 'row', gap: Space.sm },
  step:         { flex: 1, gap: Space.sm },
  stepBar:      { height: 4, borderRadius: 2, backgroundColor: Colors.border },
  stepBarDone:  { backgroundColor: Colors.secondary },
  stepLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepLabel:    { ...Typography.caption, flexShrink: 1 },

  photoRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.lg },
  photoBox: { width: 132, height: 176, borderRadius: Radius.md, overflow: 'hidden', backgroundColor: Colors.bgSubtle },
  photoImg: { width: '100%', height: '100%' },
  photoEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.xs },
  photoEmptyText: { ...Typography.caption },
  photoSaving: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(42,39,37,0.45)', alignItems: 'center', justifyContent: 'center' },
  tips:      { flex: 1, minWidth: 200, gap: Space.sm, justifyContent: 'center' },
  tipsTitle: { ...Typography.bodySmall, ...Weight.semibold },
  tipRow:    { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  tipText:   { ...Typography.bodySmall, color: Colors.textMuted, flex: 1 },

  btnRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, justifyContent: 'flex-end' },
  flexBtn: { flexGrow: 1, flexBasis: 180 },

  grid:  { flexDirection: 'row', flexWrap: 'wrap', columnGap: Space.md },
  field: { flexGrow: 1, minWidth: 120 },
  unit:  { ...Typography.caption, paddingRight: Space.base },

  savedGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  savedItem:  { flexBasis: 100, flexGrow: 1, backgroundColor: Colors.bgSubtle, borderRadius: Radius.md, padding: Space.md, gap: 2 },
  savedValue: { ...Typography.h3, fontSize: 18 },
  savedUnit:  { ...Typography.caption },
  savedLabel: { ...Typography.caption },

  infoRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Space.md, paddingVertical: Space.md },
  infoBorder: { borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  infoLabel:  { ...Typography.bodySmall, color: Colors.textMuted },
  switchRow:  { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.xs },

  dangerRow:  { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Space.md },
  deleteLink: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, paddingVertical: Space.sm },
  deleteText: { ...Typography.bodySmall, ...Weight.semibold, color: Colors.error },
})
