import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { View, Text, ScrollView, Switch, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import {
  ApiError, changeOwnerPassword, fetchOwnerSessions, signOutOtherOwnerSessions, updateOwnerProfile,
  type NotifyPrefs, type OwnerNotificationCategory, type OwnerSession,
} from '../../../lib/api'
import {
  CATEGORY_META, copyText, fmtDate, ownerErrorText, passwordOk, relativeTime, signOutOwner, useOwnerStore,
} from '../../../lib/owner'
import { Colors, Typography, Space, Radius } from '../../../lib/theme'
import { Icon } from '../../../lib/ui'
import { Banner, Btn, Card, Field, PasswordChecklist, PasswordField, Pill, Skeleton, confirmDialog, toast, WIDE } from '../../../components/owner/kit'

// ─── Profile: who the owner is, their organization, security, notifications ──

function Row({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <View style={p.row}>
      <View style={{ flex: 1 }}>
        <Text style={p.rowLabel}>{label}</Text>
        {!!note && <Text style={p.note}>{note}</Text>}
      </View>
      <View style={p.rowValue}>{children}</View>
    </View>
  )
}

function Copyable({ value, what }: { value: string; what: string }) {
  return (
    <TouchableOpacity
      style={p.copy} accessibilityRole="button" accessibilityLabel={`Copy ${what}`}
      onPress={async () => { const r = await copyText(value); if (r === 'copied') toast(`${what} copied.`) }}
    >
      <Text style={p.mono} selectable numberOfLines={1}>{value}</Text>
      <Icon name="copy" size={14} color={Colors.textMuted} />
    </TouchableOpacity>
  )
}

const OPTIONAL: OwnerNotificationCategory[] = ['purchases', 'payments', 'store_activity', 'deals', 'gift_cards']

export default function OwnerProfile() {
  const { width } = useWindowDimensions()
  const wide = width >= WIDE
  const { section } = useLocalSearchParams<{ section?: string }>()
  const me = useOwnerStore((s) => s.me)
  const setProfile = useOwnerStore((s) => s.setProfile)
  const scroll = useRef<ScrollView>(null)
  const securityY = useRef(0)

  // Account details
  const [name, setName] = useState(me?.owner.name ?? '')
  const [phone, setPhone] = useState(me?.owner.phone ?? '')
  const [saving, setSaving] = useState(false)
  const [detailsErr, setDetailsErr] = useState<Partial<Record<'name' | 'phone', string>>>({})
  useEffect(() => { setName(me?.owner.name ?? ''); setPhone(me?.owner.phone ?? '') }, [me?.owner.name, me?.owner.phone])
  const dirty = !!me && (name.trim() !== me.owner.name || phone.trim() !== me.owner.phone)

  // Security
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwErr, setPwErr] = useState<{ field?: string; text: string } | null>(null)
  const [sessions, setSessions] = useState<OwnerSession[] | null>(null)
  const [sessErr, setSessErr] = useState<string | null>(null)

  const loadSessions = useCallback(async () => {
    try { setSessions((await fetchOwnerSessions()).sessions); setSessErr(null) } catch (e) { setSessErr(ownerErrorText(e)) }
  }, [])
  useFocusEffect(useCallback(() => { loadSessions(); useOwnerStore.getState().load() }, [loadSessions]))

  useEffect(() => {
    if (section !== 'security') return
    const t = setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, securityY.current - 8), animated: true }), 300)
    router.setParams({ section: undefined })
    return () => clearTimeout(t)
  }, [section])

  if (!me) return null

  async function saveDetails() {
    setSaving(true); setDetailsErr({})
    try {
      const r = await updateOwnerProfile({ name: name.trim(), phone: phone.trim() })
      setProfile(r)
      toast('Your details were saved.')
    } catch (e) {
      if (e instanceof ApiError && (e.extra.field === 'name' || e.extra.field === 'phone')) setDetailsErr({ [e.extra.field]: e.message })
      else toast(ownerErrorText(e), { tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function changePassword() {
    setPwErr(null)
    if (!passwordOk(pw) || pw !== pw2) return
    setPwBusy(true)
    try {
      await changeOwnerPassword(cur, pw)
      setCur(''); setPw(''); setPw2('')
      toast('Password changed. Your other devices were signed out.')
      loadSessions()
    } catch (e) {
      setPwErr({ field: e instanceof ApiError ? e.extra.field : undefined, text: ownerErrorText(e) })
    } finally {
      setPwBusy(false)
    }
  }

  async function signOutOthers() {
    const ok = await confirmDialog({
      title: 'Sign out of all other devices?',
      body: 'Every other browser and device signed in to your owner account is signed out now. This one stays signed in.',
      confirmLabel: 'Sign out others', danger: true,
    })
    if (!ok) return
    try {
      await signOutOtherOwnerSessions()
      toast('Your other devices were signed out.')
      loadSessions()
    } catch (e) {
      toast(ownerErrorText(e), { tone: 'error' })
    }
  }

  async function setPref(next: NotifyPrefs) {
    const before = me!.notifyPrefs
    setProfile({ ...me!, notifyPrefs: next })
    try {
      setProfile(await updateOwnerProfile({ notifyPrefs: next }))
    } catch (e) {
      setProfile({ ...me!, notifyPrefs: before })
      toast(ownerErrorText(e), { tone: 'error' })
    }
  }

  const prefs = me.notifyPrefs
  const others = (sessions ?? []).filter((s) => !s.current).length

  return (
    <ScrollView ref={scroll} style={{ backgroundColor: Colors.bg }} contentContainerStyle={[p.page, wide && p.pageWide]} keyboardShouldPersistTaps="handled">
      <Text style={p.title} accessibilityRole="header">Profile</Text>

      {/* Account details */}
      <Card>
        <Text style={p.section}>Account details</Text>
        <View style={wide ? p.two : null}>
          <View style={wide ? { flex: 1 } : null}>
            <Field label="Owner name" value={name} onChangeText={(v) => { setName(v); setDetailsErr({}) }} error={detailsErr.name} maxLength={80} />
          </View>
          <View style={wide ? { flex: 1 } : null}>
            <Field label="Phone" optional value={phone} onChangeText={(v) => { setPhone(v); setDetailsErr({}) }} keyboardType="phone-pad" error={detailsErr.phone} placeholder="+91 98765 43210" />
          </View>
        </View>
        {dirty && (
          <View style={p.saveRow}>
            <Btn small kind="ghost" label="Cancel" onPress={() => { setName(me.owner.name); setPhone(me.owner.phone) }} />
            <Btn small label="Save" loading={saving} onPress={saveDetails} />
          </View>
        )}
        <View style={{ marginTop: Space.md }}>
          <Row label="Email" note="This is your login. To change it, contact Atelier support.">
            <Text style={p.value} selectable>{me.owner.email}</Text>
          </Row>
          <Row label="Organization / brand" note="Set by Atelier"><Text style={p.value}>{me.organization.name}</Text></Row>
          <Row label="Store code" note="Organization code"><Copyable value={me.organization.code} what="Store code" /></Row>
          <Row label="Owner ID" note="Quote it in support requests"><Copyable value={me.owner.id} what="Owner ID" /></Row>
          <Row label="Account activated on"><Text style={p.value}>{fmtDate(me.owner.activatedAt)}</Text></Row>
          <Row label="Total stores">
            <TouchableOpacity onPress={() => router.navigate('/owner/home')} accessibilityRole="link" style={p.copy}>
              <Text style={[p.value, { textDecorationLine: 'underline' }]}>{me.totalStores}</Text>
              <Icon name="chevron" size={16} color={Colors.textMuted} />
            </TouchableOpacity>
          </Row>
        </View>
      </Card>

      {/* Security */}
      <View onLayout={(e) => { securityY.current = e.nativeEvent.layout.y }}>
        <Card>
          <Text style={p.section}>Security</Text>
          <Text style={p.sub}>Change password</Text>
          <PasswordField label="Current password" value={cur} onChangeText={(v) => { setCur(v); setPwErr(null) }}
            autoComplete="current-password" error={pwErr?.field === 'current' ? pwErr.text : null} />
          <PasswordField label="New password" value={pw} onChangeText={(v) => { setPw(v); setPwErr(null) }}
            autoComplete="new-password" error={pwErr?.field === 'next' ? pwErr.text : null} />
          <PasswordChecklist password={pw} />
          <PasswordField label="Confirm new password" value={pw2} onChangeText={setPw2} autoComplete="new-password"
            error={pw2.length > 0 && pw !== pw2 ? 'The passwords don’t match.' : null} />
          {pwErr && !pwErr.field && <View style={{ marginTop: Space.sm }}><Banner text={pwErr.text} /></View>}
          <View style={p.saveRow}>
            <Btn small label="Change password" loading={pwBusy} onPress={changePassword}
              disabled={!cur || !passwordOk(pw) || pw !== pw2} />
          </View>
          <Text style={p.hint}>Changing your password signs out your other devices.</Text>

          <Text style={[p.sub, { marginTop: Space.xl }]}>Active sessions</Text>
          {sessErr && <Banner text={sessErr} actionLabel="Retry" onAction={loadSessions} />}
          {!sessions && !sessErr && <View style={{ gap: Space.sm, marginTop: Space.sm }}><Skeleton height={44} /><Skeleton height={44} /></View>}
          {sessions?.map((s) => (
            <View key={s.id} style={p.session}>
              <Icon name={/iPad|iPhone|Android/.test(s.device) ? 'tablet' : 'devices'} size={20} color={Colors.secondary} />
              <View style={{ flex: 1 }}>
                <Text style={p.value}>{s.device}</Text>
                <Text style={p.note}>
                  Last active {relativeTime(s.lastActiveAt)} · signed in {fmtDate(s.createdAt)} · {s.remember ? 'kept signed in' : 'ends after 24 hours'}
                </Text>
              </View>
              {s.current && <Pill label="This device" tone="good" />}
            </View>
          ))}
          <View style={p.saveRow}>
            <Btn small kind="secondary" label="Sign out of all other devices" onPress={signOutOthers} disabled={others === 0} />
          </View>

          <View style={p.divider} />
          <Btn kind="ghost" icon="logout" label="Log out" onPress={async () => { await signOutOwner(); router.replace('/owner/login') }}
            style={{ alignSelf: 'flex-start', paddingHorizontal: 0 }} />
        </Card>
      </View>

      {/* Notification preferences */}
      <Card>
        <Text style={p.section}>Notification preferences</Text>
        <Text style={p.hint}>Payment failures, expired packages and new sign-ins always reach you, in the app and by email.</Text>
        {OPTIONAL.map((c) => (
          <View key={c} style={p.toggle}>
            <Icon name={CATEGORY_META[c].icon} size={18} color={Colors.secondary} />
            <Text style={p.toggleLabel}>{CATEGORY_META[c].label}</Text>
            <Switch
              value={prefs.categories[c] !== false} accessibilityLabel={CATEGORY_META[c].label}
              onValueChange={(v) => setPref({ ...prefs, categories: { ...prefs.categories, [c]: v } })}
              trackColor={{ true: Colors.secondary, false: Colors.border }} thumbColor={Colors.bgCard}
            />
          </View>
        ))}
        <View style={p.toggle}>
          <Icon name="shield" size={18} color={Colors.secondary} />
          <View style={{ flex: 1 }}>
            <Text style={p.toggleLabel}>Account & security</Text>
            <Text style={p.note}>Always on</Text>
          </View>
          <Switch value disabled accessibilityLabel="Account and security, always on" trackColor={{ true: Colors.primary, false: Colors.border }} thumbColor={Colors.bgCard} />
        </View>

        <Text style={[p.sub, { marginTop: Space.lg }]}>Channels</Text>
        <View style={p.toggle}>
          <Icon name="bell" size={18} color={Colors.secondary} />
          <View style={{ flex: 1 }}>
            <Text style={p.toggleLabel}>In-app</Text>
            <Text style={p.note}>Always on</Text>
          </View>
          <Switch value disabled accessibilityLabel="In-app, always on" trackColor={{ true: Colors.primary, false: Colors.border }} thumbColor={Colors.bgCard} />
        </View>
        <View style={p.toggle}>
          <Icon name="mail" size={18} color={Colors.secondary} />
          <View style={{ flex: 1 }}>
            <Text style={p.toggleLabel}>Email</Text>
            <Text style={p.note}>To {me.owner.email}</Text>
          </View>
          <Switch value={prefs.email} accessibilityLabel="Email notifications"
            onValueChange={(v) => setPref({ ...prefs, email: v })}
            trackColor={{ true: Colors.secondary, false: Colors.border }} thumbColor={Colors.bgCard} />
        </View>
      </Card>
    </ScrollView>
  )
}

const p = StyleSheet.create({
  page: { padding: Space.base, paddingTop: Space.lg, gap: Space.base, paddingBottom: Space.xxl },
  pageWide: { padding: Space.xl, maxWidth: 820, width: '100%' },
  title: { ...Typography.h1 },
  section: { ...Typography.h3 },
  sub: { ...Typography.label, marginTop: Space.md },
  hint: { ...Typography.caption, color: Colors.textMuted, marginTop: Space.xs },
  two: { flexDirection: 'row', gap: Space.md },
  saveRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: Space.sm, marginTop: Space.md },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.md,
    borderTopWidth: 1, borderTopColor: Colors.borderSubtle,
  },
  rowLabel: { ...Typography.bodySmall, color: Colors.textMuted },
  rowValue: { flexShrink: 1, alignItems: 'flex-end', maxWidth: '60%' },
  value: { ...Typography.bodySmall, fontWeight: '600', textAlign: 'right' },
  note: { ...Typography.caption, color: Colors.textFaint },
  mono: { ...Typography.bodySmall, fontWeight: '600', letterSpacing: 0.5 },
  copy: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, flexShrink: 1 },
  session: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  divider: { height: 1, backgroundColor: Colors.borderSubtle, marginVertical: Space.lg },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  toggleLabel: { ...Typography.bodySmall, fontWeight: '600', flex: 1 },
})
