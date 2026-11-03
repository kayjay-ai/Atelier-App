import { useState, useEffect, useCallback } from 'react'
import { View, Text, StyleSheet, SafeAreaView, ScrollView } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useMembershipStore, useCreditsStore } from '../../lib/store'
import { PurchaseOptions, usePricingOptions } from '../../lib/purchaseOptions'
import { FREE_CREDITS, inr } from '../../lib/pricing'
import { Colors, Typography, Space, Radius } from '../../lib/theme'
import { Icon, PillButton } from '../../lib/ui'

// Premium tab (spec §3.5): credits left (free starter credits shown as such),
// the 3 plans side by side, current plan, and purchase history. Plans are
// one-time credit packs — nothing renews, so there is nothing to cancel.

interface Purchase { id: string; type: string; amount_inr: number; credits_granted: number; paid_at: string | null; created_at: string }

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export default function PremiumScreen() {
  const router = useRouter()
  const { membership, refresh } = useMembershipStore()
  const balance = useCreditsStore((st) => st.balance)
  const syncFromMembership = useCreditsStore((st) => st.syncFromMembership)
  const options = usePricingOptions()
  const [userId, setUserId] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [purchases, setPurchases] = useState<Purchase[]>([])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setUserId(data.session?.user?.id ?? null); setChecked(true) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setUserId(s?.user?.id ?? null))
    return () => subscription.unsubscribe()
  }, [])

  const load = useCallback(async () => {
    if (!userId) return
    refresh().then((m) => syncFromMembership(m))
    const { data } = await supabase
      .from('purchases')
      .select('id, type, amount_inr, credits_granted, paid_at, created_at')
      .eq('user_id', userId).eq('status', 'paid')
      .order('created_at', { ascending: false }).limit(10)
    setPurchases((data ?? []) as Purchase[])
  }, [userId]) // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(useCallback(() => { load() }, [load]))

  if (checked && !userId) {
    return (
      <SafeAreaView style={s.safe}>
        <View style={s.centered}>
          <Icon name="premium" size={44} color={Colors.primary} />
          <Text style={s.title}>Atelier Premium</Text>
          <Text style={s.subtle}>Sign in to get your {FREE_CREDITS} free try-ons and buy more.</Text>
          <PillButton label="Sign in" onPress={() => router.push('/auth')} style={{ alignSelf: 'stretch', marginTop: Space.md }} />
        </View>
      </SafeAreaView>
    )
  }

  const premium = !!membership?.isPremium || membership?.plan === 'premium'
  const onFreeCredits = !premium && !membership?.plan
  const planName = (type: string) => options.find((o) => o.type === type)?.label ?? type
  const last = purchases[0]

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.column}>
          <View style={s.balanceCard}>
            <Text style={s.label}>CREDITS LEFT</Text>
            <Text style={s.balanceBig}>{premium ? '∞' : balance}</Text>
            <Text style={s.subtle}>
              {premium
                ? 'Premium — unlimited try-ons.'
                : onFreeCredits
                  ? `Free starter credits · ${balance} of ${FREE_CREDITS} left`
                  : `${balance} credit${balance === 1 ? '' : 's'} · 1 credit = 1 try-on`}
            </Text>
            {onFreeCredits && <Text style={s.hint}>Every new account starts with {FREE_CREDITS} free try-ons. Size advice and style tips are free.</Text>}
          </View>

          {!premium && (
            <>
              <Text style={s.sectionHeading}>CHOOSE A PLAN</Text>
              <PurchaseOptions onPurchased={() => load()} />
            </>
          )}

          <Text style={s.sectionHeading}>YOUR PLAN</Text>
          <View style={s.card}>
            {premium ? (
              <Text style={s.body}>Atelier Premium — unlimited try-ons and clean downloads.</Text>
            ) : last ? (
              <>
                <Text style={s.body}>{planName(last.type)} · {last.credits_granted} credits</Text>
                <Text style={s.subtle}>Bought {fmtDate(last.paid_at ?? last.created_at)}. Plans are one-time packs — nothing renews and nothing to cancel; buy again whenever you need more.</Text>
              </>
            ) : (
              <Text style={s.subtle}>You're on free starter credits. Pick a plan above when you need more.</Text>
            )}
          </View>

          {purchases.length > 0 && (
            <>
              <Text style={s.sectionHeading}>PURCHASE HISTORY</Text>
              <View style={s.card}>
                {purchases.map((p, i) => (
                  <View key={p.id} style={[s.historyRow, i > 0 && s.historyBorder]}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.body}>{planName(p.type)}</Text>
                      <Text style={s.subtle}>{fmtDate(p.paid_at ?? p.created_at)} · +{p.credits_granted} credits</Text>
                    </View>
                    <Text style={s.amount}>{inr(Number(p.amount_inr))}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Colors.bg },
  scroll:   { padding: Space.base, paddingBottom: Space.xxl },
  column:   { width: '100%', maxWidth: 820, alignSelf: 'center', gap: Space.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Space.lg, gap: Space.sm, maxWidth: 420, alignSelf: 'center', width: '100%' },

  title:  { ...Typography.h1, textAlign: 'center' },
  subtle: { ...Typography.bodySmall, color: Colors.textMuted, lineHeight: 20 },
  hint:   { ...Typography.caption, color: Colors.textFaint, textAlign: 'center' },
  label:  { ...Typography.label, color: Colors.textFaint },
  body:   { ...Typography.body, color: Colors.text },
  amount: { ...Typography.body, fontWeight: '600', color: Colors.text },

  balanceCard: {
    backgroundColor: Colors.bgCard, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border,
    padding: Space.lg, alignItems: 'center', gap: Space.xs,
  },
  balanceBig: { ...Typography.display, fontSize: 44, lineHeight: 52, color: Colors.secondary },

  sectionHeading: { ...Typography.label, color: Colors.textMuted, marginTop: Space.sm },
  card: { backgroundColor: Colors.bgCard, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, padding: Space.base, gap: Space.xs },
  historyRow:    { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.sm },
  historyBorder: { borderTopWidth: 1, borderTopColor: Colors.borderSubtle },
})
