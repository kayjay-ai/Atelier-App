import { useEffect, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Redirect, router, usePathname } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { useAccountStore, usableCredits } from '../../lib/account'
import { dismissStoreNotice } from '../../lib/api'
import { SUPPORT_EMAIL } from '../../lib/b2b'
import { beatNow, signOutStore, startHeartbeat, stopHeartbeat, useHeartbeat } from '../../lib/heartbeat'
import { Colors, Typography, Space, Layout, Weight } from '../../lib/theme'
import {
  AppTabBar, CreditPill, Icon, Loading, PillButton, TextLink, Title, tabScreenOptions, useDesktopLayout, type IconName, type TabItem,
} from '../../lib/ui'
import PlanScreen from './plan'

// ─── B2B in-store app shell (/store) ──────────────────────────────────────────
// Only company logins reach this layout; anyone else is sent back to sign-in.
// Phones and every iPad: the store's name and credits on top, the tabs in the
// bottom bar. A computer's browser (useDesktopLayout): the tabs move into the
// top bar.

const TABS: TabItem[] = [
  { name: 'index',     title: 'Home',            icon: 'tryOn' },
  { name: 'customers', title: 'Customers',       icon: 'profile' },
  { name: 'plan',      title: 'Plan & Credits',  short: 'Plan',    icon: 'premium' },
  { name: 'company',   title: 'Company Profile', short: 'Company', icon: 'company' },
]

function StoreName() {
  const account = useAccountStore((s) => s.account)
  if (account?.type !== 'b2b_company') return null
  const { companyName, storeName } = account.client
  return (
    <View style={{ flexShrink: 1, minWidth: 0 }}>
      <Text style={h.sub} numberOfLines={1}>ATELIER  ·  STORE</Text>
      <Text style={h.company} numberOfLines={1}>
        {companyName}{storeName && storeName !== companyName ? <Text style={h.store}>{`  ${storeName}`}</Text> : null}
      </Text>
    </View>
  )
}

function StoreCredits() {
  const account = useAccountStore((s) => s.account)
  if (account?.type !== 'b2b_company') return null
  const credits = usableCredits(account.client)
  return (
    <CreditPill
      empty={credits <= 0}
      onPress={() => router.navigate('/store/plan')}
      label={`${credits.toLocaleString('en-IN')} credit${credits === 1 ? '' : 's'}`}
      accessibilityLabel={`${credits} credits left. Open Plan and Credits.`}
    />
  )
}

function StoreHeader() {
  return (
    <SafeAreaView edges={['top']} style={h.safe}>
      <View style={h.row}>
        <View style={{ flex: 1, minWidth: 0 }}><StoreName /></View>
        <StoreCredits />
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
  const pctLeft = included > 0 ? Math.round((credits / included) * 100) : 0
  const low = included > 0 && (credits / included) * 100 <= lowPct

  // A credit notice's saved text holds the count from when it was sent, so it
  // is written from the live balance instead, and dropped once it no longer applies.
  const creditNotice = notice?.template === 'low_credits' || notice?.template === 'out_of_credits'
  const staleNotice = notice?.template === 'low_credits' ? (credits <= 0 || !low)
    : notice?.template === 'out_of_credits' ? credits > 0
      : false

  if (notice && !staleNotice && (creditNotice || notice.body || notice.subject)) {
    text = notice.template === 'low_credits'
      ? `${pctLeft}% of your plan credits are left (${credits.toLocaleString('en-IN')}). Upgrade or top up your plan so your iPads keep working.`
      : notice.body || notice.subject
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
  } else if (low) {
    text = `${pctLeft}% of your credits left — upgrade or buy top-up credits in Plan & Credits.`
  }
  if (!text) return null

  return (
    <View style={[b.wrap, tone === 'error' ? b.error : b.warn]}>
      <View style={b.inner}>
        <Icon name="alert" size={18} color={tone === 'error' ? Colors.error : Colors.warning} />
        <TouchableOpacity style={{ flex: 1 }} onPress={() => router.navigate('/store/plan')} accessibilityRole="button" accessibilityHint="Opens Plan and Credits">
          <Text style={[b.text, { color: tone === 'error' ? Colors.error : Colors.warning }]}>{text}</Text>
        </TouchableOpacity>
        {onClose && (
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="Dismiss message">
            <Icon name="close" size={18} color={Colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  )
}

function FullScreenMessage({ title, body, icon = 'lock', action }: {
  title: string
  body: string
  icon?: IconName
  action?: { label: string; onPress: () => void }
}) {
  return (
    <SafeAreaView style={x.safe}>
      <View style={x.card}>
        <View style={x.icon}><Icon name={icon} size={26} color={Colors.primaryLight} /></View>
        <Title size="h2" tone="light" align="center">{title}</Title>
        <Text style={x.body}>{body}</Text>
        <View style={x.actions}>
          {action && <PillButton variant="gold" label={action.label} onPress={action.onPress} size="md" />}
          {!!SUPPORT_EMAIL && (
            <PillButton variant={action ? 'ghost' : 'gold'} label="Contact Atelier support" size="md"
              onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)} style={action ? x.ghost : undefined} />
          )}
        </View>
        <TextLink label="Sign out of this device" tone="light" onPress={async () => { await signOutStore(); router.replace('/auth') }} />
      </View>
    </SafeAreaView>
  )
}

export default function StoreLayout() {
  const insets = useSafeAreaInsets()
  // A hook: before the early returns below, so it runs on every render.
  const desktop = useDesktopLayout()
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
    return <Loading label="Opening your store…" />
  }
  if (status === 'error') {
    return (
      <FullScreenMessage
        title="Couldn’t load your store"
        icon="alert"
        body="Check this iPad’s internet connection, then try again."
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
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={h.sub}>QUASAR’S ATELIER  ·  STORE PAUSED</Text>
              <Text style={h.company} numberOfLines={1}>{account.client.companyName}</Text>
            </View>
            <PillButton label="Close" variant="outline" size="sm" icon="close"
              onPress={() => { setLockedPlanOpen(false); if (onPlanRoute) router.replace('/store') }} />
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


  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      {!desktop && <StoreHeader />}
      {!desktop && <StoreBanner />}
      <View style={{ flex: 1 }}>
        <Tabs
          screenOptions={tabScreenOptions(desktop)}
          tabBar={(props) => (
            <View>
              <AppTabBar {...props} items={TABS} desktop={desktop} insetBottom={insets.bottom}
                brand={<StoreName />} right={<StoreCredits />} />
              {desktop && <StoreBanner />}
            </View>
          )}
        >
          {TABS.map((t) => <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title }} />)}
          {/* Pushed screens — reachable, but not in the tab bar */}
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
  sub:  { ...Typography.label, fontSize: 9, letterSpacing: 2.5, color: Colors.accentInk },
  company: { ...Typography.h2, fontSize: 22, lineHeight: 28 },
  store: { ...Typography.body, ...Weight.medium, color: Colors.textMuted },
})

const b = StyleSheet.create({
  wrap:  { paddingVertical: Space.sm + 2, borderBottomWidth: 1 },
  inner: { flexDirection: 'row', alignItems: 'center', gap: Space.md, width: '100%', maxWidth: Layout.wide + 64, alignSelf: 'center', paddingHorizontal: Space.lg },
  warn:  { backgroundColor: Colors.warningBg, borderBottomColor: '#F4E7B8' },
  error: { backgroundColor: Colors.errorBg, borderBottomColor: '#F6D3CD' },
  text:  { ...Typography.bodySmall, ...Weight.semibold },
})

const x = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: Colors.bgDark, alignItems: 'center', justifyContent: 'center', padding: Space.lg },
  card:   { width: '100%', maxWidth: 460, gap: Space.base, alignItems: 'center' },
  icon:   { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(250,248,245,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: Space.sm },
  body:   { ...Typography.body, color: Colors.textOnDarkMuted, textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: Space.sm, marginTop: Space.sm },
  ghost:  { backgroundColor: 'rgba(250,248,245,0.08)' },
})
