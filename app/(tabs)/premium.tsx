import { useState, useEffect, useCallback } from 'react'
import { View, Text, StyleSheet, SafeAreaView, ScrollView } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useMembershipStore, useCreditsStore } from '../../lib/store'
import { PurchaseOptions } from '../../lib/purchaseOptions'
import { FREE_CREDITS } from '../../lib/pricing'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon } from '../../lib/ui'

export default function PremiumScreen() {
  const { membership, refresh } = useMembershipStore()
  const credits = useCreditsStore()
  const [session, setSession] = useState<any>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  useFocusEffect(
    useCallback(() => {
      if (session?.user?.id) refresh().then((m) => credits.syncFromMembership(m))
    }, [session?.user?.id]), // eslint-disable-line react-hooks/exhaustive-deps
  )

  if (!session) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.centered}>
          <Icon name="star" size={44} color={Colors.primary} />
          <Text style={s.title}>Atelier Credits</Text>
          <Text style={s.subtle}>Sign in on the Profile tab to buy credits.</Text>
        </View>
      </SafeAreaView>
    )
  }

  const balance = credits.remaining()
  const isFreeUser = !membership?.plan

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll}>

        <View style={s.hero}>
          <Icon name="star" size={44} color={Colors.primary} />
          <Text style={s.title}>Atelier Credits</Text>
          <Text style={s.subtle}>1 credit = 1 generation (Try It On, Size, or Style verdict).</Text>
        </View>

        <View style={s.balanceCard}>
          <Text style={s.balanceBig}>{balance}</Text>
          <Text style={s.balanceLabel}>credit{balance === 1 ? '' : 's'} remaining</Text>
          {isFreeUser && (
            <Text style={s.balanceHint}>New accounts start with {FREE_CREDITS} free credits.</Text>
          )}
        </View>

        <Text style={s.sectionHeading}>Top up</Text>
        <PurchaseOptions onPurchased={() => refresh().then((m) => credits.syncFromMembership(m))} />

        <View style={{ height: Space.lg }} />
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: Colors.bg },
  scroll:  { padding: Space.lg, paddingBottom: Space.xxl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.lg, gap: Space.sm },

  hero: { alignItems: 'center', gap: Space.sm, marginBottom: Space.lg },
  title:  { ...Typography.h1, textAlign: 'center' },
  subtle: { ...Typography.bodySmall, color: Colors.textMuted, textAlign: 'center', lineHeight: 21 },

  balanceCard: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Space.lg, alignItems: 'center', marginBottom: Space.lg,
  },
  balanceBig:   { ...Typography.display, fontSize: 40, color: Colors.primary },
  balanceLabel: { ...Typography.body, color: Colors.textMuted, marginTop: -4 },
  balanceHint:  { ...Typography.caption, color: Colors.textFaint, marginTop: Space.xs },

  sectionHeading: { ...Typography.label, color: Colors.textMuted, marginBottom: Space.md },
})
