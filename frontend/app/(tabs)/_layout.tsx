import { useEffect, useState } from 'react'
import { Redirect, router } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { View, Text, TouchableOpacity, StyleSheet, useWindowDimensions } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, IconName, bottomTabOptions } from '../../lib/ui'
import { useAccountStore } from '../../lib/account'
import { useCreditsStore, useMembershipStore, useProfileStore } from '../../lib/store'
import { supabase } from '../../lib/supabaseClient'

// ─── B2C consumer app shell (spec §3) ─────────────────────────────────────────
// Tabs: Home · Style · Premium · History · Profile in a bottom bar on every
// device (labels a little larger on iPad). The credit counter sits in the top
// bar on every tab and opens Premium.

const WIDE_BREAKPOINT = 768

function TabIcon({ icon, active }: { icon: IconName; active: boolean }) {
  if (active) {
    return (
      <View style={t.activePill}>
        <Icon name={icon} size={18} color={Colors.textOnDark} />
      </View>
    )
  }
  return <Icon name={icon} size={22} color={Colors.primary} />
}

function CreditCounter({ signedIn }: { signedIn: boolean }) {
  const balance = useCreditsStore((s) => s.balance)
  const membership = useMembershipStore((s) => s.membership)
  const premium = !!membership?.isPremium || membership?.plan === 'premium'

  if (!signedIn) {
    return (
      <TouchableOpacity style={h.pill} onPress={() => router.push('/auth')} accessibilityRole="button">
        <Icon name="profile" size={14} color={Colors.secondary} />
        <Text style={h.pillText}>Sign in</Text>
      </TouchableOpacity>
    )
  }
  const empty = !premium && balance <= 0
  return (
    <TouchableOpacity
      style={[h.pill, empty && h.pillEmpty]}
      onPress={() => router.navigate('/(tabs)/premium')}
      accessibilityRole="button"
      accessibilityLabel={premium ? 'Unlimited credits. Open Premium.' : `${balance} credits left. Open Premium.`}
    >
      <Icon name="star" size={14} color={empty ? Colors.error : Colors.secondary} />
      <Text style={[h.pillText, empty && { color: Colors.error }]}>
        {premium ? 'Unlimited' : `${balance} credit${balance === 1 ? '' : 's'}`}
      </Text>
    </TouchableOpacity>
  )
}

function B2CHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <SafeAreaView edges={['top']} style={h.safe}>
      <View style={h.row}>
        <View style={{ flex: 1 }}>
          <Text style={h.sub}>QUASAR'S</Text>
          <Text style={h.mark}>ATELIER</Text>
        </View>
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
      useMembershipStore.getState().refresh().then((m) => useCreditsStore.getState().syncFromMembership(m))
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

  const wide = width >= WIDE_BREAKPOINT
  const icon = (name: IconName) => ({ focused }: { focused: boolean }) => <TabIcon icon={name} active={focused} />

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <B2CHeader signedIn={!!userId} />
      <View style={{ flex: 1 }}>
        <Tabs screenOptions={{ ...bottomTabOptions(wide, insets.bottom), tabBarLabelStyle: { ...Typography.label, fontSize: wide ? 11 : 9, letterSpacing: wide ? 1 : 1.5, marginTop: 4, color: undefined } }}>
          <Tabs.Screen name="index"   options={{ title: 'Home',    tabBarIcon: icon('tryOn') }} />
          <Tabs.Screen name="style"   options={{ title: 'Style',   tabBarIcon: icon('style') }} />
          <Tabs.Screen name="premium" options={{ title: 'Premium', tabBarIcon: icon('premium') }} />
          <Tabs.Screen name="history" options={{ title: 'History', tabBarIcon: icon('history') }} />
          <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: icon('profile') }} />
        </Tabs>
      </View>
    </View>
  )
}

const t = StyleSheet.create({
  // Exactly the tab bar's icon slot height (28) so it never runs into the label.
  activePill: {
    backgroundColor: Colors.secondary, borderRadius: 999, width: 52, height: 28,
    alignItems: 'center', justifyContent: 'center',
  },
})

const h = StyleSheet.create({
  safe: { backgroundColor: Colors.bg, borderBottomWidth: 1, borderBottomColor: Colors.borderSubtle },
  row:  { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingHorizontal: Space.lg, paddingVertical: Space.md },
  sub:  { ...Typography.label, color: Colors.primary, letterSpacing: 4, fontSize: 9 },
  mark: { ...Typography.h2, letterSpacing: 5, marginTop: -2 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: Space.xs,
    backgroundColor: Colors.primarySubtle, borderRadius: Radius.full,
    paddingHorizontal: Space.md, paddingVertical: Space.sm,
  },
  pillEmpty: { backgroundColor: Colors.errorBg },
  pillText:  { ...Typography.bodySmall, fontWeight: '600', color: Colors.secondary },
})
