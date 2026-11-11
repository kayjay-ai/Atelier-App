import { useState } from 'react'
import { View, Text, ScrollView, StyleSheet, KeyboardAvoidingView, Platform, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { ApiError, addOwnerStore, resendStoreInvite, type AddStoreInput } from '../../../lib/api'
import { INDIAN_STATES, ownerErrorText } from '../../../lib/owner'
import { Colors, Typography, Space } from '../../../lib/theme'
import { PageHeader } from '../../../lib/ui'
import { Banner, Btn, Card, Field, SelectField, toast, WIDE } from '../../../components/owner/kit'
import { showTestInvite } from '../../../components/owner/storeActions'

// ─── Add Store: one form creates the store and invites its manager ────────────
// The store appears on Home straight away as Invited. Duplicate rules (flow doc):
// a name already used → inline error; an email with an open invite → Resend;
// an email that already manages a store → blocked (each store's login is its
// manager's email, so one email can manage only one store).

const EMPTY: AddStoreInput = {
  storeName: '', city: '', state: '', address: '', pincode: '',
  managerName: '', managerEmail: '', countryCode: '+91', managerPhone: '', note: '',
}
type Errors = Partial<Record<keyof AddStoreInput, string>>
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())

/** The same checks the API makes, so most mistakes show before sending. */
function check(f: AddStoreInput): Errors {
  const e: Errors = {}
  const name = f.storeName.trim()
  if (name.length < 2 || name.length > 80) e.storeName = 'Enter a store name of 2–80 characters.'
  if (f.city.trim().length < 2) e.city = 'Enter the city.'
  if (!f.state) e.state = 'Choose the state.'
  if (f.pincode.trim() && !/^\d{6}$/.test(f.pincode.trim())) e.pincode = 'A PIN code has 6 digits.'
  if (!f.managerName.trim()) e.managerName = 'Enter the store manager’s name.'
  if (!looksLikeEmail(f.managerEmail)) e.managerEmail = 'Enter a valid email address.'
  const digits = f.managerPhone.replace(/\D/g, '')
  if (!/^\+\d{1,4}$/.test(f.countryCode.trim())) e.managerPhone = 'Use a country code like +91.'
  else if (digits && f.countryCode.trim() === '+91' && !/^[6-9]\d{9}$/.test(digits)) e.managerPhone = 'Enter a 10-digit mobile number.'
  else if (digits && (digits.length < 6 || digits.length > 14)) e.managerPhone = 'Enter a valid phone number.'
  if (f.note.length > 300) e.note = 'Keep the note under 300 characters.'
  return e
}

export default function AddStore() {
  const { width } = useWindowDimensions()
  const wide = width >= WIDE
  const [form, setForm] = useState<AddStoreInput>(EMPTY)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [pendingStore, setPendingStore] = useState<string | null>(null)
  const [tried, setTried] = useState(false)

  const update = (k: keyof AddStoreInput) => (v: string) => {
    const next = { ...form, [k]: v }
    setForm(next)
    if (tried) setErrors(check(next))
    else if (errors[k]) setErrors({ ...errors, [k]: undefined })
    setProblem(null); setPendingStore(null)
  }

  function clear() {
    setForm(EMPTY); setErrors({}); setProblem(null); setPendingStore(null); setTried(false)
  }

  async function invite() {
    setTried(true)
    const local = check(form)
    setErrors(local)
    if (Object.keys(local).length) return
    setBusy(true); setProblem(null); setPendingStore(null)
    try {
      const r = await addOwnerStore({ ...form, managerEmail: form.managerEmail.trim() })
      const email = r.store.managerEmail
      clear()
      if (await showTestInvite(r.testInviteUrl, email)) {
        toast(`${r.store.name} is now on your dashboard.`, {
          action: { label: 'View on dashboard', onPress: () => router.navigate('/owner/home') }, ms: 9000,
        })
      } else if (r.emailStatus === 'failed') {
        toast(`${r.store.name} is on your dashboard, but the invite email to ${email} wasn’t delivered. Resend it from Home.`, {
          tone: 'error', action: { label: 'View on dashboard', onPress: () => router.navigate('/owner/home') }, ms: 9000,
        })
      } else {
        toast(`Invite sent to ${email}. ${r.store.name} is now on your dashboard.`, {
          action: { label: 'View on dashboard', onPress: () => router.navigate('/owner/home') }, ms: 9000,
        })
      }
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.extra.fields) setErrors(e.extra.fields)
        if (e.code === 'invite_pending' && e.extra.storeId) setPendingStore(String(e.extra.storeId))
        setProblem(e.message)
      } else {
        setProblem(ownerErrorText(e))
      }
    } finally {
      setBusy(false)
    }
  }

  async function resendPending() {
    if (!pendingStore) return
    try {
      const r = await resendStoreInvite(pendingStore)
      clear()
      if (await showTestInvite(r.testInviteUrl, r.store.managerEmail)) return
      toast(r.emailStatus === 'failed' ? 'The invite email wasn’t delivered. Try again in a few minutes.' : `Invite sent again to ${r.store.managerEmail}.`,
        { tone: r.emailStatus === 'failed' ? 'error' : 'success' })
      clear()
    } catch (e) {
      toast(ownerErrorText(e), { tone: 'error' })
    }
  }

  const two = wide ? s.two : null
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: Colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.page, wide && s.pageWide]} keyboardShouldPersistTaps="handled">
        <PageHeader title="Add Store" subtitle="Create the store and invite its manager in one step. The invite link works once and expires in 7 days." />

        <Card style={{ gap: Space.xs }}>
          <Text style={s.section}>Store</Text>
          <Field label="Store name" value={form.storeName} onChangeText={update('storeName')} placeholder="e.g. Lahore Road" error={errors.storeName} maxLength={80} />
          <View style={two}>
            <View style={wide ? s.col : null}>
              <Field label="City" value={form.city} onChangeText={update('city')} placeholder="e.g. Mumbai" error={errors.city} autoComplete="postal-address-locality" />
            </View>
            <View style={wide ? s.col : null}>
              <SelectField label="State" value={form.state} options={INDIAN_STATES} onChange={update('state')} error={errors.state} placeholder="Choose the state" />
            </View>
          </View>
          <View style={two}>
            <View style={wide ? [s.col, { flex: 2 }] : null}>
              <Field label="Address" optional value={form.address} onChangeText={update('address')} placeholder="Shop number, street, area" error={errors.address} maxLength={200} />
            </View>
            <View style={wide ? s.col : null}>
              <Field label="PIN code" optional value={form.pincode} onChangeText={(v) => update('pincode')(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" placeholder="400001" error={errors.pincode} />
            </View>
          </View>

          <Text style={[s.section, { marginTop: Space.lg }]}>Store manager</Text>
          <Field label="Manager name" value={form.managerName} onChangeText={update('managerName')} placeholder="Used in the invite email" error={errors.managerName} maxLength={80} />
          <Field
            label="Manager email" value={form.managerEmail} onChangeText={update('managerEmail')} placeholder="priya@brand.com"
            keyboardType="email-address" autoCapitalize="none" autoCorrect={false} error={errors.managerEmail}
            hint="This becomes the store’s login. Each store needs its own manager email."
          />
          <View style={s.phone}>
            <View style={{ width: 90 }}>
              <Field label="Code" value={form.countryCode} onChangeText={(v) => update('countryCode')(v.replace(/[^\d+]/g, '').slice(0, 5))} keyboardType="phone-pad" />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Manager phone" optional value={form.managerPhone} onChangeText={update('managerPhone')} keyboardType="phone-pad" placeholder="98765 43210" error={errors.managerPhone} />
            </View>
          </View>
          <Field
            label="Personal note" optional value={form.note} onChangeText={(v) => update('note')(v.slice(0, 300))} multiline
            placeholder="Added to the invite email" error={errors.note} hint={`${form.note.length}/300`}
          />

          {problem && (
            <View style={{ marginTop: Space.md, gap: Space.sm }}>
              <Banner tone="error" text={problem} />
              {pendingStore && <Btn small kind="secondary" icon="mail" label="Resend the pending invite" onPress={resendPending} />}
            </View>
          )}

          <View style={s.actions}>
            <Btn kind="ghost" label="Clear" onPress={clear} disabled={busy} />
            <Btn icon="mail" label="Invite" onPress={invite} loading={busy} />
          </View>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  page: { padding: Space.base, paddingTop: Space.lg, gap: Space.base, paddingBottom: Space.xxl },
  pageWide: { padding: Space.xl, maxWidth: 820 + 64, width: '100%', alignSelf: 'center', gap: Space.lg },
  title: { ...Typography.h1 },
  sub: { ...Typography.bodySmall, color: Colors.textMuted },
  section: { ...Typography.h3 },
  two: { flexDirection: 'row', gap: Space.md },
  col: { flex: 1 },
  phone: { flexDirection: 'row', gap: Space.sm, alignItems: 'flex-start' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: Space.sm, marginTop: Space.lg },
})
