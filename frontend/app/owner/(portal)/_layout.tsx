import { useEffect, type ComponentProps } from 'react'
import { View, Text, TouchableOpacity, Pressable, Image, StyleSheet, AppState, useWindowDimensions } from 'react-native'
import { Redirect, usePathname, router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { supabase } from '../../../lib/supabaseClient'
import { signOutOwner, useOwnerStore } from '../../../lib/owner'
import { Colors, Typography, Space, Radius, Weight } from '../../../lib/theme'
import { AppTabBar, Badge, Icon, Initials, Loading, Wordmark, type IconName } from '../../../lib/ui'
import { Banner, WIDE } from '../../../components/owner/kit'

// ─── Owner portal shell (/owner/home, /add-store, /notifications, /profile) ───
// Desktop: left sidebar with the four tabs, the organization at the top and the
// owner + Log out at the bottom. Mobile: bottom tab bar (Log out is in Profile).
// The Notifications badge (unread, "9+" above nine) updates every 60 seconds.
// No owner session → /owner/login, then back to the page that was asked for.

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const TABS: { name: string; title: string; short?: string; icon: IconName }[] = [
  { name: 'home', title: 'Home', icon: 'home' },
  { name: 'add-store', title: 'Add Store', short: 'Add Store', icon: 'storePlus' },
  { name: 'notifications', title: 'Notifications', short: 'Alerts', icon: 'bell' },
  { name: 'profile', title: 'Profile', icon: 'profile' },
]

const initials = (name: string, email: string) =>
  (name.trim() ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') : email[0] ?? '?').toUpperCase()

function Sidebar({ state, navigation }: BottomTabBarProps) {
  const me = useOwnerStore((s) => s.me)
  const unread = useOwnerStore((s) => s.unread)
  if (!me) return null
  return (
    <SafeAreaView edges={['top', 'bottom', 'left']} style={n.side}>
      <View style={n.brand}><Wordmark size="sm" align="left" suffix="Owner" /></View>
      <View style={n.org}>
        {me.organization.logoUrl
          ? <Image source={{ uri: me.organization.logoUrl }} style={n.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
          : <View style={[n.logo, n.logoEmpty]}><Initials name={me.organization.name} size={18} tone="light" /></View>}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={n.orgName} numberOfLines={2}>{me.organization.name}</Text>
          <Text style={n.orgSub}>Store code {me.organization.code}</Text>
        </View>
      </View>
      <View style={{ gap: 2, flex: 1 }} accessibilityRole="tablist">
        {state.routes.map((route, i) => {
          const tab = TABS.find((t) => t.name === route.name)
          if (!tab) return null
          const on = state.index === i
          return (
            <Pressable
              key={route.key} onPress={() => navigation.navigate(route.name)}
              style={(st: any) => [n.item, on ? n.itemOn : st.hovered && n.itemHover]}
              accessibilityRole="tab" accessibilityState={{ selected: on }}
            >
              <Icon name={tab.icon} size={20} color={on ? Colors.textOnDark : Colors.primaryDark} />
              <Text style={[n.itemText, on && { color: Colors.textOnDark }]}>{tab.title}</Text>
              {tab.name === 'notifications' && <Badge n={unread} inline />}
            </Pressable>
          )
        })}
      </View>
      <View style={n.me}>
        <View style={n.avatar}><Text style={n.avatarText}>{initials(me.owner.name, me.owner.email)}</Text></View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={n.meName} numberOfLines={1}>{me.owner.name || 'Owner'}</Text>
          <Text style={n.meEmail} numberOfLines={1}>{me.owner.email}</Text>
        </View>
        <TouchableOpacity
          style={n.logout} accessibilityRole="button" accessibilityLabel="Log out" hitSlop={8}
          onPress={async () => { await signOutOwner(); router.replace('/owner/login') }}
        >
          <Icon name="logout" size={18} color={Colors.textMuted} />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

function BottomBar(props: BottomTabBarProps) {
  const unread = useOwnerStore((s) => s.unread)
  const insets = useSafeAreaInsets()
  return (
    <AppTabBar
      state={props.state} navigation={props.navigation as any} desktop={false} insetBottom={insets.bottom}
      items={TABS.map((t) => ({ ...t, short: t.short }))} badges={{ notifications: unread }}
    />
  )
}

export default function OwnerPortalLayout() {
  const { width } = useWindowDimensions()
  const wide = width >= WIDE
  const pathname = usePathname()
  const status = useOwnerStore((s) => s.status)
  const error = useOwnerStore((s) => s.error)

  useEffect(() => {
    useOwnerStore.getState().load()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') useOwnerStore.getState().clear()
    })
    // The unread badge: every 60 seconds, and when the app comes back to the front.
    const timer = setInterval(() => useOwnerStore.getState().refreshUnread(), 60_000)
    const app = AppState.addEventListener('change', (st) => { if (st === 'active') useOwnerStore.getState().refreshUnread() })
    return () => { subscription.unsubscribe(); clearInterval(timer); app.remove() }
  }, [])

  if (status === 'signed_out') {
    return <Redirect href={{ pathname: '/owner/login', params: { next: pathname } }} />
  }
  if (status === 'idle' || status === 'loading') {
    return <Loading label="Opening your stores…" />
  }
  if (status === 'error') {
    return (
      <View style={[n.center, { padding: Space.lg }]}>
        <View style={{ width: '100%', maxWidth: 440 }}>
          <Banner tone="error" text={error ?? 'Couldn’t load your account.'} actionLabel="Retry" onAction={() => useOwnerStore.getState().load()} />
        </View>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <Tabs
        tabBar={(props) => (wide ? <Sidebar {...props} /> : <BottomBar {...props} />)}
        screenOptions={{ headerShown: false, tabBarPosition: wide ? 'left' : 'bottom' }}
      >
        {TABS.map((t) => <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title }} />)}
      </Tabs>
    </View>
  )
}

const n = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  side: {
    width: 272, backgroundColor: Colors.bgCard, borderRightWidth: 1, borderRightColor: Colors.borderSubtle,
    paddingHorizontal: Space.base, paddingVertical: Space.lg,
  },
  brand: { paddingHorizontal: Space.sm, marginBottom: Space.lg },
  org: {
    flexDirection: 'row', alignItems: 'center', gap: Space.md, marginBottom: Space.lg,
    padding: Space.md, borderRadius: Radius.lg, backgroundColor: Colors.bgSubtle,
  },
  logo: { width: 40, height: 40, borderRadius: Radius.md },
  logoEmpty: { backgroundColor: Colors.secondary, alignItems: 'center', justifyContent: 'center' },
  orgName: { ...Typography.bodySmall, ...Weight.semibold, fontSize: 14 },
  orgSub: { ...Typography.caption, fontSize: 11 },
  item: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.md, minHeight: 44, borderRadius: Radius.full },
  itemOn: { backgroundColor: Colors.secondary },
  itemHover: { backgroundColor: Colors.bgSubtle },
  itemText: { ...Typography.bodySmall, ...Weight.semibold, fontSize: 14, color: Colors.text },
  me: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingTop: Space.base, borderTopWidth: 1, borderTopColor: Colors.borderSubtle },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primarySubtle, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...Typography.caption, ...Weight.semibold, color: Colors.secondary },
  meName: { ...Typography.bodySmall, ...Weight.semibold },
  meEmail: { ...Typography.caption, fontSize: 11 },
  logout: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
})
