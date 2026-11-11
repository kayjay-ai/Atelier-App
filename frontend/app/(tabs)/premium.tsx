import { useState, useEffect, useCallback } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { supabase } from '../../lib/supabaseClient'
import { useMembershipStore, isPremium, creditsLeft } from '../../lib/store'
import { PurchaseOptions, usePricingOptions } from '../../lib/purchaseOptions'
import { FREE_CREDITS, inr } from '../../lib/pricing'
import { Colors, Typography, Space, Radius, Weight } from '../../lib/theme'
import { Card, EmptyState, Page, PageHeader, SectionHeader } from '../../lib/ui'

// Premium tab (spec §3.5): credits left (free starter credits shown as such),
// the 3 plans side by side, current plan, and purchase history. Plans are
// one-time credit packs — nothing renews, so there is nothing to cancel.

interface Purchase { id: string; type: string; amount_inr: number; credits_granted: number; paid_at: string | null; created_at: string }

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export default function PremiumScreen() {
  const router = useRouter()
  const { membership, refresh } = useMembershipStore()
  const balance = creditsLeft(membership) ?? '—' // '—' until loaded
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
    refresh()
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
      <Page width="reading">
        <EmptyState icon="premium" title="Atelier Premium" body={`Sign in to get your ${FREE_CREDITS} free try-ons and buy more.`}
          action={{ label: 'Sign in', onPress: () => router.push('/auth') }} />
      </Page>
    )
  }

  const premium = isPremium(membership)
  const onFreeCredits = !premium && !membership?.plan
  const planName = (type: string) => options.find((o) => o.type === type)?.label ?? type
  const last = purchases[0]

  return (
    <Page width="app">
      <PageHeader title="Premium" subtitle="Credits for try-ons. Plans are one-time packs: nothing renews, so there’s nothing to cancel." />

      <View style={s.balance}>
        <View style={{ flex: 1, minWidth: 200, gap: Space.xs }}>
          <Text style={s.balanceLabel}>CREDITS LEFT</Text>
          <Text style={s.balanceBig}>{premium ? '∞' : balance}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 220, gap: Space.xs }}>
          <Text style={s.balanceLine}>
            {premium
              ? 'Premium: unlimited try-ons and clean downloads.'
              : onFreeCredits
                ? `Free starter credits — ${balance} of ${FREE_CREDITS} left.`
                : 'Each try-on uses one credit. Credits never expire.'}
          </Text>
          {onFreeCredits && <Text style={s.balanceHint}>Every new account starts with {FREE_CREDITS} free try-ons. Size advice and style tips are always free.</Text>}
        </View>
      </View>

      {!premium && (
        <View style={{ gap: Space.base }}>
          <SectionHeader title="Choose a plan" />
          <PurchaseOptions onPurchased={() => load()} />
        </View>
      )}

      <View style={{ gap: Space.base }}>
        <SectionHeader title="Your plan" />
        <Card>
          {premium ? (
            <Text style={s.body}>Atelier Premium — unlimited try-ons and clean downloads.</Text>
          ) : last ? (
            <View style={{ gap: Space.xs }}>
              <Text style={s.bodyStrong}>{planName(last.type)} · {last.credits_granted} credits</Text>
              <Text style={s.subtle}>Bought {fmtDate(last.paid_at ?? last.created_at)}. Buy again whenever you need more.</Text>
            </View>
          ) : (
            <Text style={s.subtle}>You’re on free starter credits. Choose a plan above when you need more.</Text>
          )}
        </Card>
      </View>

      {purchases.length > 0 && (
        <View style={{ gap: Space.base }}>
          <SectionHeader title="Purchase history" />
          <Card padded={false}>
            {purchases.map((p, i) => (
              <View key={p.id} style={[s.historyRow, i > 0 && s.historyBorder]}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.bodyStrong}>{planName(p.type)}</Text>
                  <Text style={s.subtle}>{fmtDate(p.paid_at ?? p.created_at)} · +{p.credits_granted} credits</Text>
                </View>
                <Text style={s.amount}>{inr(Number(p.amount_inr))}</Text>
              </View>
            ))}
          </Card>
        </View>
      )}
    </Page>
  )
}

const s = StyleSheet.create({
  balance: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: Space.lg,
    backgroundColor: Colors.bgDark, borderRadius: Radius.xl, padding: Space.xl,
  },
  balanceLabel: { ...Typography.label, color: Colors.primaryLight },
  balanceBig:   { ...Typography.numeral, fontSize: 72, lineHeight: 76, color: Colors.textOnDark },
  balanceLine:  { ...Typography.body, fontSize: 16, color: Colors.textOnDark },
  balanceHint:  { ...Typography.bodySmall, color: Colors.textOnDarkMuted },

  subtle:     { ...Typography.bodySmall, color: Colors.textMuted },
  body:       { ...Typography.body },
  bodyStrong: { ...Typography.body, ...Weight.semibold },
  amount:     { ...Typography.body, ...Weight.semibold },
  historyRow:    { flexDirection: 'row', alignItems: 'center', gap: Space.md, paddingVertical: Space.base, paddingHorizontal: Space.lg },
  historyBorder: { borderTopWidth: 1, borderTopColor: Colors.borderSubtle },
})
