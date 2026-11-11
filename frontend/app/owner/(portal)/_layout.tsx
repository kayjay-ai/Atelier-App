import { useEffect, type ComponentProps } from 'react'
import { View, Text, TouchableOpacity, Image, StyleSheet, ActivityIndicator, AppState, useWindowDimensions } from 'react-native'
import { Redirect, usePathname, router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { supabase } from '../../../lib/supabaseClient'
import { badgeText, signOutOwner, useOwnerStore } from '../../../lib/owner'
import { Colors, Typography, Space, Radius } from '../../../lib/theme'
import { Icon, type IconName } from '../../../lib/ui'
import { Banner, DialogHost, ToastHost, WIDE } from '../../../components/owner/kit'

// ─── Owner portal shell (/owner/home, /add-store, /notifications, /profile) ───
// Desktop: left sidebar with the four tabs, the organization at the top and the
// owner + Log out at the bottom. Mobile: bottom tab bar (Log out is in Profile).
// The Notifications badge (unread, "9+" above nine) updates every 60 seconds.
// No owner session → /owner/login, then back to the page that was asked for.

type BottomTabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0]

const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: 'home', title: 'Home', icon: 'home' },
  { name: 'add-store', title: 'Add Store', icon: 'storePlus' },
  { name: 'notifications', title: 'Notifications', icon: 'bell' },
  { name: 'profile', title: 'Profile', icon: 'profile' },
]

function Badge({ n, inline }: { n: number; inline?: boolean }) {
  if (n <= 0) return null
  return (
    <View style={[n > 9 ? b.wide : b.dot, inline ? b.inline : b.floating]} accessibilityLabel={`${n} unread`}>
      <Text style={b.text}>{badgeText(n)}</Text>
    </View>
  )
}

const initials = (name: string, email: string) =>
  (name.trim() ? name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('') : email[0] ?? '?').toUpperCase()

function Sidebar({ state, navigation }: BottomTabBarProps) {
  const me = useOwnerStore((s) => s.me)
  const unread = useOwnerStore((s) => s.unread)
  if (!me) return null
  return (
    <SafeAreaView edges={['top', 'bottom', 'left']} style={n.side}>
      <View style={n.org}>
        {me.organization.logoUrl
          ? <Image source={{ uri: me.organization.logoUrl }} style={n.logo} resizeMode="contain" accessibilityIgnoresInvertColors />
          : <View style={[n.logo, n.logoEmpty]}><Text style={n.logoText}>{initials(me.organization.name, '')}</Text></View>}
        <View style={{ flex: 1 }}>
          <Text style={n.orgSub}>QUASAR'S ATELIER · OWNER</Text>
          <Text style={n.orgName} numberOfLines={2}>{me.organization.name}</Text>
        </View>
      </View>
      <View style={{ gap: 2, flex: 1 }}>
        {state.routes.map((route, i) => {
          const tab = TABS.find((t) => t.name === route.name)
          if (!tab) return null
          const on = state.index === i
          return (
            <TouchableOpacity
              key={route.key} style={[n.item, on && n.itemOn]} onPress={() => navigation.navigate(route.name)}
              accessibilityRole="tab" accessibilityState={{ selected: on }}
            >
              <Icon name={tab.icon} size={20} color={on ? Colors.textOnDark : Colors.secondary} />
              <Text style={[n.itemText, on && { color: Colors.textOnDark }]}>{tab.title}</Text>
              {tab.name === 'notifications' && <Badge n={unread} inline />}
            </TouchableOpacity>
          )
        })}
      </View>
      <View style={n.me}>
        <View style={n.avatar}><Text style={n.avatarText}>{initials(me.owner.name, me.owner.email)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={n.meName} numberOfLines={1}>{me.owner.name || 'Owner'}</Text>
          <Text style={n.meEmail} numberOfLines={1}>{me.owner.email}</Text>
        </View>
      </View>
      <TouchableOpacity
        style={n.logout} accessibilityRole="button"
        onPress={async () => { await signOutOwner(); router.replace('/owner/login') }}
      >
        <Icon name="logout" size={18} color={Colors.textMuted} />
        <Text style={n.logoutText}>Log out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  )
}

function BottomBar({ state, navigation }: BottomTabBarProps) {
  const unread = useOwnerStore((s) => s.unread)
  const insets = useSafeAreaInsets()
  return (
    <View style={[n.bottom, { paddingBottom: 8 + insets.bottom }]}>
      {state.routes.map((route, i) => {
        const tab = TABS.find((t) => t.name === route.name)
        if (!tab) return null
        const on = state.index === i
        return (
          <TouchableOpacity
            key={route.key} style={n.bottomItem} onPress={() => navigation.navigate(route.name)}
            accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tab.title}
          >
            <View style={[n.bottomIcon, on && n.bottomIconOn]}>
              <Icon name={tab.icon} size={20} color={on ? Colors.textOnDark : Colors.primary} />
              {tab.name === 'notifications' && <Badge n={unread} />}
            </View>
            <Text style={[n.bottomText, on && { color: Colors.secondary }]} numberOfLines={1}>{tab.title}</Text>
          </TouchableOpacity>
        )
      })}
    </View>
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
    return <View style={n.center}><ActivityIndicator color={Colors.primary} /></View>
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
      <ToastHost />
      <DialogHost />
    </View>
  )
}

const b = StyleSheet.create({
  dot: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4 },
  wide: { minWidth: 24, height: 18, borderRadius: 9, paddingHorizontal: 5 },
  floating: { position: 'absolute', top: -4, right: -8, backgroundColor: Colors.error, alignItems: 'center', justifyContent: 'center' },
  inline: { marginLeft: 'auto', backgroundColor: Colors.error, alignItems: 'center', justifyContent: 'center' },
  text: { color: '#fff', fontSize: 10, fontWeight: '700', lineHeight: 14 },
})

const n = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.bg },
  side: {
    width: 260, backgroundColor: Colors.bgCard, borderRightWidth: 1, borderRightColor: Colors.borderSubtle,
    paddingHorizontal: Space.base, paddingVertical: Space.lg,
  },
  org: { flexDirection: 'row', alignItems: 'center', gap: Space.md, marginBottom: Space.xl, paddingHorizontal: Space.xs },
  logo: { width: 44, height: 44, borderRadius: Radius.md },
  logoEmpty: { backgroundColor: Colors.secondary, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: Colors.textOnDark, fontWeight: '700', fontSize: 16 },
  orgSub: { ...Typography.label, fontSize: 8, color: Colors.primary, letterSpacing: 2 },
  orgName: { ...Typography.h3, fontSize: 16, lineHeight: 22 },
  item: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.md, paddingVertical: 12, borderRadius: Radius.md },
  itemOn: { backgroundColor: Colors.secondary },
  itemText: { ...Typography.body, fontWeight: '500', color: Colors.secondary },
  me: { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingTop: Space.base, borderTopWidth: 1, borderTopColor: Colors.borderSubtle },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.primarySubtle, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...Typography.bodySmall, fontWeight: '700', color: Colors.secondary },
  meName: { ...Typography.bodySmall, fontWeight: '600' },
  meEmail: { ...Typography.caption, color: Colors.textFaint },
  logout: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingVertical: Space.md, paddingHorizontal: Space.xs, marginTop: Space.xs },
  logoutText: { ...Typography.bodySmall, color: Colors.textMuted, fontWeight: '600' },

  bottom: {
    flexDirection: 'row', backgroundColor: Colors.bgCard, paddingTop: 8,
    shadowColor: '#423D3A', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 20, elevation: 20,
  },
  bottomItem: { flex: 1, alignItems: 'center', gap: 4 },
  bottomIcon: { width: 52, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  bottomIconOn: { backgroundColor: Colors.secondary },
  bottomText: { ...Typography.label, fontSize: 9, letterSpacing: 1, color: Colors.primary },
})
