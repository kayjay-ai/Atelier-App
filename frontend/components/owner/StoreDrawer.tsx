import React, { useEffect, useRef, useState } from 'react'
import {
  View, Text, ScrollView, TouchableOpacity, Modal, Pressable, StyleSheet, Animated, Platform, Linking, useWindowDimensions,
} from 'react-native'
import { fetchOwnerStore, type OwnerStoreDetail } from '../../lib/api'
import { copyText, fmtDate, inr, num, ownerErrorText, preActive, relativeTime } from '../../lib/owner'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon } from '../../lib/ui'
import { Banner, Btn, Pill, Skeleton, StatusPill, toast } from './kit'
import { storeActions } from './storeActions'

// The store detail drawer (flow doc): slides in from the right, the table stays
// visible behind it. Header, Devices, Credits (with 30-day usage), Payment
// history, and actions. `section` scrolls straight to one part (from a notification).

export type DrawerSection = 'devices' | 'credits' | 'payments'

const deviceType = (t: string) => {
  const v = t.toLowerCase()
  if (v.includes('kiosk')) return 'Kiosk'
  if (v.includes('mirror')) return 'Mirror'
  if (v === 'ipad' || v === 'ios' || v === 'web') return 'Tablet · iPad'
  if (v === 'android') return 'Tablet · Android'
  return 'Tablet'
}

/** Daily credits used over the last 30 days: a line on the web, bars on iPad / phone. */
function UsageChart({ data }: { data: { day: string; used: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.used))
  const total = data.reduce((n, d) => n + d.used, 0)
  const label = `Credits used per day, last 30 days: ${num(total)} in total, at most ${num(max)} in a day.`
  let chart: React.ReactNode
  if (Platform.OS === 'web') {
    const W = 300, H = 80, P = 4
    const pts = data.map((d, i) => `${P + (i * (W - 2 * P)) / Math.max(1, data.length - 1)},${H - P - (d.used / max) * (H - 2 * P)}`).join(' ')
    chart = React.createElement('svg', {
      viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, preserveAspectRatio: 'none', role: 'img', 'aria-label': label,
    },
    React.createElement('polygon', { points: `${P},${H - P} ${pts} ${W - P},${H - P}`, fill: Colors.primarySubtle }),
    React.createElement('polyline', {
      points: pts, fill: 'none', stroke: Colors.secondary, strokeWidth: 2,
      strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke',
    }))
  } else {
    chart = (
      <View style={d.bars} accessible accessibilityLabel={label}>
        {data.map((x) => (
          <View key={x.day} style={[d.bar, { height: Math.max(2, (x.used / max) * 72) }]} />
        ))}
      </View>
    )
  }
  return (
    <View style={d.chart}>
      <View style={d.chartHead}>
        <Text style={d.label}>DAILY USAGE · LAST 30 DAYS</Text>
        <Text style={d.caption}>{num(total)} credits · peak {num(max)}/day</Text>
      </View>
      {chart}
      <View style={d.chartAxis}>
        <Text style={d.caption}>{fmtDate(data[0]?.day)}</Text>
        <Text style={d.caption}>{fmtDate(data[data.length - 1]?.day)}</Text>
      </View>
    </View>
  )
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <View style={d.kv}>
      <Text style={d.kvLabel}>{label}</Text>
      {typeof value === 'string' || typeof value === 'number'
        ? <Text style={[d.kvValue, mono && d.mono]} selectable>{value}</Text>
        : value}
    </View>
  )
}

function Section({ title, children, onLayout }: { title: string; children: React.ReactNode; onLayout?: (y: number) => void }) {
  return (
    <View style={d.section} onLayout={(e) => onLayout?.(e.nativeEvent.layout.y)}>
      <Text style={d.sectionTitle} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  )
}

export function StoreDrawer({ storeId, section, onClose, onChanged }: {
  storeId: string | null; section?: DrawerSection | null; onClose: () => void; onChanged: () => void
}) {
  const { width } = useWindowDimensions()
  const panelW = Math.min(560, width)
  const slide = useRef(new Animated.Value(panelW)).current
  const scroll = useRef<ScrollView>(null)
  const ys = useRef<Partial<Record<DrawerSection, number>>>({})
  const [detail, setDetail] = useState<OwnerStoreDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!storeId) return
    slide.setValue(panelW)
    Animated.timing(slide, { toValue: 0, duration: 220, useNativeDriver: Platform.OS !== 'web' }).start()
  }, [storeId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!storeId) { setDetail(null); return }
    let cancelled = false
    setError(null)
    if (detail?.store.id !== storeId) setDetail(null)
    fetchOwnerStore(storeId)
      .then((r) => { if (!cancelled) setDetail(r) })
      .catch((e) => { if (!cancelled) setError(ownerErrorText(e)) })
    return () => { cancelled = true }
  }, [storeId, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to the section a notification pointed at, once it has laid out.
  useEffect(() => {
    if (!detail || !section) return
    const t = setTimeout(() => {
      const y = ys.current[section]
      if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: true })
    }, 250)
    return () => clearTimeout(t)
  }, [detail, section])

  if (!storeId) return null
  const close = () => {
    Animated.timing(slide, { toValue: panelW, duration: 180, useNativeDriver: Platform.OS !== 'web' }).start(onClose)
  }
  const changed = () => { setNonce((x) => x + 1); onChanged() }
  const st = detail?.store
  const early = st ? preActive(st.status) : false

  return (
    <Modal transparent visible animationType="none" onRequestClose={close}>
      <View style={d.root}>
        <Pressable style={d.scrim} onPress={close} accessibilityLabel="Close store details" />
        <Animated.View style={[d.panel, { width: panelW, transform: [{ translateX: slide }] }]} accessibilityViewIsModal>
          <View style={d.top}>
            <Text style={d.topLabel}>STORE DETAILS</Text>
            <TouchableOpacity onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
              <Icon name="close" size={22} color={Colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView ref={scroll} contentContainerStyle={d.body}>
            {error && <Banner text={error} actionLabel="Retry" onAction={() => setNonce((x) => x + 1)} />}
            {!st && !error && (
              <View style={{ gap: Space.md }}>
                <Skeleton width="60%" height={26} />
                <Skeleton width="40%" />
                <Skeleton height={90} />
                <Skeleton height={140} />
              </View>
            )}
            {st && detail && (
              <>
                <View style={{ gap: Space.xs }}>
                  <Text style={d.name}>{st.name}</Text>
                  <Text style={d.muted}>{[st.address, st.location, st.pincode].filter(Boolean).join(', ') || '—'}</Text>
                  <View style={{ flexDirection: 'row', gap: Space.sm, alignItems: 'center', marginTop: Space.xs }}>
                    <StatusPill status={st.status} />
                    {st.emailNotDelivered && <Pill label="Email not delivered" tone="warning" />}
                  </View>
                </View>

                <View style={d.card}>
                  <Row label="Store ID" value={(
                    <TouchableOpacity
                      style={d.copy} accessibilityRole="button" accessibilityLabel={`Copy store ID ${st.id}`}
                      onPress={async () => { if (await copyText(st.id) === 'copied') toast('Store ID copied.') }}
                    >
                      <Text style={[d.kvValue, d.mono]} selectable>{st.id}</Text>
                      <Icon name="copy" size={14} color={Colors.textMuted} />
                    </TouchableOpacity>
                  )} />
                  <Row label="Manager" value={[st.managerName, st.managerEmail].filter(Boolean).join(' · ') || '—'} />
                  {!!st.managerPhone && <Row label="Phone" value={st.managerPhone} />}
                  <Row label="Invited" value={fmtDate(st.invitedAt)} />
                  <Row label="Activated" value={st.activatedAt ? fmtDate(st.activatedAt) : 'Not yet'} />
                  {st.deactivatedAt && <Row label="Deactivated" value={fmtDate(st.deactivatedAt)} />}
                </View>

                <View style={d.actions}>
                  {(st.status === 'invited' || st.status === 'invite_expired') && (
                    <Btn small icon="mail" label="Resend invite" onPress={() => storeActions.resend(st, changed)} />
                  )}
                  {!!st.managerEmail && (
                    <Btn small kind="secondary" icon="mail" label="Contact manager"
                      onPress={() => Linking.openURL(`mailto:${st.managerEmail}?subject=${encodeURIComponent(`Atelier — ${st.name}`)}`)} />
                  )}
                  {['active', 'pending', 'low_credits', 'expired'].includes(st.status) && (
                    <Btn small kind="ghost" label="Deactivate store" onPress={() => storeActions.deactivate(st, changed)} />
                  )}
                </View>

                <Section title={`Devices · ${early ? '—' : detail.devices.length}`} onLayout={(y) => { ys.current.devices = y }}>
                  {detail.devices.length === 0 ? (
                    <Text style={d.muted}>{early
                      ? 'Devices appear here once the manager signs in on the store’s iPads.'
                      : 'No devices have connected yet.'}</Text>
                  ) : detail.devices.map((dev) => (
                    <View key={dev.id} style={d.device}>
                      <View style={[d.dot, { backgroundColor: dev.online ? Colors.success : Colors.textFaint }]}
                        accessibilityLabel={dev.online ? 'Online' : 'Offline'} />
                      <View style={{ flex: 1 }}>
                        <Text style={d.deviceName}>{dev.name}{dev.blocked ? '  · blocked' : ''}</Text>
                        <Text style={d.caption}>{deviceType(dev.type)} · {dev.online ? 'Online now' : dev.lastActiveAt ? `Last active ${relativeTime(dev.lastActiveAt)}` : 'Never active'}</Text>
                      </View>
                    </View>
                  ))}
                </Section>

                <Section title="Credits" onLayout={(y) => { ys.current.credits = y }}>
                  {!detail.credits.packageName ? (
                    <Text style={d.muted}>{early ? 'No credit package yet — the store buys one from its Plan & Credits page.' : 'No current package.'}</Text>
                  ) : (
                    <View style={d.card}>
                      <Row label="Package" value={detail.credits.packageName} />
                      <Row label="Credits in package" value={num(detail.credits.packageCredits)} />
                      <Row label="Credits used" value={num(detail.credits.used)} />
                      <Row label="Credits remaining" value={num(detail.credits.remaining)} />
                      {detail.credits.topup > 0 && <Row label="Of which top-up" value={`${num(detail.credits.topup)} (never expire)`} />}
                      <Row label="Package dates" value={`${fmtDate(detail.credits.startsAt)} – ${fmtDate(detail.credits.endsAt)}`} />
                    </View>
                  )}
                  {!early && <UsageChart data={detail.usage} />}
                </Section>

                <Section title="Payment history" onLayout={(y) => { ys.current.payments = y }}>
                  {detail.payments.length === 0 ? (
                    <Text style={d.muted}>No payments yet.</Text>
                  ) : (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View>
                        <View style={[d.payRow, d.payHead]}>
                          {['Date', 'Package', 'Amount', 'Method', 'Status', 'Invoice'].map((h, i) => (
                            <Text key={h} style={[d.payCell, d.payHeadText, { width: PAY_W[i] }]}>{h}</Text>
                          ))}
                        </View>
                        {detail.payments.map((p) => (
                          <View key={p.id} style={d.payRow}>
                            <Text style={[d.payCell, { width: PAY_W[0] }]}>{fmtDate(p.date)}</Text>
                            <Text style={[d.payCell, { width: PAY_W[1] }]} numberOfLines={2}>{p.package}</Text>
                            <Text style={[d.payCell, { width: PAY_W[2] }]}>{inr(p.amount)}</Text>
                            <Text style={[d.payCell, { width: PAY_W[3] }]}>{p.last4 ? `•••• ${p.last4}` : p.method ? p.method.replace(/_/g, ' ') : '—'}</Text>
                            <View style={[d.payCellBox, { width: PAY_W[4] }]}>
                              <Pill label={p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Failed' : 'On hold'}
                                tone={p.status === 'paid' ? 'good' : p.status === 'failed' ? 'warning' : 'waiting'} />
                            </View>
                            <View style={[d.payCellBox, { width: PAY_W[5] }]}>
                              {p.invoiceUrl
                                ? <TouchableOpacity onPress={() => Linking.openURL(p.invoiceUrl!)} accessibilityRole="link"><Text style={d.link}>Download</Text></TouchableOpacity>
                                : <Text style={d.payCell}>—</Text>}
                            </View>
                          </View>
                        ))}
                      </View>
                    </ScrollView>
                  )}
                </Section>
              </>
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}

const PAY_W = [88, 128, 80, 72, 80, 64] // fits the 560-wide drawer; scrolls sideways on phones

const d = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end' },
  scrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(42,39,37,0.28)' },
  panel: { height: '100%', backgroundColor: Colors.bg, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, elevation: 24 },
  top: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Space.lg,
    paddingTop: Space.lg, paddingBottom: Space.md, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle, backgroundColor: Colors.bgCard,
  },
  topLabel: { ...Typography.label, color: Colors.primary, letterSpacing: 2 },
  body: { padding: Space.lg, gap: Space.lg, paddingBottom: Space.xxl },
  name: { ...Typography.h2 },
  muted: { ...Typography.bodySmall, color: Colors.textMuted },
  caption: { ...Typography.caption, color: Colors.textFaint },
  label: { ...Typography.label },
  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, padding: Space.base, borderWidth: 1, borderColor: Colors.borderSubtle, gap: Space.sm },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: Space.md },
  kvLabel: { ...Typography.bodySmall, color: Colors.textMuted },
  kvValue: { ...Typography.bodySmall, fontWeight: '600', textAlign: 'right', flexShrink: 1 },
  mono: { fontFamily: Platform.select({ web: 'ui-monospace, Menlo, monospace', ios: 'Menlo', default: 'monospace' }), letterSpacing: 0.5 },
  copy: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  section: { gap: Space.sm },
  sectionTitle: { ...Typography.h3 },
  device: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.sm, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  dot: { width: 10, height: 10, borderRadius: 5 },
  deviceName: { ...Typography.bodySmall, fontWeight: '600' },
  chart: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, padding: Space.base, borderWidth: 1, borderColor: Colors.borderSubtle, gap: Space.sm },
  chartHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chartAxis: { flexDirection: 'row', justifyContent: 'space-between' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: 76, gap: 2 },
  bar: { flex: 1, backgroundColor: Colors.secondary, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  payRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle, minHeight: 44 },
  payHead: { minHeight: 32 },
  payHeadText: { ...Typography.label },
  payCell: { ...Typography.caption, color: Colors.text, paddingRight: Space.sm },
  payCellBox: { paddingRight: Space.sm },
  link: { ...Typography.caption, color: Colors.secondary, fontWeight: '700', textDecorationLine: 'underline' },
})
