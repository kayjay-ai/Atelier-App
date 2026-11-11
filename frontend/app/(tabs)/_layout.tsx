import { useEffect, useState } from 'react'
import { Redirect, router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { View, StyleSheet, useWindowDimensions } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Colors, Space, Layout } from '../../lib/theme'
import { AppTabBar, CreditPill, Wordmark, tabScreenOptions, type TabItem } from '../../lib/ui'
import { useAccountStore } from '../../lib/account'
import { useMembershipStore, useProfileStore, isPremium, creditsLeft } from '../../lib/store'
import { supabase } from '../../lib/supabaseClient'

// ─── B2C consumer app shell (spec §3) ─────────────────────────────────────────
// Tabs: Home · Style · Premium · History · Profile. Phones and portrait iPads:
// the wordmark and credit counter on top, the tabs in the bottom bar. From
// Layout.desktop the tabs join the wordmark in one top bar. The credit counter
// is on every tab and opens Premium.

const TABS: TabItem[] = [
  { name: 'index',   title: 'Home',    icon: 'tryOn' },
  { name: 'style',   title: 'Style',   icon: 'style' },
  { name: 'premium', title: 'Premium', icon: 'premium' },
  { name: 'history', title: 'History', icon: 'history' },
  { name: 'profile', title: 'Profile', icon: 'profile' },
]

function CreditCounter({ signedIn }: { signedIn: boolean }) {
  const membership = useMembershipStore((s) => s.membership)
  const premium = isPremium(membership)
  const balance = creditsLeft(membership) // null until loaded

  if (!signedIn) return <CreditPill label="Sign in" onPress={() => router.push('/auth')} />
  const empty = !premium && balance !== null && balance <= 0
  return (
    <CreditPill
      empty={empty}
      onPress={() => router.navigate('/(tabs)/premium')}
      label={premium ? 'Unlimited' : balance === null ? 'Credits' : `${balance} credit${balance === 1 ? '' : 's'}`}
      accessibilityLabel={premium ? 'Unlimited credits. Open Premium.' : balance === null ? 'Credits. Open Premium.' : `${balance} credits left. Open Premium.`}
    />
  )
}

function B2CHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <SafeAreaView edges={['top']} style={h.safe}>
      <View style={h.row}>
        <View style={{ flex: 1 }}><Wordmark size="sm" align="left" /></View>
        <CreditCounter signedIn={signedIn} />
      </View>
    </SafeAreaView>
  )
}

export default function TabLayout() {
  const { width } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const account = useAccountStore((s) => s.account)
  // undefined = still checking the session; null = signed out (sent to sign-in).
  const [userId, setUserId] = useState<string | null | undefined>(undefined)

  // Deep links / web reloads can land here without passing through sign-in:
  // resolve the account type (a company login goes to the store app) and load
  // the profile + credits once, so every tab and the counter are populated.
  useEffect(() => {
    if (!useAccountStore.getState().userId) {
      useAccountStore.getState().load().catch((e) => console.warn('[Atelier] account check failed:', e))
    }
    const sync = (id: string | null) => {
      setUserId(id)
      if (!id) return
      useProfileStore.getState().hydrate(id).catch(() => {})
      useMembershipStore.getState().refresh()
    }
    supabase.auth.getSession().then(({ data }) => sync(data.session?.user?.id ?? null))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      sync(session?.user?.id ?? null)
      // Signing out (Profile, or the session ending elsewhere) goes back to sign-in.
      if (event === 'SIGNED_OUT') router.replace('/auth')
    })
    return () => subscription.unsubscribe()
  }, [])

  if (account?.type === 'b2b_company') return <Redirect href="/store" />
  // The app needs an account — no guest mode (links / reloads while signed out land on sign-in).
  if (userId === null) return <Redirect href="/auth" />
  if (userId === undefined) return <View style={{ flex: 1, backgroundColor: Colors.bg }} />

  const desktop = width >= Layout.desktop

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      {!desktop && <B2CHeader signedIn={!!userId} />}
      <View style={{ flex: 1 }}>
        <Tabs
          screenOptions={tabScreenOptions(desktop)}
          tabBar={(props) => (
            <AppTabBar
              {...props} items={TABS} desktop={desktop} insetBottom={insets.bottom}
              brand={<Wordmark size="sm" align="left" />}
              right={<CreditCounter signedIn={!!userId} />}
            />
          )}
        >
          {TABS.map((t) => <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title }} />)}
        </Tabs>
      </View>
    </View>
  )
}

const h = StyleSheet.create({
  safe: { backgroundColor: Colors.bg, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  row:  { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md },
})
