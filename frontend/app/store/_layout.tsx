import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Linking, useWindowDimensions } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Redirect, router, usePathname } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { useAccountStore, usableCredits } from '../../lib/account'
import { dismissStoreNotice } from '../../lib/api'
import { SUPPORT_EMAIL } from '../../lib/b2b'
import { beatNow, signOutStore, startHeartbeat, stopHeartbeat, useHeartbeat } from '../../lib/heartbeat'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, IconName, bottomTabOptions } from '../../lib/ui'
import PlanScreen from './plan'

// ─── B2B in-store app shell (/store) ──────────────────────────────────────────
// Only company logins reach this layout; anyone else is sent back to sign-in.
// Bottom tab bar on every device; iPad (≥ 768 pt wide) shows the full labels.

const WIDE_BREAKPOINT = 768

function RailIcon({ icon, focused }: { icon: IconName; focused: boolean }) {
  return <Icon name={icon} size={22} color={focused ? Colors.secondary : Colors.primary} />
}

function StoreHeader() {
  const account = useAccountStore((s) => s.account)
  if (account?.type !== 'b2b_company') return null
  const credits = usableCredits(account.client)
  return (
    <SafeAreaView edges={['top']} style={h.safe}>
      <View style={h.row}>
        <View style={{ flex: 1 }}>
          <Text style={h.sub}>QUASAR'S ATELIER · STORE</Text>
          <Text style={h.company} numberOfLines={1}>
            {account.client.companyName}
            {account.client.storeName && account.client.storeName !== account.client.companyName ? ` · ${account.client.storeName}` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={[h.credits, credits <= 0 && h.creditsEmpty]}
          onPress={() => router.navigate('/store/plan')}
          accessibilityRole="button"
          accessibilityLabel={`${credits} credits left. Open Plan and Credits.`}
        >
          <Icon name="star" size={14} color={credits <= 0 ? Colors.error : Colors.secondary} />
          <Text style={[h.creditsText, credits <= 0 && { color: Colors.error }]}>
            {credits.toLocaleString('en-IN')} credit{credits === 1 ? '' : 's'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

// One banner under the header, most urgent first (Admin spec §5.9, §8): an admin
// message, plan / trial expiry, then credits. The full warning lives on Plan.
function StoreBanner() {
  const account = useAccountStore((s) => s.account)
  const session = useAccountStore((s) => s.session)
  const dismissNotice = useAccountStore((s) => s.dismissNotice)
  if (account?.type !== 'b2b_company') return null
  const { client, plan } = account
  const lowPct = session?.settings.lowCreditPct ?? 20
  const graceDays = session?.settings.graceDays ?? 7
  const now = Date.now()

  let tone: 'warn' | 'error' = 'warn'
  let text: string | null = null
  let onClose: (() => void) | null = null

  const notice = session?.notice
  const renewal = client.renewalAt ? Date.parse(client.renewalAt) : null
  const trialEnd = client.trialEndsAt ? Date.parse(client.trialEndsAt) : null
  const included = plan?.creditsIncluded ?? 0
  const credits = usableCredits(client)

  if (notice && (notice.body || notice.subject)) {
    text = notice.body || notice.subject
    onClose = () => { dismissNotice(); dismissStoreNotice(notice.id) }
  } else if (client.status === 'trial' && trialEnd && trialEnd < now) {
    tone = 'error'; text = 'Your free trial has ended — choose a plan in Plan & Credits.'
  } else if (renewal && renewal < now) {
    const pauseAt = renewal + graceDays * DAY_MS
    tone = 'error'
    text = pauseAt > now
      ? `Your plan renewal is overdue — iPads pause on ${fmtDay(pauseAt)} unless you renew in Plan & Credits.`
      : 'Your plan has expired — renew it in Plan & Credits.'
  } else if (credits <= 0) {
    tone = 'error'; text = 'Credits used up — new try-ons are paused. Renew, upgrade or buy top-up credits in Plan & Credits.'
  } else if (included > 0 && (credits / included) * 100 <= lowPct) {
    text = `${Math.round((credits / included) * 100)}% of your credits left — upgrade or buy top-up credits in Plan & Credits.`
  }
  if (!text) return null

  return (
    <View style={[b.wrap, tone === 'error' ? b.error : b.warn]}>
      <TouchableOpacity style={{ flex: 1 }} onPress={() => router.navigate('/store/plan')} accessibilityRole="button">
        <Text style={[b.text, { color: tone === 'error' ? Colors.error : Colors.warning }]}>{text}</Text>
      </TouchableOpacity>
      {onClose && (
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} accessibilityLabel="Dismiss message">
          <Icon name="close" size={18} color={Colors.textMuted} />
        </TouchableOpacity>
      )}
    </View>
  )
}

function FullScreenMessage({ title, body, action }: {
  title: string
  body: string
  action?: { label: string; onPress: () => void }
}) {
  return (
    <SafeAreaView style={x.safe}>
      <View style={x.card}>
        <Text style={x.title}>{title}</Text>
        <Text style={x.body}>{body}</Text>
        {action && (
          <TouchableOpacity style={x.primary} onPress={action.onPress}>
            <Text style={x.primaryText}>{action.label}</Text>
          </TouchableOpacity>
        )}
        {!!SUPPORT_EMAIL && (
          <TouchableOpacity style={x.secondary} onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)}>
            <Text style={x.secondaryText}>Contact Atelier support</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={x.link}
          onPress={async () => { await signOutStore(); router.replace('/auth') }}
        >
          <Text style={x.linkText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

export default function StoreLayout() {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const account = useAccountStore((s) => s.account)
  const session = useAccountStore((s) => s.session)
  const userId = useAccountStore((s) => s.userId)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(userId ? 'ready' : 'loading')
  const [attempt, setAttempt] = useState(0)
  const pathname = usePathname()
  // A suspended store may still open Plan & Credits to pay and reactivate (the
  // server decides whether it may: only expiry-suspended stores can buy).
  const [lockedPlanOpen, setLockedPlanOpen] = useState(false)
  const onPlanRoute = pathname === '/store/plan' // e.g. web checkout returning with ?order_id=

  // Web reloads / deep links land here without going through sign-in.
  useEffect(() => {
    if (useAccountStore.getState().userId) { setStatus('ready'); return }
    setStatus('loading')
    useAccountStore.getState().load()
      .then(() => setStatus('ready'))
      .catch((e) => { console.error('[Atelier] store account load failed:', e); setStatus('error') })
  }, [attempt])

  // Heartbeat while a real store is signed in (the demo company has no device row).
  const storeStatus = useHeartbeat((s) => s.storeStatus)
  const heartbeatStore = account?.type === 'b2b_company' ? account.client.id : null
  useEffect(() => {
    if (!heartbeatStore) return
    startHeartbeat(heartbeatStore)
    return () => stopHeartbeat()
  }, [heartbeatStore])

  // A payment just reactivated the store: re-check the heartbeat's status now
  // rather than staying locked until the next 30 s tick.
  const accountStatus = account?.type === 'b2b_company' ? account.client.status : null
  useEffect(() => {
    if (accountStatus === 'active' && storeStatus === 'suspended') beatNow()
  }, [accountStatus, storeStatus])

  if (status === 'loading') {
    return <View style={x.center}><ActivityIndicator color={Colors.primary} /></View>
  }
  if (status === 'error') {
    return (
      <FullScreenMessage
        title="Couldn't load your company"
        body="Check the iPad's internet connection and try again."
        action={{ label: 'Try again', onPress: () => setAttempt((n) => n + 1) }}
      />
    )
  }
  if (account?.type !== 'b2b_company') return <Redirect href="/auth" />

  if (account.client.status === 'revoked') {
    return (
      <FullScreenMessage
        title="Your account is paused"
        body={`${account.client.companyName}'s Atelier access is paused. Contact support to restore it.`}
      />
    )
  }

  // Suspended (by the heartbeat or the account row): offer Plan & Credits, where
  // a store whose plan or trial ran out can pay to reactivate. A store an admin
  // put on hold sees the reason there and can't buy.
  const suspended = account.client.status === 'suspended' || storeStatus === 'suspended'
  if (suspended && (lockedPlanOpen || onPlanRoute)) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.bg }}>
        <SafeAreaView edges={['top']} style={h.safe}>
          <View style={h.row}>
            <View style={{ flex: 1 }}>
              <Text style={h.sub}>QUASAR'S ATELIER · STORE</Text>
              <Text style={h.company} numberOfLines={1}>{account.client.companyName} · paused</Text>
            </View>
            <TouchableOpacity
              onPress={() => { setLockedPlanOpen(false); if (onPlanRoute) router.replace('/store') }}
              accessibilityRole="button"
            >
              <Text style={x.linkText}>Close</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
        <PlanScreen />
      </View>
    )
  }
  if (suspended) {
    return (
      <FullScreenMessage
        title="Your account is paused"
        body={`Atelier access for ${account.client.storeName || account.client.companyName} is paused — usually because the plan or free trial has ended. Renew in Plan & Credits, or contact support.`}
        action={{ label: 'Open Plan & Credits', onPress: () => setLockedPlanOpen(true) }}
      />
    )
  }

  // The heartbeat (device_heartbeat) reports the store's status; anything but 'active' locks the app.
  // 'pending' = the store row has no activated_at yet (not activated by Atelier).
  if (storeStatus === 'pending') {
    return (
      <FullScreenMessage
        title="Your store isn’t activated yet"
        body={`${account.client.storeName || account.client.companyName} hasn’t been activated on Atelier yet. Contact Atelier support to finish setting it up.`}
      />
    )
  }
  if (storeStatus && storeStatus !== 'active') {
    return (
      <FullScreenMessage
        title="Your store is paused"
        body={`Atelier access for ${account.client.storeName || account.client.companyName} is paused (${storeStatus}). Contact support to restore it.`}
      />
    )
  }

  if (session?.device?.status === 'blocked') {
    return (
      <FullScreenMessage
        title="This iPad is blocked"
        body={`Your Atelier admin has blocked this device for ${account.client.companyName}. Contact them if this is a mistake.`}
      />
    )
  }

  const wide = width >= WIDE_BREAKPOINT

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StoreHeader />
      <StoreBanner />
      <View style={{ flex: 1 }}>
        <Tabs screenOptions={{ ...bottomTabOptions(wide, insets.bottom), tabBarLabelStyle: { ...Typography.label, fontSize: wide ? 11 : 9, marginTop: 4, color: undefined } }}>
          <Tabs.Screen name="index"     options={{ title: 'Home',            tabBarIcon: ({ focused }) => <RailIcon icon="tryOn"   focused={focused} /> }} />
          <Tabs.Screen name="customers" options={{ title: 'Customers',       tabBarIcon: ({ focused }) => <RailIcon icon="profile" focused={focused} /> }} />
          <Tabs.Screen name="plan"      options={{ title: 'Plan & Credits',  tabBarLabel: wide ? 'Plan & Credits' : 'Plan', tabBarIcon: ({ focused }) => <RailIcon icon="premium" focused={focused} /> }} />
          <Tabs.Screen name="company"   options={{ title: 'Company Profile', tabBarLabel: wide ? 'Company Profile' : 'Company', tabBarIcon: ({ focused }) => <RailIcon icon="company" focused={focused} /> }} />
          {/* Pushed screens — reachable, but not in the rail */}
          <Tabs.Screen name="new-customer"  options={{ href: null }} />
          <Tabs.Screen name="customer/[id]" options={{ href: null }} />
        </Tabs>
      </View>
    </View>
  )
}

const h = StyleSheet.create({
  safe: { backgroundColor: Colors.bg, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  row:  { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md },
  sub:  { ...Typography.label, color: Colors.primary, letterSpacing: 3, fontSize: 9 },
  company: { ...Typography.h3 },
  credits: {
    flexDirection: 'row', alignItems: 'center', gap: Space.xs,
    backgroundColor: Colors.primarySubtle, borderRadius: Radius.full,
    paddingHorizontal: Space.md, paddingVertical: Space.sm,
  },
  creditsEmpty: { backgroundColor: Colors.errorBg },
  creditsText: { ...Typography.bodySmall, fontWeight: '600', color: Colors.secondary },
})

const b = StyleSheet.create({
  wrap:  { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.sm },
  warn:  { backgroundColor: Colors.warningBg },
  error: { backgroundColor: Colors.errorBg },
  text:  { ...Typography.bodySmall, fontWeight: '600' },
})

const x = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  safe:   { flex: 1, backgroundColor: Colors.bg, alignItems: 'center', justifyContent: 'center', padding: Space.lg },
  card:   {
    width: '100%', maxWidth: 440, backgroundColor: Colors.bgCard, borderRadius: Radius.xl,
    padding: Space.xl, gap: Space.md, alignItems: 'center',
  },
  title:  { ...Typography.h2, textAlign: 'center' },
  body:   { ...Typography.body, color: Colors.textMuted, textAlign: 'center' },
  primary: { alignSelf: 'stretch', backgroundColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 14, alignItems: 'center', marginTop: Space.sm },
  primaryText: { ...Typography.body, fontWeight: '600', color: Colors.textOnDark },
  secondary: { alignSelf: 'stretch', borderWidth: 1.5, borderColor: Colors.secondary, borderRadius: Radius.full, paddingVertical: 12, alignItems: 'center' },
  secondaryText: { ...Typography.body, fontWeight: '600', color: Colors.secondary },
  link: { paddingVertical: Space.sm },
  linkText: { ...Typography.caption, color: Colors.textFaint },
})
